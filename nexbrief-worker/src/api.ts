import type { Article, Env, PageResponse } from "./types";
import { loadArticles, loadMeta, loadSourceConfig, saveSourceConfig } from "./store";
import { ALL_SOURCES } from "./feeds";
import { AUTO_PAUSE_PENDING_THRESHOLD } from "./constants";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Refresh-Secret",
};

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// By default, every filter combines with every other active filter, and
// with no date param at all the result is everything currently in the KV
// store (which only ever retains ~5 days anyway) — not just today. The date
// filter is opt-in: pass a specific date to narrow down to just that day,
// on top of whatever source/category/keyword is also active.
export async function handleGetArticles(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;

  const source = params.get("source")?.trim() || undefined;
  const category = params.get("category")?.trim() || undefined;
  const keyword = params.get("keyword")?.trim().toLowerCase() || undefined;
  const date = params.get("date")?.trim() || undefined;
  const page = Math.max(0, parseInt(params.get("page") ?? "0", 10) || 0);
  const size = Math.max(1, parseInt(params.get("size") ?? "100", 10) || 100);

  // Every fetched article shows up immediately, even before its AI summary
  // is ready — the frontend falls back to the RSS description in that case,
  // rather than hiding real news behind Groq's rate limit.
  let articles = await loadArticles(env);

  if (keyword) {
    articles = articles.filter(
      (a) =>
        a.title.toLowerCase().includes(keyword) ||
        (a.description?.toLowerCase().includes(keyword) ?? false),
    );
  }
  if (source) articles = articles.filter((a) => a.source === source);
  if (category) articles = articles.filter((a) => a.category === category);
  if (date) articles = articles.filter((a) => a.publishedAt.startsWith(date));

  articles = [...articles].sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  );

  const totalElements = articles.length;
  const totalPages = Math.max(1, Math.ceil(totalElements / size));
  const content = articles.slice(page * size, page * size + size);

  const response: PageResponse<Article> = {
    content,
    totalElements,
    totalPages,
    number: page,
    size,
  };

  return jsonResponse(response);
}

interface SourceStats {
  total: number;
  summarized: number;
  pending: number;
}

interface PendingArticleSummary {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
}

// Powers the frontend's /status page: how many articles are fetched vs.
// still waiting on an AI summary, when the pipeline last ran, whether it got
// rate-limited, how much Groq quota is left (from the last captured response
// headers), and when the next hourly cron run will fire.
export async function handleGetStatus(env: Env): Promise<Response> {
  const [articles, meta, sourceConfig] = await Promise.all([
    loadArticles(env),
    loadMeta(env),
    loadSourceConfig(env),
  ]);

  const summarized = articles.filter((a) => a.summary != null).length;
  const pending = articles.length - summarized;

  // Seeded from every known source (not just ones with cached articles) so a
  // just-disabled or newly-empty source still shows up in the management
  // table with a 0 row, rather than disappearing once its articles roll off
  // the retention window.
  const bySource: Record<string, SourceStats> = {};
  for (const source of ALL_SOURCES) {
    bySource[source] = { total: 0, summarized: 0, pending: 0 };
  }
  for (const a of articles) {
    const stats = (bySource[a.source] ??= { total: 0, summarized: 0, pending: 0 });
    stats.total++;
    if (a.summary != null) stats.summarized++;
    else stats.pending++;
  }

  const pendingArticles: PendingArticleSummary[] = articles
    .filter((a) => a.summary == null)
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .map((a) => ({ title: a.title, source: a.source, url: a.url, publishedAt: a.publishedAt }));

  const now = new Date();
  const nextRunAt = new Date(now);
  nextRunAt.setUTCMinutes(0, 0, 0);
  nextRunAt.setUTCHours(nextRunAt.getUTCHours() + 1);

  return jsonResponse({
    serverTime: now.toISOString(),
    nextRunAt: nextRunAt.toISOString(),
    totalArticles: articles.length,
    summarized,
    pending,
    bySource,
    pendingArticles,
    lastRunAt: meta?.lastRunAt ?? null,
    lastRunNewArticles: meta?.lastRunNewArticles ?? null,
    lastRunBacklogCleared: meta?.lastRunBacklogCleared ?? null,
    lastRunRateLimited: meta?.lastRunRateLimited ?? null,
    groqRateLimit: meta?.groqRateLimit ?? null,
    disabledSources: sourceConfig.disabledSources,
    // Mirrors the pipeline's own auto-pause check (index.ts) so the status
    // page can show it — a source shows up here once its pending backlog
    // exceeds the threshold, whether or not it's also manually disabled.
    autoPausedSources: Object.entries(bySource)
      .filter(([, stats]) => stats.pending > AUTO_PAUSE_PENDING_THRESHOLD)
      .map(([source]) => source),
    autoPauseThreshold: AUTO_PAUSE_PENDING_THRESHOLD,
  });
}

// Pauses/resumes a source from the /status page — a disabled source is
// skipped entirely by the pipeline (no new-article fetching, no backlog
// summarization), which is the actual lever for taking Groq-quota pressure
// off the rest of the sources. Already-cached articles for that source are
// untouched and keep showing on the site. Gated by X-Refresh-Secret at the
// call site in index.ts, same as /api/refresh.
export async function handlePostToggleSource(request: Request, env: Env): Promise<Response> {
  let body: { source?: unknown; enabled?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { source, enabled } = body;
  if (typeof source !== "string" || !ALL_SOURCES.includes(source)) {
    return jsonResponse({ error: `Unknown source. Must be one of: ${ALL_SOURCES.join(", ")}` }, 400);
  }
  if (typeof enabled !== "boolean") {
    return jsonResponse({ error: "'enabled' must be a boolean" }, 400);
  }

  const config = await loadSourceConfig(env);
  const disabled = new Set(config.disabledSources);
  if (enabled) disabled.delete(source);
  else disabled.add(source);

  const updated = { disabledSources: [...disabled] };
  await saveSourceConfig(env, updated);

  return jsonResponse({ source, enabled, disabledSources: updated.disabledSources });
}
