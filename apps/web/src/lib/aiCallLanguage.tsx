import { createContext, useContext, type ReactNode } from "react";
import { AI_CALL_LANGUAGE_NAMES, DEFAULT_AI_CALL_LANGUAGE, type AiCallLanguage } from "@dispatch/shared";
import { useAiCallsConfig } from "./aiCalls";

/**
 * The AI call language of the page being shown: English on /call-flows and
 * /ai-call-customers (as before), another language on /ta/call-flows, /hi/... (App's
 * LanguageRoute). Each language has its own voice backend, call flows and customer list,
 * so every AI call request on such a page carries its language.
 */
const LanguageContext = createContext<AiCallLanguage>(DEFAULT_AI_CALL_LANGUAGE);

export function AiCallLanguageProvider({ language, children }: { language: AiCallLanguage; children: ReactNode }) {
  return <LanguageContext.Provider value={language}>{children}</LanguageContext.Provider>;
}

export function useAiCallLanguage(): AiCallLanguage {
  return useContext(LanguageContext);
}

export const isEnglish = (language: AiCallLanguage) => language === DEFAULT_AI_CALL_LANGUAGE;

/**
 * Whether this page's language can call: its voice backend is set up on the API. English follows
 * VOICE_BACKEND_URL as before; Tamil, Hindi and Kannada have pages before their backend exists,
 * and those pages say so instead of calling.
 */
export function useLanguageReady(): { language: AiCallLanguage; ready: boolean } {
  const language = useAiCallLanguage();
  const config = useAiCallsConfig().data;
  const info = config?.languages?.find((l) => l.code === language);
  return { language, ready: isEnglish(language) ? !!config?.configured : !!info?.configured };
}

/** "language=ta" for another language, "" for English: English requests stay exactly as before. */
export function languageParam(language: AiCallLanguage): string {
  return isEnglish(language) ? "" : `language=${language}`;
}

/** `path` with ?language= (or &language=) added for another language; English paths unchanged. */
export function withLanguage(path: string, language: AiCallLanguage): string {
  const p = languageParam(language);
  return p ? `${path}${path.includes("?") ? "&" : "?"}${p}` : path;
}

/** "Voice Call Flows · Tamil" for another language, the plain title for English. */
export function titleFor(title: string, language: AiCallLanguage): string {
  return isEnglish(language) ? title : `${title} · ${AI_CALL_LANGUAGE_NAMES[language]}`;
}
