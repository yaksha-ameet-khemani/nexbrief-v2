import type { Env } from "./types";

// LLM-prompted translation, not Workers AI's dedicated NMT model
// (m2m100-1.2b) — m2m100 turned out to regularly invent nonsense for
// real-world proper nouns it doesn't recognize (e.g. "Ziarat, Balochistan"
// became "Zirconia, Belgrade"; "Mohammad Nawaz" came out as three different
// garbled names across one article's title/description). Instruct LLMs carry
// real-world/language knowledge a small dedicated NMT model doesn't, so
// they're far less likely to mangle names and places. Same model already
// used for the Cloudflare summarization fallback (see cfSummarize.ts) — same
// free Workers AI quota, already confirmed working on this account, no new
// cost.
const TRANSLATE_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

// Maps our internal RSS language codes (see feeds.ts RSS_FEEDS) to the
// language names used in the translation prompt.
const LANGUAGE_NAMES: Record<string, string> = {
  ur: "Urdu",
  hi: "Hindi",
  en: "English",
};

export async function translateToEnglish(env: Env, text: string, language: string): Promise<string | null> {
  const sourceLang = LANGUAGE_NAMES[language];
  if (!sourceLang || sourceLang === "English") return null;

  try {
    const result = (await env.AI.run(TRANSLATE_MODEL, {
      messages: [
        {
          role: "system",
          content:
            `Translate the following ${sourceLang} text to English. Preserve names of people, places, ` +
            "and organizations as accurately as possible — do not invent or guess at unfamiliar names. " +
            "Return only the translated text, with no notes, explanations, or quotation marks around it.",
        },
        { role: "user", content: text },
      ],
    })) as { response?: string };
    return result.response?.trim() || null;
  } catch (err) {
    console.error(`Translate: Error | ${(err as Error).message}`);
    return null;
  }
}
