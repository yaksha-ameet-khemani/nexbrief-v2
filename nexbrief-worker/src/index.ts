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
import { translateWithFallback } from "./translate";
import { summarizeWithCloudflare } from "./cfSummarize";
import { MAX_ARTICLES_PER_SOURCE } from "./constants";

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

interface SummarizeResult {
  summary: string | null;
  summarizedBy: "groq" | "cloudflare" | null;
}

// Tries Groq first (better quality, what the site used exclusively before).
// If Groq's rate limit has already been hit earlier in this run, or gets hit
// on this call, falls back to Cloudflare Workers AI — a separate free quota
// from Groq entirely (see cfSummarize.ts) — instead of leaving the article
// pending until the next hourly run. `groqState` is shared across the whole
// run (backlog + new articles) so once Groq 429s once, every later article
// skips straight to Cloudflare rather than wasting a call re-discovering the
// same rate limit.
async function summarizeWithFallback(
  env: Env,
  content: string,
  language: string,
  groqState: { rateLimited: boolean },
): Promise<SummarizeResult> {
  if (!groqState.rateLimited) {
    try {
      const summary = await summarize(env, content, language);
      if (summary) return { summary, summarizedBy: "groq" };
    } catch (err) {
      if (err instanceof RateLimitError) {
        groqState.rateLimited = true;
      } else {
        console.error(`Summarize: Groq error | ${(err as Error).message}`);
      }
    }
  }

  const cfSummary = await summarizeWithCloudflare(env, content, language);
  return { summary: cfSummary, summarizedBy: cfSummary ? "cloudflare" : null };
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
  // Local to this phase — Phase 0/2/3 each track Groq's rate-limit state
  // independently too (see processBacklog/runPipeline below), since each
  // phase discovers it fresh from an actual 429 rather than assuming a
  // limit hit in one phase still applies once the next hourly run starts.
  const groqState = { rateLimited: false };

  for (const article of articles) {
    if (!TRANSLATE_SOURCES.has(article.source) || article.language === "en") continue;

    const originalLanguage = article.language;
    const translatedTitle = await translateWithFallback(env, article.title, originalLanguage, groqState);
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
        (await translateWithFallback(env, article.description, originalLanguage, groqState)) ?? article.description;
    }
    if (article.rawContent) {
      article.rawContent =
        (await translateWithFallback(
          env,
          article.rawContent.slice(0, TRANSLATE_CONTENT_MAX_CHARS),
          originalLanguage,
          groqState,
        )) ?? article.rawContent;
    }
    if (article.summary) {
      article.summary =
        (await translateWithFallback(env, article.summary, originalLanguage, groqState)) ?? article.summary;
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
    console.warn("Phase 0: Groq rate limit hit during backlog processing; remaining backlog was routed through Cloudflare Workers AI where possible.");
  } else {
    console.log("Phase 0: Backlog phase complete.");
  }

  // Each source's fetch budget for this run shrinks by however many
  // articles it already has waiting on a summary — a source with 2 pending
  // only pulls 3 new ones, a source at or past the full per-run cap pulls
  // zero. Recomputed after Phase 0 so a source that just got cleared back
  // down gets its budget back immediately, same run. Prevents any single
  // source's backlog from snowballing into "a mountain" while quiet sources
  // keep fetching at full pace, instead of the old hard on/off cutoff.
  const pendingCounts = new Map<string, number>();
  for (const a of articles) {
    if (a.summary == null) pendingCounts.set(a.source, (pendingCounts.get(a.source) ?? 0) + 1);
  }
  const fetchLimits = new Map<string, number>();
  for (const [source, count] of pendingCounts.entries()) {
    fetchLimits.set(source, Math.max(0, MAX_ARTICLES_PER_SOURCE - count));
  }
  const throttled = [...fetchLimits.entries()].filter(
    ([source, limit]) => limit < MAX_ARTICLES_PER_SOURCE && !disabledSources.has(source),
  );
  if (throttled.length > 0) {
    console.log(
      `Pipeline: Throttling fetch this run: ${throttled.map(([s, l]) => `${s}=${l}`).join(", ")}`,
    );
  }

  console.log("Phase 1: Fetching RSS...");
  const existingUrls = existingUrlSet(articles);
  const newRaw = interleaveBySource(await fetchAllFeeds(existingUrls, disabledSources, fetchLimits));
  console.log(`Phase 1: Completed. ${newRaw.length} new articles found.`);

  console.log("Phase 2 + 3: Extracting content and summarizing new articles...");
  const newArticles: Article[] = [];
  // Carries Phase 0's rate-limit state into this loop — if Groq already
  // 429'd during backlog processing, skip straight to the Cloudflare lane
  // instead of wasting a call re-discovering the same rate limit.
  const groqState = { rateLimited: backlogResult.rateLimited };
  let newByGroq = 0;
  let newByCloudflare = 0;

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
      const translatedTitle = await translateWithFallback(env, raw.title, raw.language, groqState);
      const translatedContent = content
        ? await translateWithFallback(env, content.slice(0, TRANSLATE_CONTENT_MAX_CHARS), raw.language, groqState)
        : null;

      // Only commit to English if every translation this article actually
      // needed came through — a partial translation would still flip
      // `language` to "en", and normalizeTranslatedSources() skips anything
      // already marked "en", so a partial failure would never get retried.
      if (translatedTitle && (!content || translatedContent)) {
        title = translatedTitle;
        if (description) {
          description = (await translateWithFallback(env, description, raw.language, groqState)) ?? description;
        }
        if (translatedContent) content = translatedContent;
        language = "en";
      } else {
        console.warn(`Phase 2: Failed to translate, will retry next run | source=${raw.source}`);
      }
    }

    let summary: string | null = null;
    let summarizedBy: "groq" | "cloudflare" | null = null;
    let searchQuery: string | null = null;
    let links: Record<string, string> | null = null;

    if (content) {
      const result = await summarizeWithFallback(env, content, language, groqState);
      summary = result.summary;
      summarizedBy = result.summarizedBy;
      if (summarizedBy === "groq") newByGroq++;
      else if (summarizedBy === "cloudflare") newByCloudflare++;

      if (summary) {
        await sleep(RATE_LIMIT_PACING_MS); // pace before the (always-Groq) search-query call
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
      summarizedBy,
      searchQuery,
      links,
      createdAt: new Date().toISOString(),
    });

    // Save after every article, not just at the end — same reasoning as the
    // Phase 0 backlog loop above: a killed background task shouldn't throw
    // away already-completed work.
    await saveArticles(env, [...articles, ...newArticles]);
  }

  if (groqState.rateLimited) {
    console.warn("Phase 2+3: Groq rate limit hit (429) this run. Remaining summaries were routed through Cloudflare Workers AI where possible; any that still came up empty stay pending for a later run.");
  }

  const merged = [...articles, ...newArticles];
  await saveMeta(env, {
    lastRunAt: new Date().toISOString(),
    lastRunNewArticles: newRaw.length,
    lastRunBacklogCleared: backlogResult.cleared,
    lastRunRateLimited: groqState.rateLimited,
    lastRunSummarizedByGroq: backlogResult.clearedByGroq + newByGroq,
    lastRunSummarizedByCloudflare: backlogResult.clearedByCloudflare + newByCloudflare,
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
): Promise<{
  articles: Article[];
  rateLimited: boolean;
  cleared: number;
  clearedByGroq: number;
  clearedByCloudflare: number;
}> {
  const pending = articles.filter(
    (a) => a.rawContent && a.summary == null && !disabledSources.has(a.source),
  );
  if (pending.length === 0) {
    console.log("Phase 0: No backlog articles found.");
    return { articles, rateLimited: false, cleared: 0, clearedByGroq: 0, clearedByCloudflare: 0 };
  }

  const backlog = interleaveBySource(pending).slice(0, BACKLOG_LIMIT);
  console.log(`Phase 0: ${pending.length} articles pending summary. Processing up to ${backlog.length} as backlog.`);

  // Shared across the whole backlog loop, same reasoning as Phase 2+3: once
  // Groq 429s once, stop retrying it and route the rest of this run's
  // backlog through Cloudflare instead of halting entirely — a rate-limited
  // run used to stop backlog-clearing outright, which is exactly how a
  // handful of sources accumulated hundreds of pending articles before.
  const groqState = { rateLimited: false };
  let cleared = 0;
  let clearedByGroq = 0;
  let clearedByCloudflare = 0;

  for (const article of backlog) {
    try {
      const { summary, summarizedBy } = await summarizeWithFallback(
        env,
        article.rawContent!,
        article.language,
        groqState,
      );
      if (summary) {
        article.summary = summary;
        article.summarizedBy = summarizedBy;
        await sleep(RATE_LIMIT_PACING_MS); // pace before the (always-Groq) search-query call
        const query = await extractSearchQuery(env, article.title, summary).catch((err) => {
          if (!(err instanceof RateLimitError)) {
            console.error(`Phase 0 SearchLink: Error | title=${article.title} | ${(err as Error).message}`);
          }
          return null;
        });
        article.searchQuery = query;
        article.links = buildLinks(query ?? article.title, article.category);

        cleared++;
        if (summarizedBy === "groq") clearedByGroq++;
        else if (summarizedBy === "cloudflare") clearedByCloudflare++;
        console.log(`Phase 0: Backlog summarized | source=${article.source} | via=${summarizedBy} | title=${article.title}`);

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
      console.error(`Phase 0: Error | source=${article.source} | title=${article.title} | ${(err as Error).message}`);
    }
  }

  return { articles, rateLimited: groqState.rateLimited, cleared, clearedByGroq, clearedByCloudflare };
}
