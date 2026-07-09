import type { Article, Env } from "./types";

const KV_KEY = "articles";
const RETENTION_DAYS = 5; // keep a rolling window so the date-picker UI still has yesterday/day-before

export async function loadArticles(env: Env): Promise<Article[]> {
  const raw = await env.NEXBRIEF_KV.get(KV_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as Article[];
  } catch (err) {
    console.error("store: failed to parse KV JSON, starting fresh", err);
    return [];
  }
}

export async function saveArticles(env: Env, articles: Article[]): Promise<void> {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const trimmed = articles.filter((a) => new Date(a.publishedAt).getTime() >= cutoff);
  trimmed.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  await env.NEXBRIEF_KV.put(KV_KEY, JSON.stringify(trimmed));
}

export function existingUrlSet(articles: Article[]): Set<string> {
  return new Set(articles.map((a) => a.url));
}
