import type { Env } from "./types";

// Second, independent summarization lane on Cloudflare Workers AI — a
// separate free-tier quota from Groq entirely (same account already used for
// BBC Urdu translation, see translate.ts), used as a fallback once Groq's
// per-minute token budget is exhausted for the run instead of leaving an
// article pending until the next hourly cycle.
const CF_SUMMARY_MODEL = "@cf/meta/llama-3.1-8b-instruct";

// Mirrors groq.ts's LANGUAGE_INSTRUCTIONS so a Cloudflare-summarized article
// reads the same as a Groq-summarized one from the same source.
const LANGUAGE_INSTRUCTIONS: Record<string, string> = {
  hi: "Respond in Hindi.",
  ur: "Respond in Urdu.",
};

export async function summarizeWithCloudflare(
  env: Env,
  content: string,
  language: string,
): Promise<string | null> {
  const trimmed = content.length > 3000 ? content.slice(0, 3000) : content;
  const langInstruction = LANGUAGE_INSTRUCTIONS[language] ?? "Respond in English.";

  try {
    const result = (await env.AI.run(CF_SUMMARY_MODEL, {
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
    })) as { response?: string };
    return result.response?.trim() || null;
  } catch (err) {
    console.error(`CF Summarize: Error | ${(err as Error).message}`);
    return null;
  }
}
