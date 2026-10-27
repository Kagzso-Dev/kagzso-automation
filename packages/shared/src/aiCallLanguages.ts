import { z } from "zod";

/* ------------------------------------------------------------------ AI call languages */
// One voice backend per language: the same voice backend code, each with its own .env
// (CALL_LANGUAGE, port, database). English is the original backend (VOICE_BACKEND_URL);
// another language is available once the API has VOICE_BACKEND_URL_<CODE>, e.g.
// VOICE_BACKEND_URL_TA. Each language has its own call flows and customer list, and a call
// uses one language from start to end. Codes are the voice backend's CALL_LANGUAGE codes.

export const AI_CALL_LANGUAGES = ["en", "ta", "hi", "kn", "te", "ml", "mr", "gu", "bn", "pa", "od"] as const;
export type AiCallLanguage = (typeof AI_CALL_LANGUAGES)[number];

export const DEFAULT_AI_CALL_LANGUAGE: AiCallLanguage = "en";

/**
 * Languages whose pages always exist (menu "Calls · Tamil", …), even before their voice backend is
 * set up: there they show a "not set up yet" notice and can't call. Any other language appears once
 * its VOICE_BACKEND_URL_<CODE> is set. An admin can switch each one off in Settings.
 */
export const AI_CALL_STANDARD_LANGUAGES: readonly AiCallLanguage[] = ["en", "ta", "hi", "kn"];

export const AI_CALL_LANGUAGE_NAMES: Record<AiCallLanguage, string> = {
  en: "English",
  ta: "Tamil",
  hi: "Hindi",
  kn: "Kannada",
  te: "Telugu",
  ml: "Malayalam",
  mr: "Marathi",
  gu: "Gujarati",
  bn: "Bengali",
  pa: "Punjabi",
  od: "Odia",
};

/** Default line for the voice "Listen" button, in that language (editable in the page). */
export const AI_CALL_VOICE_SAMPLES: Record<AiCallLanguage, string> = {
  en: "Hello, am I speaking with Ragul?",
  ta: "Hello, Ragul sir-கிட்ட தான் பேசறேனா?",
  hi: "Hello, क्या मेरी बात Ragul जी से हो रही है?",
  kn: "Hello, ನಾನು Ragul ಅವರ ಜೊತೆ ಮಾತಾಡ್ತಿದೀನಾ?",
  te: "Hello, నేను Ragul గారితో మాట్లాడుతున్నానా?",
  ml: "Hello, ഞാൻ Ragul-നോടാണോ സംസാരിക്കുന്നത്?",
  mr: "Hello, मी Ragul यांच्याशी बोलत आहे का?",
  gu: "Hello, શું હું Ragul સાથે વાત કરી રહી છું?",
  bn: "Hello, আমি কি Ragul-এর সাথে কথা বলছি?",
  pa: "Hello, ਕੀ ਮੈਂ Ragul ਨਾਲ ਗੱਲ ਕਰ ਰਹੀ ਹਾਂ?",
  od: "Hello, ମୁଁ Ragul ଙ୍କ ସହ କଥା ହେଉଛି କି?",
};

export const aiCallLanguage = z.enum(AI_CALL_LANGUAGES);

/** `?language=ta` on list endpoints; absent = English (every caller from before languages existed). */
export const aiCallLanguageQuery = z.object({ language: aiCallLanguage.default(DEFAULT_AI_CALL_LANGUAGE) });

export function isAiCallLanguage(v: unknown): v is AiCallLanguage {
  return typeof v === "string" && (AI_CALL_LANGUAGES as readonly string[]).includes(v);
}

/** The language's address for a page: English keeps the original ("/call-flows"), others get a prefix ("/ta/call-flows"). */
export function aiCallLanguagePath(language: AiCallLanguage, path: string): string {
  return language === DEFAULT_AI_CALL_LANGUAGE ? path : `/${language}${path}`;
}

/** "/ta/call-flows" → { language: "ta", path: "/call-flows" }; any other path is English and unchanged. */
export function splitAiCallLanguagePath(path: string): { language: AiCallLanguage; path: string } {
  const m = /^\/([a-z]{2})(\/.*)$/.exec(path);
  if (m && m[1] !== DEFAULT_AI_CALL_LANGUAGE && isAiCallLanguage(m[1])) return { language: m[1], path: m[2]! };
  return { language: DEFAULT_AI_CALL_LANGUAGE, path };
}

/** One language's place in Dispatch (GET /api/ai-calls/config, Settings → AI call languages). */
export interface AiCallLanguageInfo {
  code: AiCallLanguage;
  name: string;
  /**
   * Its voice backend address is set on the API (English: VOICE_BACKEND_URL; others VOICE_BACKEND_URL_<CODE>).
   * False on a standard language whose backend isn't set up yet: its pages show, but it can't call.
   */
  configured: boolean;
  /** Not switched off by an admin in Settings. English can't be switched off. */
  enabled: boolean;
}

export const setAiCallLanguageInput = z.object({ enabled: z.boolean() }).strict();
