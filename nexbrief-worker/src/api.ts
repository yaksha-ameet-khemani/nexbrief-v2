import type { Article, Env, PageResponse } from "./types";
import { loadArticles, loadMeta } from "./store";

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

// Mirrors ArticleService.getArticles(source, category, keyword, date, page, size):
// keyword takes priority, then source, then category, then a date filter that
// defaults to "today" when nothing else was passed.
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
  } else if (source) {
    articles = articles.filter((a) => a.source === source);
  } else if (category) {
    articles = articles.filter((a) => a.category === category);
  } else {
    const filterDate = date ?? new Date().toISOString().split("T")[0];
    articles = articles.filter((a) => a.publishedAt.startsWith(filterDate));
  }

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

// Powers the frontend's /status page: how many articles are fetched vs.
// still waiting on an AI summary, when the pipeline last ran, whether it got
// rate-limited, how much Groq quota is left (from the last captured response
// headers), and when the next hourly cron run will fire.
export async function handleGetStatus(env: Env): Promise<Response> {
  const [articles, meta] = await Promise.all([loadArticles(env), loadMeta(env)]);

  const summarized = articles.filter((a) => a.summary != null).length;
  const pending = articles.length - summarized;

  const bySource: Record<string, SourceStats> = {};
  for (const a of articles) {
    const stats = (bySource[a.source] ??= { total: 0, summarized: 0, pending: 0 });
    stats.total++;
    if (a.summary != null) stats.summarized++;
    else stats.pending++;
  }

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
    lastRunAt: meta?.lastRunAt ?? null,
    lastRunNewArticles: meta?.lastRunNewArticles ?? null,
    lastRunBacklogCleared: meta?.lastRunBacklogCleared ?? null,
    lastRunRateLimited: meta?.lastRunRateLimited ?? null,
    groqRateLimit: meta?.groqRateLimit ?? null,
  });
}
