import type { Article, Env, PageResponse } from "./types";
import { loadArticles } from "./store";

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
