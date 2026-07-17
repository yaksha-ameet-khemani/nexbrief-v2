import type { Article, Env, PipelineMeta, SourceConfig } from "./types";

const KV_KEY = "articles";
const META_KEY = "meta";
const SOURCE_CONFIG_KEY = "sourceConfig";
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

// Wipes every stored article — summarized and pending alike. Leaves
// sourceConfig (manual disable toggles) and meta (last-run stats) untouched;
// meta gets overwritten naturally by the next pipeline run regardless.
export async function clearArticles(env: Env): Promise<void> {
  await env.NEXBRIEF_KV.delete(KV_KEY);
}

export async function loadMeta(env: Env): Promise<PipelineMeta | null> {
  const raw = await env.NEXBRIEF_KV.get(META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PipelineMeta;
  } catch (err) {
    console.error("store: failed to parse meta JSON", err);
    return null;
  }
}

export async function saveMeta(env: Env, meta: PipelineMeta): Promise<void> {
  await env.NEXBRIEF_KV.put(META_KEY, JSON.stringify(meta));
}

export async function loadSourceConfig(env: Env): Promise<SourceConfig> {
  const raw = await env.NEXBRIEF_KV.get(SOURCE_CONFIG_KEY);
  if (!raw) return { disabledSources: [] };
  try {
    return JSON.parse(raw) as SourceConfig;
  } catch (err) {
    console.error("store: failed to parse source config JSON, defaulting to all-enabled", err);
    return { disabledSources: [] };
  }
}

export async function saveSourceConfig(env: Env, config: SourceConfig): Promise<void> {
  await env.NEXBRIEF_KV.put(SOURCE_CONFIG_KEY, JSON.stringify(config));
}
