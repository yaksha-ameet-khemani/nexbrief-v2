import { XMLParser } from "fast-xml-parser";
import type { FetchedArticle } from "./types";

const MAX_ARTICLES_PER_SOURCE = 5;

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
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});

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
    if (results.length >= MAX_ARTICLES_PER_SOURCE) break;

    const url = extractUrl(item);
    if (!url || existingUrls.has(url)) continue;

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

export async function fetchAllFeeds(existingUrls: Set<string>): Promise<FetchedArticle[]> {
  const all: FetchedArticle[] = [];

  for (const [feedUrl, meta] of Object.entries(RSS_FEEDS)) {
    try {
      const articles = await fetchFeed(feedUrl, meta, existingUrls);
      all.push(...articles);
      console.log(`Phase 1 | Source: ${meta.source} | Found ${articles.length} new articles`);
    } catch (err) {
      console.error(`Failed to fetch feed: ${meta.source} | Error: ${(err as Error).message}`);
    }
  }

  return all;
}
