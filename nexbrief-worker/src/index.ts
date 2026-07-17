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
  handlePostClearAll,
  jsonResponse,
  corsPreflight,
  CORS_HEADERS,
} from "./api";
import { translateToEnglish } from "./translate";
import { AUTO_PAUSE_PENDING_THRESHOLD } from "./constants";

// Sources whose articles are translated to English (via Cloudflare Workers
// AI) before anything else happens to them — title, description, and raw
// content are all translated up front, so scraping/summarizing/display all
// operate on English text and nothing native ever reaches the site.
const TRANSLATE_SOURCES = new Set(["bbcurdu"]);

// Matches the article-body truncation `summarize()` already applies (see
// groq.ts) — no point translating more of the article than Groq will ever
// actually read.
const TRANSLATE_CONTENT_MAX_CHARS = 3000;

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

// One-time-per-article migration for TRANSLATE_SOURCES: translates title,
// description, rawContent, and summary (whichever are present) to English
// and flips `language` to "en", so it's skipped on every later run. Runs
// over the *whole* store (not just pending articles) so already-summarized
// legacy articles fetched before this behavior existed get caught too, not
// just future ones. Only Phase 0/2/3 look at `language` afterward, and by
// then it's already "en", so no other code needs to know this source was
// ever non-English.
async function normalizeTranslatedSources(
  env: Env,
  articles: Article[],
): Promise<{ articles: Article[]; migrated: number }> {
  let migrated = 0;

  for (const article of articles) {
    if (!TRANSLATE_SOURCES.has(article.source) || article.language === "en") continue;

    const originalLanguage = article.language;
    const translatedTitle = await translateToEnglish(env, article.title, originalLanguage);
    if (!translatedTitle) {
      // Title is always visible — if it fails to translate, leave the whole
      // article untouched (language stays non-"en") so a later run retries
      // it, rather than risk showing native text forever.
      console.warn(`Normalize: Failed to translate title, will retry next run | source=${article.source}`);
      continue;
    }
    article.title = translatedTitle;

    if (article.description) {
      article.description =
        (await translateToEnglish(env, article.description, originalLanguage)) ?? article.description;
    }
    if (article.rawContent) {
      article.rawContent =
        (await translateToEnglish(
          env,
          article.rawContent.slice(0, TRANSLATE_CONTENT_MAX_CHARS),
          originalLanguage,
        )) ?? article.rawContent;
    }
    if (article.summary) {
      article.summary =
        (await translateToEnglish(env, article.summary, originalLanguage)) ?? article.summary;
    }

    article.language = "en";
    migrated++;

    // Save after every article, not just at the end — a killed waitUntil
    // background task shouldn't throw away translations already paid for
    // (same reasoning as the incremental saves in processBacklog/runPipeline
    // below, learned the hard way — see STATUS.md).
    await saveArticles(env, articles);
  }

  if (migrated > 0) {
    console.log(`Normalize: Translated ${migrated} legacy non-English article(s) to English.`);
  }

  return { articles, migrated };
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

    // Wipes every article in KV (summarized and pending alike) so the site
    // can be observed from a clean slate. Same admin-secret gate as the
    // other management routes above.
    if (url.pathname === "/api/admin/clear-all" && request.method === "POST") {
      const secret = request.headers.get("X-Refresh-Secret");
      if (!env.REFRESH_SECRET || secret !== env.REFRESH_SECRET) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }
      return handlePostClearAll(env);
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

  console.log("Phase -1: Normalizing any legacy non-English TRANSLATE_SOURCES articles...");
  ({ articles } = await normalizeTranslatedSources(env, articles));

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
    const scraped = await scrapeArticle(raw.url, raw.source);
    const scrapeOk = scraped !== EXTRACTION_FAILED && scraped.length > 0;

    // Some sites (e.g. ESPNCricinfo, Gadgets360) block requests from
    // Cloudflare's IP ranges with a 403, unrelated to our selectors. Rather
    // than permanently losing those articles (they'd never get a summary and
    // Phase 0 only retries articles that already have rawContent), fall back
    // to summarizing the RSS description so the article still shows up.
    // This is also what gets stored as rawContent, for Phase 0 to reuse if
    // this run doesn't get to summarizing it (e.g. rate-limited).
    let title = raw.title;
    let description = raw.description;
    let language = raw.language;
    let content: string | null = scrapeOk ? scraped : raw.description;

    // Translate up front, before anything else touches this article — title,
    // description, and the content that'll be summarized are all replaced
    // with their English translation, and `language` flips to "en" so Groq
    // summarizes in English directly (no native summary is ever produced, so
    // there's nothing left to translate afterward).
    if (TRANSLATE_SOURCES.has(raw.source) && language !== "en") {
      const translatedTitle = await translateToEnglish(env, raw.title, raw.language);
      const translatedContent = content
        ? await translateToEnglish(env, content.slice(0, TRANSLATE_CONTENT_MAX_CHARS), raw.language)
        : null;

      // Only commit to English if every translation this article actually
      // needed came through — a partial translation would still flip
      // `language` to "en", and normalizeTranslatedSources() skips anything
      // already marked "en", so a partial failure would never get retried.
      if (translatedTitle && (!content || translatedContent)) {
        title = translatedTitle;
        if (description) {
          description = (await translateToEnglish(env, description, raw.language)) ?? description;
        }
        if (translatedContent) content = translatedContent;
        language = "en";
      } else {
        console.warn(`Phase 2: Failed to translate, will retry next run | source=${raw.source}`);
      }
    }

    let summary: string | null = null;
    let searchQuery: string | null = null;
    let links: Record<string, string> | null = null;

    if (content && !rateLimitedDuringNew) {
      try {
        summary = await summarize(env, content, language);
      } catch (err) {
        if (err instanceof RateLimitError) {
          rateLimitedDuringNew = true;
        } else {
          console.error(`Phase 3: Error | source=${raw.source} | title=${raw.title} | ${(err as Error).message}`);
        }
      }

      if (summary) {
        await sleep(RATE_LIMIT_PACING_MS); // pace the two Groq calls apart
        const query = await extractSearchQuery(env, title, summary).catch((err) => {
          if (!(err instanceof RateLimitError)) {
            console.error(`SearchLink: Error | title=${title} | ${(err as Error).message}`);
          }
          return null;
        });
        searchQuery = query;
        links = buildLinks(query ?? title, raw.category);
      }

      await sleep(RATE_LIMIT_PACING_MS); // pace before the next article's Groq calls
    }

    newArticles.push({
      id: crypto.randomUUID(),
      ...raw,
      title,
      description,
      language,
      rawContent: content,
      summary,
      searchQuery,
      links,
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
