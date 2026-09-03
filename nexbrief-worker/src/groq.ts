import type { Env, GroqRateLimitInfo } from "./types";

// Ported from AiSummaryService.callGroq + SearchLinkService (NexBrief Spring
// Boot backend) — same prompts, same params, same 3-attempt backoff.

// Base class for "Groq can't help us this run — stop calling it and route
// the rest of this run's work through the Cloudflare fallback lane." Callers
// check `instanceof GroqUnavailableError` so both subtypes below flip the
// run's `groqState.rateLimited` flag identically.
export class GroqUnavailableError extends Error {}

// Groq's free-tier rate limit (HTTP 429). Retrying within the same run won't
// clear it, so it's raised straight through callGroqWithRetry.
export class RateLimitError extends GroqUnavailableError {}

// Groq rejected the request itself — any 4xx that isn't 429: a missing /
// invalid / revoked GROQ_API_KEY (401/403), a decommissioned or misspelled
// model id (404 — this is what actually happened, llama-3.3-70b-versatile
// was retired), or a malformed request (400). Retrying the identical call
// won't fix any of these, and left un-fatal it's actively harmful: every
// Groq call in the run burned 3 attempts + ~15s of backoff + 3 subrequests
// on a guaranteed failure, until the Worker's subrequest budget was gone and
// even the RSS fetch in Phase 1 failed — zero new articles for ~2 weeks.
// Treated as fatal so the run drops straight to the Cloudflare lane. Only
// 5xx / network errors still get retried. See STATUS.md.
export class GroqRequestError extends GroqUnavailableError {}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pace between Groq calls so a run stays under the free-tier rate limit
// instead of burning through it in the first few seconds. Matches the
// 2-second pacing AiSummaryService used in the original Java backend.
export const RATE_LIMIT_PACING_MS = 2000;

// Groq (OpenAI-compatible) returns x-ratelimit-* headers on every response,
// success or not. Captured here per-call so the pipeline can persist the
// latest snapshot to KV for the status page, without threading it through
// every summarize()/extractSearchQuery() return value.
let lastRateLimitInfo: GroqRateLimitInfo | null = null;

export function getLastRateLimitInfo(): GroqRateLimitInfo | null {
  return lastRateLimitInfo;
}

function captureRateLimitHeaders(res: Response): void {
  const h = res.headers;
  if (!h.get("x-ratelimit-limit-requests") && !h.get("x-ratelimit-remaining-requests")) {
    return; // Groq didn't send rate-limit headers on this response, leave the last snapshot alone
  }
  lastRateLimitInfo = {
    limitRequests: h.get("x-ratelimit-limit-requests"),
    remainingRequests: h.get("x-ratelimit-remaining-requests"),
    resetRequests: h.get("x-ratelimit-reset-requests"),
    limitTokens: h.get("x-ratelimit-limit-tokens"),
    remainingTokens: h.get("x-ratelimit-remaining-tokens"),
    resetTokens: h.get("x-ratelimit-reset-tokens"),
    capturedAt: new Date().toISOString(),
  };
}

async function callGroq(env: Env, body: unknown): Promise<string | null> {
  const res = await fetch(env.GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  captureRateLimitHeaders(res);

  if (res.status === 429) {
    throw new RateLimitError(`Groq rate limit (429)`);
  }
  if (!res.ok) {
    // Read a snippet of the error body for diagnostics (e.g. Groq's
    // "model_decommissioned" / "model_not_found" code).
    const detail = (await res.text().catch(() => "")).trim().slice(0, 200);
    const suffix = detail ? `: ${detail}` : "";
    // A 4xx that isn't 429 will never succeed on retry this run — raise it as
    // fatal so callGroqWithRetry stops immediately and the caller switches
    // the whole run to Cloudflare. 5xx / network errors fall through to the
    // retry loop below.
    if (res.status >= 400 && res.status < 500) {
      throw new GroqRequestError(`Groq API HTTP error: ${res.status}${suffix}`);
    }
    throw new Error(`Groq API HTTP error: ${res.status}${suffix}`);
  }

  const json = (await res.json()) as any;
  const text = json?.choices?.[0]?.message?.content;
  return typeof text === "string" ? text.trim() : null;
}

async function callGroqWithRetry(env: Env, body: unknown, maxRetries = 3): Promise<string | null> {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await callGroq(env, body);
    } catch (err) {
      if (err instanceof GroqUnavailableError) throw err; // 429, or a 4xx Groq rejected — retrying this run won't help
      attempt++;
      console.warn(`Groq: retry ${attempt}/${maxRetries} | Reason: ${(err as Error).message}`);
      if (attempt < maxRetries) {
        await sleep(5000 * attempt); // 5s, 10s
      }
    }
  }
  console.error("Groq: all retries exhausted.");
  return null;
}

const LANGUAGE_INSTRUCTIONS: Record<string, string> = {
  hi: "Respond in Hindi.",
  ur: "Respond in Urdu.",
};

export async function summarize(env: Env, content: string, language: string): Promise<string | null> {
  const trimmed = content.length > 3000 ? content.slice(0, 3000) : content;
  const langInstruction = LANGUAGE_INSTRUCTIONS[language] ?? "Respond in English.";

  const body = {
    model: env.GROQ_API_MODEL,
    temperature: 0.5,
    messages: [
      {
        role: "system",
        content:
          "You are a news summarizer. Summarize the given article in 3-4 clear concise sentences. " +
          langInstruction +
          " Return only the summary, nothing else.",
      },
      { role: "user", content: trimmed },
    ],
  };

  return callGroqWithRetry(env, body);
}

// Used for translating non-English sources (see translate.ts) via the same
// model as summarization (env.GROQ_API_MODEL, currently llama-3.3-70b-versatile)
// rather than Cloudflare Workers AI's smaller 8B fallback model — a larger
// model carries far more real-world knowledge of names/places, which matters
// a lot for not mangling proper nouns in translation.
export async function translateGroq(env: Env, text: string, sourceLang: string): Promise<string | null> {
  const body = {
    model: env.GROQ_API_MODEL,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content:
          `Translate the following ${sourceLang} text to English. Preserve names of people, places, ` +
          "and organizations as accurately as possible. If you are not fully certain of the correct " +
          "English spelling of a name, transliterate it phonetically from the original script rather " +
          "than substituting a different real name or place you happen to recognize. Return only the " +
          "translated text, with no notes, explanations, or quotation marks around it.",
      },
      { role: "user", content: text },
    ],
  };

  return callGroqWithRetry(env, body);
}

export async function extractSearchQuery(
  env: Env,
  title: string,
  summary: string | null,
): Promise<string | null> {
  let input = `Title: ${title}`;
  if (summary) input += `\nSummary: ${summary}`;

  const body = {
    model: env.GROQ_API_MODEL,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content:
          "Extract a concise 4-6 word search query from the given news article title and summary. " +
          "The query should capture the core topic so a user can search it on Google or Reddit to find " +
          "other opinions. Return only the search query, nothing else.",
      },
      { role: "user", content: input },
    ],
  };

  return callGroqWithRetry(env, body);
}

export function buildLinks(query: string, category: string): Record<string, string> {
  const encoded = encodeURIComponent(query);
  const links: Record<string, string> = {
    "Google News": `https://news.google.com/search?q=${encoded}`,
    "Bing News": `https://www.bing.com/news/search?q=${encoded}`,
  };

  if (category === "cricket") {
    links["Cricbuzz"] = `https://www.cricbuzz.com/search?q=${encoded}`;
    links["ESPNCricinfo"] = `https://www.espncricinfo.com/search/_/term/${encoded}`;
    links["NDTV Sports"] = `https://sports.ndtv.com/search?searchtext=${encoded}`;
  } else if (category === "automobile") {
    links["Car and Driver"] = `https://www.caranddriver.com/search?searchTerm=${encoded}`;
    links["MotorTrend"] = `https://www.motortrend.com/search/${encoded}/`;
    links["CarDekho"] = `https://www.cardekho.com/search?q=${encoded}`;
  } else if (category === "technology") {
    links["TechCrunch"] = `https://techcrunch.com/search/${encoded}`;
    links["The Verge"] = `https://www.theverge.com/search?q=${encoded}`;
    links["Engadget"] = `https://www.engadget.com/search?search=${encoded}`;
  } else {
    links["Reuters"] = `https://www.reuters.com/search/news?blob=${encoded}`;
    links["BBC"] = `https://www.bbc.co.uk/search?q=${encoded}`;
    links["NDTV"] = `https://www.ndtv.com/search?searchtext=${encoded}`;
  }

  return links;
}
