/* ------------------------------------------------------------------ Call Flows: language style */
// Non-English flows speak "mixed" (Tanglish / Hinglish / Kanglish: the language with everyday English
// words kept in English, what every call did before this setting) or "pure". Stored in the flow JSON as
// `language_style`; absent = "mixed". English flows have no style.

export type CallFlowLanguageStyle = "mixed" | "pure";

/** A flow's style; absent (every flow saved before the setting) = "mixed". */
export const languageStyleOf = (flow: { language_style?: CallFlowLanguageStyle }): CallFlowLanguageStyle =>
  flow.language_style ?? "mixed";

const MIXED_NAMES: Record<string, string> = { ta: "Tanglish", hi: "Hinglish", kn: "Kanglish" };
const LANGUAGE_WORD: Record<string, string> = { ta: "Tamil", hi: "Hindi", kn: "Kannada" };

/** "Tanglish (Tamil + everyday English)" / "Pure Tamil"; other languages get a generic name. */
export function languageStyleLabel(language: string, style: CallFlowLanguageStyle): string {
  const name = LANGUAGE_WORD[language] ?? language.toUpperCase();
  if (style === "pure") return `Pure ${name}`;
  return `${MIXED_NAMES[language] ?? "Mixed"} (${name} + everyday English)`;
}

/**
 * "Sample line to listen to" when the flow's own opening can't be shown, for a mixed-style flow (a pure
 * flow uses AI_CALL_VOICE_SAMPLES). Indic words in their script, English words in English letters, which
 * Sarvam's text-to-speech reads best. TODO(native-speaker review before release).
 */
export const AI_CALL_VOICE_SAMPLES_MIXED: Partial<Record<string, string>> = {
  ta: "Hello, Ragul sir-கிட்ட தான் பேசறேனா?",
  hi: "Hello, क्या मेरी बात Ragul सर से हो रही है?",
  kn: "Hello, ನಾನು Ragul sir ಜೊತೆ ಮಾತಾಡ್ತಿದೀನಾ?",
};

export interface MixedStarter {
  identity: { question: string; reask: string };
  silence: { reprompt: string; closing: string };
}

/**
 * Starter lines in the mixed style for the system-spoken lines, filled in only by "Use sample mixed text"
 * in a draft (never automatically). TODO(native-speaker review before release): every line below.
 */
export const CALL_FLOW_MIXED_STARTERS: Partial<Record<string, MixedStarter>> = {
  ta: {
    identity: { question: "{{customer_name}} {{title_to_use}}-கிட்ட தான் பேசறேனா?", reask: "Sorry, {{customer_name}}-கிட்ட தான் பேசறேனா?" },
    silence: { reprompt: "Hello, கேக்குதா? நான் பேசறது கேக்குதா?", closing: "பரவாயில்ல {{title_to_use}}. உங்க time-க்கு thanks. Have a nice day." },
  },
  hi: {
    identity: { question: "क्या मेरी बात {{customer_name}} {{title_to_use}} से हो रही है?", reask: "Sorry, क्या मेरी बात {{customer_name}} से हो रही है?" },
    silence: { reprompt: "Hello, क्या आपको मेरी आवाज़ आ रही है?", closing: "कोई बात नहीं {{title_to_use}}। आपके time के लिए thank you। Have a nice day." },
  },
  kn: {
    identity: { question: "ನಾನು {{customer_name}} {{title_to_use}} ಅವರ ಜೊತೆ ಮಾತಾಡ್ತಿದೀನಾ?", reask: "Sorry, ನಾನು {{customer_name}} ಅವರ ಜೊತೆನೇ ಮಾತಾಡ್ತಿದೀನಾ?" },
    silence: { reprompt: "Hello, ನನ್ನ ಮಾತು ಕೇಳಿಸ್ತಿದೆಯಾ?", closing: "ಪರವಾಗಿಲ್ಲ {{title_to_use}}. ನಿಮ್ಮ time-ಗೆ thanks. Have a nice day." },
  },
};
