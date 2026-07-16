export interface GroqRateLimitInfo {
  limitRequests: string | null;
  remainingRequests: string | null;
  resetRequests: string | null;
  limitTokens: string | null;
  remainingTokens: string | null;
  resetTokens: string | null;
  capturedAt: string;
}

export interface SourceStats {
  total: number;
  summarized: number;
  pending: number;
}

export interface PendingArticleSummary {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
}

export interface StatusResponse {
  serverTime: string;
  nextRunAt: string;
  totalArticles: number;
  summarized: number;
  pending: number;
  bySource: Record<string, SourceStats>;
  pendingArticles: PendingArticleSummary[];
  lastRunAt: string | null;
  lastRunNewArticles: number | null;
  lastRunBacklogCleared: number | null;
  lastRunRateLimited: boolean | null;
  groqRateLimit: GroqRateLimitInfo | null;
  disabledSources: string[];
}
