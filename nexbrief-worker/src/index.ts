import type { Article, Env } from "./types";
import { fetchAllFeeds } from "./feeds";
import { scrapeArticle, EXTRACTION_FAILED } from "./scrape";
import {
  summarize,
  extractSearchQuery,
  buildLinks,
  RateLimitError,
  sleep,
  RATE_LIMIT_PACING_MS,
  getLastRateLimitInfo,
} from "./groq";
import { loadArticles, saveArticles, existingUrlSet, saveMeta, loadSourceConfig } from "./store";
import {
  handleGetArticles,
  handleGetStatus,
  handlePostToggleSource,
  jsonResponse,
  corsPreflight,
  CORS_HEADERS,
} from "./api";
import { translateToEnglish } from "./translate";
import { AUTO_PAUSE_PENDING_THRESHOLD } from "./constants";

// Sources whose articles also get an English title/summary generated via
// Cloudflare Workers AI, for a "Translate to English" toggle in the UI.
const TRANSLATE_SOURCES = new Set(["bbcurdu"]);

const BACKLOG_LIMIT = 20; // matches AiSummaryService.BACKLOG_LIMIT

// Groq's rate limit (or Cloudflare's waitUntil time limit) means a run often
// can't get through every article it found — whatever hasn't been reached
// yet when that happens just doesn't get processed this run. Articles were
// previously ordered strictly source-by-source (all of espncricinfo, then
// all of bhaskar, ...), so a source late in that order could get starved
// indefinitely if earlier sources kept generating enough new articles to
// eat the whole budget first — observed directly with a freshly-added
// source (BBC Urdu, last in the list) never getting reached across several
// runs. Interleaving round-robin across sources means every source gets a
// turn early in each run, regardless of list position.
function interleaveBySource<T extends { source: string }>(items: T[]): T[] {
  const bySource = new Map<string, T[]>();
  for (const item of items) {
    const list = bySource.get(item.source);
    if (list) list.push(item);
    else bySource.set(item.source, [item]);
  }
  const groups = [...bySource.values()];
  const result: T[] = [];
  for (let i = 0; result.length < items.length; i++) {
    for (const group of groups) {
      if (i < group.length) result.push(group[i]);
    }
  }
  return result;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return corsPreflight();
    }

    if (url.pathname === "/api/articles" && request.method === "GET") {
      return handleGetArticles(request, env);
    }

    if (url.pathname === "/api/status" && request.method === "GET") {
      return handleGetStatus(env);
    }

    // Manual-trigger route so the pipeline can be exercised without waiting
    // for the hourly cron during development / first-time testing.
    if (url.pathname === "/api/refresh" && request.method === "POST") {
      const secret = request.headers.get("X-Refresh-Secret");
      if (!env.REFRESH_SECRET || secret !== env.REFRESH_SECRET) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }
      ctx.waitUntil(runPipeline(env));
      return jsonResponse({ status: "refresh started" });
    }

    // Lets a source be paused/resumed from the /status page (e.g. to stop a
    // source with a huge backlog from eating the shared Groq quota) without
    // a redeploy. Gated by the same admin secret as /api/refresh.
    if (url.pathname === "/api/sources/toggle" && request.method === "POST") {
      const secret = request.headers.get("X-Refresh-Secret");
      if (!env.REFRESH_SECRET || secret !== env.REFRESH_SECRET) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }
      return handlePostToggleSource(request, env);
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runPipeline(env));
  },
};

// Mirrors FetchScheduler.runPipeline(): Phase 0 completes any backlog left
// unsummarized by a previous rate-limited run, Phase 1 fetches new RSS
// entries, and Phase 2/3 scrape + summarize each new article in turn
// (combined into one pass here since there's no database to stage them in).
async function runPipeline(env: Env): Promise<void> {
  console.log("Pipeline started...");

  let articles = await loadArticles(env);
  const sourceConfig = await loadSourceConfig(env);
  const disabledSources = new Set(sourceConfig.disabledSources);
  if (disabledSources.size > 0) {
    console.log(`Pipeline: Skipping disabled sources this run: ${[...disabledSources].join(", ")}`);
  }

  console.log("Phase 0: Completing pending backlog summaries...");
  const backlogResult = await processBacklog(env, articles, disabledSources);
  articles = backlogResult.articles;
  if (backlogResult.rateLimited) {
    console.warn("Phase 0: Rate limit hit during backlog processing. Continuing to Phase 1 anyway so new articles still get discovered (they'll just stay pending until a later run).");
  } else {
    console.log("Phase 0: Backlog phase complete.");
  }

  // Auto-pause fetching (not backlog-clearing) for any non-disabled source
  // whose pending backlog is already over the threshold — computed after
  // Phase 0 so a source that just got cleared below the line resumes
  // fetching again this same run.
  const pendingCounts = new Map<string, number>();
  for (const a of articles) {
    if (a.summary == null) pendingCounts.set(a.source, (pendingCounts.get(a.source) ?? 0) + 1);
  }
  const autoPausedSources = new Set(
    [...pendingCounts.entries()]
      .filter(([source, count]) => count > AUTO_PAUSE_PENDING_THRESHOLD && !disabledSources.has(source))
      .map(([source]) => source),
  );
  if (autoPausedSources.size > 0) {
    console.log(
      `Pipeline: Auto-pausing fetch for sources over the ${AUTO_PAUSE_PENDING_THRESHOLD}-pending threshold: ${[...autoPausedSources].join(", ")}`,
    );
  }
  const fetchSkipSources = new Set([...disabledSources, ...autoPausedSources]);

  console.log("Phase 1: Fetching RSS...");
  const existingUrls = existingUrlSet(articles);
  const newRaw = interleaveBySource(await fetchAllFeeds(existingUrls, fetchSkipSources));
  console.log(`Phase 1: Completed. ${newRaw.length} new articles found.`);

  console.log("Phase 2 + 3: Extracting content and summarizing new articles...");
  const newArticles: Article[] = [];
  // If Phase 0 already hit the rate limit, don't bother spending Groq calls
  // in this loop either — they'd just 429 again. Still scrape and save every
  // new article below so discovery (which costs no Groq quota) never stalls
  // just because summarization is temporarily out of quota.
  let rateLimitedDuringNew = backlogResult.rateLimited;

  for (const raw of newRaw) {
    const rawContent = await scrapeArticle(raw.url, raw.source);

    // Some sites (e.g. ESPNCricinfo, Gadgets360) block requests from
    // Cloudflare's IP ranges with a 403, unrelated to our selectors. Rather
    // than permanently losing those articles (they'd never get a summary and
    // Phase 0 only retries articles that already have rawContent), fall back
    // to summarizing the RSS description so the article still shows up.
    const contentToSummarize =
      rawContent !== EXTRACTION_FAILED && rawContent.length > 0 ? rawContent : raw.description;

    let summary: string | null = null;
    let searchQuery: string | null = null;
    let links: Record<string, string> | null = null;
    let titleEn: string | null = null;
    let summaryEn: string | null = null;

    if (contentToSummarize && !rateLimitedDuringNew) {
      try {
        summary = await summarize(env, contentToSummarize, raw.language);
      } catch (err) {
        if (err instanceof RateLimitError) {
          rateLimitedDuringNew = true;
        } else {
          console.error(`Phase 3: Error | source=${raw.source} | title=${raw.title} | ${(err as Error).message}`);
        }
      }

      if (summary) {
        await sleep(RATE_LIMIT_PACING_MS); // pace the two Groq calls apart
        const query = await extractSearchQuery(env, raw.title, summary).catch((err) => {
          if (!(err instanceof RateLimitError)) {
            console.error(`SearchLink: Error | title=${raw.title} | ${(err as Error).message}`);
          }
          return null;
        });
        searchQuery = query;
        links = buildLinks(query ?? raw.title, raw.category);

        // Workers AI is a separate free-tier quota from Groq, so this
        // doesn't compete with summarization for rate limit budget.
        if (TRANSLATE_SOURCES.has(raw.source)) {
          titleEn = await translateToEnglish(env, raw.title, raw.language);
          summaryEn = await translateToEnglish(env, summary, raw.language);
        }
      }

      await sleep(RATE_LIMIT_PACING_MS); // pace before the next article's Groq calls
    }

    newArticles.push({
      id: crypto.randomUUID(),
      ...raw,
      // Store whatever text was actually used for summarization, so a
      // rate-limited run leaves something for Phase 0 to retry next time.
      rawContent: rawContent !== EXTRACTION_FAILED ? rawContent : (contentToSummarize ?? null),
      summary,
      searchQuery,
      links,
      titleEn,
      summaryEn,
      createdAt: new Date().toISOString(),
    });

    // Save after every article, not just at the end — same reasoning as the
    // Phase 0 backlog loop above: a killed background task shouldn't throw
    // away already-completed work.
    await saveArticles(env, [...articles, ...newArticles]);
  }

  if (rateLimitedDuringNew) {
    console.warn("Phase 2+3: Rate limit hit (429). New articles were still fetched and saved as pending for a later run to summarize.");
  }

  const merged = [...articles, ...newArticles];
  await saveMeta(env, {
    lastRunAt: new Date().toISOString(),
    lastRunNewArticles: newRaw.length,
    lastRunBacklogCleared: backlogResult.cleared,
    lastRunRateLimited: rateLimitedDuringNew,
    groqRateLimit: getLastRateLimitInfo(),
  });
  console.log(
    `Pipeline completed. ${newArticles.length} new articles processed this run, ${merged.length} total in store.`,
  );
}

async function processBacklog(
  env: Env,
  articles: Article[],
  disabledSources: Set<string>,
): Promise<{ articles: Article[]; rateLimited: boolean; cleared: number }> {
  const pending = articles.filter(
    (a) => a.rawContent && a.summary == null && !disabledSources.has(a.source),
  );
  if (pending.length === 0) {
    console.log("Phase 0: No backlog articles found.");
    return { articles, rateLimited: false, cleared: 0 };
  }

  const backlog = interleaveBySource(pending).slice(0, BACKLOG_LIMIT);
  console.log(`Phase 0: ${pending.length} articles pending summary. Processing up to ${backlog.length} as backlog.`);

  let cleared = 0;

  for (const article of backlog) {
    try {
      const summary = await summarize(env, article.rawContent!, article.language);
      if (summary) {
        article.summary = summary;
        await sleep(RATE_LIMIT_PACING_MS); // pace the two Groq calls apart
        const query = await extractSearchQuery(env, article.title, summary).catch((err) => {
          if (!(err instanceof RateLimitError)) {
            console.error(`Phase 0 SearchLink: Error | title=${article.title} | ${(err as Error).message}`);
          }
          return null;
        });
        article.searchQuery = query;
        article.links = buildLinks(query ?? article.title, article.category);

        if (TRANSLATE_SOURCES.has(article.source)) {
          article.titleEn = await translateToEnglish(env, article.title, article.language);
          article.summaryEn = await translateToEnglish(env, summary, article.language);
        }

        cleared++;
        console.log(`Phase 0: Backlog summarized | source=${article.source} | title=${article.title}`);

        // Save immediately, per article. Cloudflare can (and did, in
        // testing) kill a waitUntil-extended background task before it
        // finishes — without an incremental save here, every article
        // summarized in a run that gets cut off is silently thrown away,
        // burning real Groq quota for nothing and leaving the article
        // stuck "pending" forever despite having actually succeeded.
        await saveArticles(env, articles);
      }

      await sleep(RATE_LIMIT_PACING_MS); // pace before the next article's Groq calls
    } catch (err) {
      if (err instanceof RateLimitError) {
        console.warn(`Phase 0: Rate limit hit (429). Halting pipeline — ${pending.length} articles still pending.`);
        return { articles, rateLimited: true, cleared };
      }
      console.error(`Phase 0: Error | source=${article.source} | title=${article.title} | ${(err as Error).message}`);
    }
  }

  return { articles, rateLimited: false, cleared };
}
