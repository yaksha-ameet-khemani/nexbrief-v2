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
  createdAt: string; // ISO 8601
}

// Shape produced by the RSS-fetch phase, before scraping/summarizing has happened.
export type FetchedArticle = Omit<
  Article,
  "id" | "rawContent" | "summary" | "searchQuery" | "links" | "createdAt"
>;

export interface PageResponse<T> {
  content: T[];
  totalElements: number;
  totalPages: number;
  number: number;
  size: number;
}

export interface Env {
  NEXBRIEF_KV: KVNamespace;
  GROQ_API_KEY: string;
  GROQ_API_URL: string;
  GROQ_API_MODEL: string;
  REFRESH_SECRET: string;
}
