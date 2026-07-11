import type { Env } from "./types";

// Cloudflare Workers AI's m2m100 translation model, on the same Cloudflare
// account this whole project already runs on — a separate free-tier quota
// from Groq, so translating doesn't compete with summarization for quota.
const TRANSLATE_MODEL = "@cf/meta/m2m100-1.2b";

// Maps our internal RSS language codes (see feeds.ts RSS_FEEDS) to the
// language names this model expects.
const LANGUAGE_NAMES: Record<string, string> = {
  ur: "urdu",
  hi: "hindi",
  en: "english",
};

export async function translateToEnglish(env: Env, text: string, language: string): Promise<string | null> {
  const sourceLang = LANGUAGE_NAMES[language];
  if (!sourceLang || sourceLang === "english") return null;

  try {
    const result = (await env.AI.run(TRANSLATE_MODEL, {
      text,
      source_lang: sourceLang,
      target_lang: "english",
    })) as { translated_text?: string };
    return result.translated_text?.trim() || null;
  } catch (err) {
    console.error(`Translate: Error | ${(err as Error).message}`);
    return null;
  }
}
