import type { Env } from "./types";
import { translateGroq, RateLimitError } from "./groq";

// Cloudflare Workers AI fallback model — much smaller (8B) than Groq's
// translateGroq model (see groq.ts's GROQ_API_MODEL, currently
// llama-3.3-70b-versatile), used only once Groq's quota for this run is
// exhausted (see translateWithFallback below). Same model already proven
// working for the Cloudflare summarization fallback, see cfSummarize.ts.
const CLOUDFLARE_TRANSLATE_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

// Maps our internal RSS language codes (see feeds.ts RSS_FEEDS) to the
// language names used in the translation prompt.
const LANGUAGE_NAMES: Record<string, string> = {
  ur: "Urdu",
  hi: "Hindi",
  en: "English",
};

// Unicode script ranges for each source language we translate from. Used to
// catch a "translation" that's actually just the original text echoed back
// unchanged (or only partially translated) — both Groq and Cloudflare have
// been observed doing this occasionally, and since the caller only checked
// "did I get a non-empty string back," a silent no-op translation used to
// get treated as success and permanently marked `language: "en"` with the
// native text still showing.
const SCRIPT_RANGES: Record<string, RegExp> = {
  ur: /[؀-ۿ]/, // Arabic script, used for Urdu
  hi: /[ऀ-ॿ]/, // Devanagari, used for Hindi
};

export function looksTranslated(text: string, language: string): boolean {
  const scriptPattern = SCRIPT_RANGES[language];
  return !scriptPattern || !scriptPattern.test(text);
}

function buildPrompt(sourceLang: string): string {
  return (
    `Translate the following ${sourceLang} text to English. Preserve names of people, places, ` +
    "and organizations as accurately as possible. If you are not fully certain of the correct " +
    "English spelling of a name, transliterate it phonetically from the original script rather " +
    "than substituting a different real name or place you happen to recognize. Return only the " +
    "translated text, with no notes, explanations, or quotation marks around it."
  );
}

async function translateWithCloudflare(env: Env, text: string, sourceLang: string): Promise<string | null> {
  try {
    const result = (await env.AI.run(CLOUDFLARE_TRANSLATE_MODEL, {
      messages: [
        { role: "system", content: buildPrompt(sourceLang) },
        { role: "user", content: text },
      ],
    })) as { response?: string };
    return result.response?.trim() || null;
  } catch (err) {
    console.error(`Translate: Cloudflare error | ${(err as Error).message}`);
    return null;
  }
}

// Tries Groq first (llama-3.3-70b-versatile, same model already used for
// summarization) — its much larger parameter count carries far more
// real-world knowledge of names/places than Cloudflare's 8B fallback model,
// which regularly mangled proper nouns (e.g. "Mohammad Nawaz" -> "Mohammed
// Nasr", "Strait of Hormuz" -> "Horus"). Falls back to Cloudflare Workers AI
// once Groq's rate limit is hit this run, mirroring summarizeWithFallback in
// index.ts. `groqState` is shared with summarization within the same
// pipeline run so both lanes agree on whether Groq is still available,
// rather than each rediscovering the same 429 independently.
export async function translateWithFallback(
  env: Env,
  text: string,
  language: string,
  groqState: { rateLimited: boolean },
): Promise<string | null> {
  const sourceLang = LANGUAGE_NAMES[language];
  if (!sourceLang || sourceLang === "English") return null;

  if (!groqState.rateLimited) {
    try {
      const translated = await translateGroq(env, text, sourceLang);
      if (translated) {
        if (looksTranslated(translated, language)) return translated;
        console.warn(`Translate: Groq returned untranslated/mixed-script text, falling back | language=${language}`);
      }
    } catch (err) {
      if (err instanceof RateLimitError) {
        groqState.rateLimited = true;
      } else {
        console.error(`Translate: Groq error | ${(err as Error).message}`);
      }
    }
  }

  const cfTranslated = await translateWithCloudflare(env, text, sourceLang);
  if (cfTranslated && !looksTranslated(cfTranslated, language)) {
    console.warn(`Translate: Cloudflare returned untranslated/mixed-script text | language=${language}`);
    return null;
  }
  return cfTranslated;
}
