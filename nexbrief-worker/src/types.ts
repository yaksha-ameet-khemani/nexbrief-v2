export interface Article {
  id: string;
  title: string;
  url: string;
  source: string;
  category: string;
  language: string;
  thumbnailUrl: string | null;
  author: string | null;
  description: string | null;
  publishedAt: string; // ISO 8601
  rawContent: string | null;
  summary: string | null;
  searchQuery: string | null;
  links: Record<string, string> | null;
  // English translation of title/summary, via Cloudflare Workers AI. Only
  // populated for non-English sources (currently just BBC Urdu) — null for
  // everything else, including while the translation is still pending.
  titleEn: string | null;
  summaryEn: string | null;
  createdAt: string; // ISO 8601
}

// Shape produced by the RSS-fetch phase, before scraping/summarizing has happened.
export type FetchedArticle = Omit<
  Article,
  "id" | "rawContent" | "summary" | "searchQuery" | "links" | "titleEn" | "summaryEn" | "createdAt"
>;

export interface PageResponse<T> {
  content: T[];
  totalElements: number;
  totalPages: number;
  number: number;
  size: number;
}

export interface GroqRateLimitInfo {
  limitRequests: string | null;
  remainingRequests: string | null;
  resetRequests: string | null;
  limitTokens: string | null;
  remainingTokens: string | null;
  resetTokens: string | null;
  capturedAt: string; // ISO 8601
}

export interface PipelineMeta {
  lastRunAt: string; // ISO 8601
  lastRunNewArticles: number;
  lastRunBacklogCleared: number;
  lastRunRateLimited: boolean;
  groqRateLimit: GroqRateLimitInfo | null;
}

export interface Env {
  NEXBRIEF_KV: KVNamespace;
  AI: Ai;
  GROQ_API_KEY: string;
  GROQ_API_URL: string;
  GROQ_API_MODEL: string;
  REFRESH_SECRET: string;
}
