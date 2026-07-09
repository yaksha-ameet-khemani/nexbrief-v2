import type { Env } from "./types";

// Ported from AiSummaryService.callGroq + SearchLinkService (NexBrief Spring
// Boot backend) — same prompts, same params, same 3-attempt backoff.

export class RateLimitError extends Error {}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pace between Groq calls so a run stays under the free-tier rate limit
// instead of burning through it in the first few seconds. Matches the
// 2-second pacing AiSummaryService used in the original Java backend.
export const RATE_LIMIT_PACING_MS = 2000;

async function callGroq(env: Env, body: unknown): Promise<string | null> {
  const res = await fetch(env.GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    throw new RateLimitError(`Groq rate limit (429)`);
  }
  if (!res.ok) {
    throw new Error(`Groq API HTTP error: ${res.status}`);
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
      if (err instanceof RateLimitError) throw err; // propagate immediately, retrying won't help
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

export async function summarize(env: Env, content: string, language: string): Promise<string | null> {
  const trimmed = content.length > 3000 ? content.slice(0, 3000) : content;
  const langInstruction = language === "hi" ? "Respond in Hindi." : "Respond in English.";

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
