import { XMLParser } from "fast-xml-parser";
import type { FetchedArticle } from "./types";
import { MAX_ARTICLES_PER_SOURCE } from "./constants";

// Ported from RssFetcherService.RSS_FEEDS (NexBrief Spring Boot backend).
export const RSS_FEEDS: Record<
  string,
  { source: string; category: string; language: string }
> = {
  "https://www.espncricinfo.com/rss/content/story/feeds/0.xml": {
    source: "espncricinfo",
    category: "cricket",
    language: "en",
  },
  "https://www.bhaskar.com/rss-feed/1061/": {
    source: "bhaskar",
    category: "general",
    language: "hi",
  },
  "https://www.autocarindia.com/rss/all": {
    source: "autocarindia",
    category: "automobile",
    language: "en",
  },
  "https://feeds.feedburner.com/gadgets360-latest": {
    source: "gadgets360",
    category: "technology",
    language: "en",
  },
  "https://feeds.bbci.co.uk/news/rss.xml": {
    source: "bbc",
    category: "general",
    language: "en",
  },
  "https://feeds.bbci.co.uk/urdu/rss.xml": {
    source: "bbcurdu",
    category: "general",
    language: "ur",
  },
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});

// Dainik Bhaskar's RSS feed serves the same story under two path forms that
// differ only by a "/g/" segment right after the host — e.g.
//   https://www.bhaskar.com/national/news/…-138922306.html
//   https://www.bhaskar.com/g/national/news/…-138922306.html
// It flips between the two forms from one hourly run to the next, so an
// exact-string dedup check (existingUrlSet) sees the second form as a
// brand-new article and re-scrapes/re-summarizes it. Collapsing the "/g/"
// segment maps both forms to one canonical URL. Deliberately bhaskar-only —
// every other source emits stable canonical URLs and must be left untouched.
export function canonicalizeUrl(url: string, source: string): string {
  if (source !== "bhaskar") return url;
  return url.replace(/^(https?:\/\/[^/]+)\/g\//, "$1/");
}

function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, "")
    .trim();
}

function textOf(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim();
  if (typeof value === "object" && "#text" in (value as Record<string, unknown>)) {
    const text = (value as Record<string, unknown>)["#text"];
    return typeof text === "string" ? text.trim() : null;
  }
  return null;
}

function firstOf<T>(value: T | T[] | undefined): T | undefined {
  if (value == null) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function extractThumbnail(item: any): string | null {
  const mediaContent = firstOf(item["media:content"]);
  if (mediaContent?.["@_url"]) return mediaContent["@_url"];

  const mediaThumbnail = firstOf(item["media:thumbnail"]);
  if (mediaThumbnail?.["@_url"]) return mediaThumbnail["@_url"];

  const enclosure = firstOf(item.enclosure);
  if (enclosure?.["@_url"]) return enclosure["@_url"];

  return null;
}

function extractAuthor(item: any): string | null {
  const creator = textOf(item["dc:creator"]);
  if (creator) return creator;
  return textOf(item.author);
}

function extractUrl(item: any): string | null {
  // Some feeds carry a custom foreign <url> element; fall back to <link>.
  const foreignUrl = textOf(item.url);
  if (foreignUrl) return foreignUrl;
  return textOf(item.link);
}

function extractPublishedAt(item: any): string {
  const raw = item.pubDate ?? item["dc:date"] ?? item.updated;
  if (raw) {
    const parsed = new Date(textOf(raw) ?? raw);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

async function fetchFeed(
  feedUrl: string,
  meta: { source: string; category: string; language: string },
  existingUrls: Set<string>,
  limit: number,
): Promise<FetchedArticle[]> {
  const res = await fetch(feedUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; NexBriefBot/1.0)" },
  });
  if (!res.ok) {
    throw new Error(`Feed fetch failed: ${feedUrl} (${res.status})`);
  }

  const xml = await res.text();
  const parsed = parser.parse(xml);

  const rawItems = parsed?.rss?.channel?.item;
  const items: any[] = rawItems == null ? [] : Array.isArray(rawItems) ? rawItems : [rawItems];

  const results: FetchedArticle[] = [];

  for (const item of items) {
    if (results.length >= limit) break;

    const rawUrl = extractUrl(item);
    if (!rawUrl) continue;
    // Compare and store the canonical form so bhaskar's "/g/" URL variants
    // dedup against each other (canonicalizeUrl is a no-op for every other
    // source, so their URLs are untouched).
    const url = canonicalizeUrl(rawUrl, meta.source);
    if (existingUrls.has(url)) continue;

    const description = textOf(item.description);

    results.push({
      title: textOf(item.title) ?? "No Title",
      url,
      source: meta.source,
      category: meta.category,
      language: meta.language,
      thumbnailUrl: extractThumbnail(item),
      author: extractAuthor(item),
      description: description ? stripHtml(description) : null,
      publishedAt: extractPublishedAt(item),
    });
  }

  return results;
}

// Canonical list of every source the pipeline knows about, derived from
// RSS_FEEDS so it can't drift out of sync — used to render/validate the
// source-management table even for a source with zero cached articles.
export const ALL_SOURCES: string[] = [...new Set(Object.values(RSS_FEEDS).map((m) => m.source))];

// Each source's original RSS language, derived from RSS_FEEDS the same way
// as ALL_SOURCES. Used to recover a source's original language when an
// article's `language` field has already been overwritten to "en" by the
// TRANSLATE_SOURCES pipeline (see index.ts's normalizeTranslatedSources) but
// needs to be reset for retry — e.g. a translation that silently failed but
// still got treated as a success.
export const SOURCE_LANGUAGES: Record<string, string> = Object.fromEntries(
  Object.values(RSS_FEEDS).map((m) => [m.source, m.language]),
);

export async function fetchAllFeeds(
  existingUrls: Set<string>,
  disabledSources: Set<string> = new Set(),
  // Per-source fetch budget for this run, computed by the caller as
  // MAX_ARTICLES_PER_SOURCE minus however many articles that source already
  // has pending — a source not present here fetches at the full cap. Lets a
  // source with a growing backlog pull in fewer new articles instead of
  // piling on top of one it hasn't cleared yet, without a hard on/off switch.
  fetchLimits: Map<string, number> = new Map(),
): Promise<FetchedArticle[]> {
  const all: FetchedArticle[] = [];

  for (const [feedUrl, meta] of Object.entries(RSS_FEEDS)) {
    if (disabledSources.has(meta.source)) {
      console.log(`Phase 1 | Source: ${meta.source} | Skipped (disabled)`);
      continue;
    }
    const limit = fetchLimits.get(meta.source) ?? MAX_ARTICLES_PER_SOURCE;
    if (limit <= 0) {
      console.log(`Phase 1 | Source: ${meta.source} | Skipped (throttled — pending backlog already at cap)`);
      continue;
    }
    try {
      const articles = await fetchFeed(feedUrl, meta, existingUrls, limit);
      all.push(...articles);
      console.log(`Phase 1 | Source: ${meta.source} | Found ${articles.length} new articles (limit ${limit})`);
    } catch (err) {
      console.error(`Failed to fetch feed: ${meta.source} | Error: ${(err as Error).message}`);
    }
  }

  return all;
}
