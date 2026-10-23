/* ------------------------------------------------------------------ WhatsApp button replies */
// Display only: which quick-reply a customer tapped, as an Inbox badge
// ("Interested" / "Not now"). Nothing here changes a contact, stage, follow-up
// or send — the reply is stored exactly as Meta sent it.

export type ButtonReplyIntent = "interested" | "not_now";

export const BUTTON_REPLY_INTENT_LABELS: Record<ButtonReplyIntent, string> = {
  interested: "Interested",
  not_now: "Not now",
};

/** Lowercase, Unicode-normalised, punctuation and emoji dropped (Tamil vowel signs are kept). */
export function normalizeReplyText(s: string | null | undefined): string {
  return String(s ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Whole-reply matches only, so "not interested" is never read as "interested".
const PHRASES: Record<ButtonReplyIntent, string[]> = {
  not_now: [
    "not now", "not interested", "no", "no thanks", "no thank you", "later", "maybe later", "not now thanks",
    "இப்போது வேண்டாம்", "இப்ப வேண்டாம்", "இப்போ வேண்டாம்", "வேண்டாம்", "ஆர்வம் இல்லை", "விருப்பம் இல்லை", "பிறகு", "பின்னர்",
  ],
  interested: [
    "interested", "yes interested", "yes", "yes i am interested", "i am interested", "im interested", "i m interested",
    "ஆர்வம் உள்ளது", "ஆர்வமாக உள்ளது", "ஆர்வமாக உள்ளேன்", "ஆர்வம் இருக்கு", "ஆம்", "ஆமாம்", "விருப்பம் உள்ளது", "ஆம் ஆர்வம் உள்ளது",
  ],
};
const PHRASE_INTENT = new Map<string, ButtonReplyIntent>(
  (Object.entries(PHRASES) as [ButtonReplyIntent, string[]][]).flatMap(([intent, list]) => list.map((p) => [normalizeReplyText(p), intent] as const)),
);

/**
 * The intent of a tapped quick-reply button, or null when it can't be told.
 *  1. The button text (or payload) is a known English / Tamil phrase.
 *  2. Otherwise its position on the template that was replied to: the first
 *     button is Interested, the second Not now (any language).
 * Only button taps ("button" / "interactive") are labelled; typed text never is.
 */
export function classifyButtonReply(input: {
  messageType: string | null | undefined;
  text: string | null | undefined;
  payload?: string | null;
  /** Quick-reply labels of the template this replies to, in order (when known). */
  buttonLabels?: unknown;
}): ButtonReplyIntent | null {
  if (input.messageType !== "button" && input.messageType !== "interactive") return null;
  const candidates = [normalizeReplyText(input.text), normalizeReplyText(input.payload)].filter(Boolean);
  for (const c of candidates) {
    const hit = PHRASE_INTENT.get(c);
    if (hit) return hit;
  }
  const labels = Array.isArray(input.buttonLabels)
    ? input.buttonLabels.filter((x): x is string => typeof x === "string").map(normalizeReplyText)
    : [];
  for (const c of candidates) {
    const i = labels.indexOf(c);
    if (i === 0) return "interested";
    if (i === 1) return "not_now";
  }
  return null;
}
