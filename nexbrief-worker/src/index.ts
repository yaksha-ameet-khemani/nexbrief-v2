import type { Article, Env } from "./types";
import { fetchAllFeeds } from "./feeds";
import { scrapeArticle, EXTRACTION_FAILED } from "./scrape";
import { summarize, extractSearchQuery, buildLinks, RateLimitError, sleep, RATE_LIMIT_PACING_MS } from "./groq";
import { loadArticles, saveArticles, existingUrlSet } from "./store";
import { handleGetArticles, jsonResponse, corsPreflight, CORS_HEADERS } from "./api";

const BACKLOG_LIMIT = 20; // matches AiSummaryService.BACKLOG_LIMIT

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return corsPreflight();
    }

    if (url.pathname === "/api/articles" && request.method === "GET") {
      return handleGetArticles(request, env);
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

  console.log("Phase 0: Completing pending backlog summaries...");
  const backlogResult = await processBacklog(env, articles);
  articles = backlogResult.articles;
  if (backlogResult.rateLimited) {
    await saveArticles(env, articles);
    console.warn("Pipeline halted: rate limit hit during backlog processing. Will retry on next run.");
    return;
  }
  console.log("Phase 0: Backlog phase complete.");

  console.log("Phase 1: Fetching RSS...");
  const existingUrls = existingUrlSet(articles);
  const newRaw = await fetchAllFeeds(existingUrls);
  console.log(`Phase 1: Completed. ${newRaw.length} new articles found.`);

  console.log("Phase 2 + 3: Extracting content and summarizing new articles...");
  const newArticles: Article[] = [];
  let rateLimitedDuringNew = false;

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

    if (contentToSummarize) {
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
      createdAt: new Date().toISOString(),
    });

    if (rateLimitedDuringNew) {
      console.warn("Phase 3: Rate limit hit (429). Stopping summarization for this run.");
      break;
    }
  }

  const merged = [...articles, ...newArticles];
  await saveArticles(env, merged);
  console.log(
    `Pipeline completed. ${newArticles.length} new articles processed this run, ${merged.length} total in store.`,
  );
}

async function processBacklog(
  env: Env,
  articles: Article[],
): Promise<{ articles: Article[]; rateLimited: boolean }> {
  const pending = articles.filter((a) => a.rawContent && a.summary == null);
  if (pending.length === 0) {
    console.log("Phase 0: No backlog articles found.");
    return { articles, rateLimited: false };
  }

  const backlog = pending.slice(0, BACKLOG_LIMIT);
  console.log(`Phase 0: ${pending.length} articles pending summary. Processing up to ${backlog.length} as backlog.`);

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
        console.log(`Phase 0: Backlog summarized | source=${article.source} | title=${article.title}`);
      }

      await sleep(RATE_LIMIT_PACING_MS); // pace before the next article's Groq calls
    } catch (err) {
      if (err instanceof RateLimitError) {
        console.warn(`Phase 0: Rate limit hit (429). Halting pipeline — ${pending.length} articles still pending.`);
        return { articles, rateLimited: true };
      }
      console.error(`Phase 0: Error | source=${article.source} | title=${article.title} | ${(err as Error).message}`);
    }
  }

  return { articles, rateLimited: false };
}
