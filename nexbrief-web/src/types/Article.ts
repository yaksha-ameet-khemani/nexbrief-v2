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
  summary: string | null;
  searchQuery: string | null;
  links: Record<string, string> | null;
  titleEn: string | null;
  summaryEn: string | null;
  publishedAt: string;
}

export interface PageResponse<T> {
  content: T[];
  totalElements: number;
  totalPages: number;
  number: number; // current page
  size: number;
}

export const SOURCE_LABELS: Record<string, string> = {
  espncricinfo: "ESPNCricinfo",
  bhaskar: "Dainik Bhaskar",
  autocarindia: "Autocar India",
  gadgets360: "Gadgets360",
  bbc: "BBC News",
  bbcurdu: "BBC Urdu",
};

export const CATEGORIES = ["cricket", "automobile", "technology", "general"];
