/**
 * A business name with readable casing, for AI Agents only (the compiler's company name). The identity never changes and
 * nothing is stored: "KAGZSO TECHNOLOGY SERVICES", "kagzso technology services" and "kAgZsO TeChNoLoGy SeRvIcEs" all
 * read "Kagzso Technology Services". The same rules as the voice backend's business_display_name (llm_service.py),
 * checked on both sides by kagzso-voice-backend-english/tests/fixtures/business_display_cases.json:
 * - known brands and acronyms keep their spelling (Kagzso, WhatsApp, HMS, AI...); "it" is IT in capitals or before an
 *   IT word (Bright IT Solutions), else the word;
 * - an all-capitals word is a word when it can be said (4+ letters with a vowel, or SRI / THE ...), else an acronym;
 * - an all-lowercase word is capitalised (connectors such as "of" and "and" stay lowercase after the first word);
 * - a word in chaotic case (2+ lower-to-upper switches) is capitalised; mixed case on purpose (iPhone, McDonald) stays;
 * - letters touching a digit (24x7, 4G, B2B) and every other script stay exactly as written; spaces are tidied.
 */
const KNOWN_SPELLINGS: Record<string, string> = {
  kagzso: "Kagzso",
  whatsapp: "WhatsApp",
  iot: "IoT",
  ai: "AI",
  crm: "CRM",
  erp: "ERP",
  gst: "GST",
  sms: "SMS",
  hms: "HMS",
  bpo: "BPO",
  hr: "HR",
};
const IT_BEFORE = new Set([
  "solutions", "solution", "services", "service", "consulting", "consultancy", "consultants", "systems", "technologies",
  "park", "hub", "infra", "labs", "company", "academy", "training",
]);
const LOWER_CONNECTORS = new Set(["and", "of", "the", "for", "in", "on", "at", "by", "with", "to"]);
const SHORT_WORDS = new Set(["SRI", "SHRI", "NEW", "THE", "AND", "OM"]);

const isUpper = (w: string) => w === w.toUpperCase() && w !== w.toLowerCase();
const isLower = (w: string) => w === w.toLowerCase() && w !== w.toUpperCase();
const capitalize = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
const caseSwitches = (w: string) => [...w].slice(1).filter((c, i) => isLower(w[i]!) && isUpper(c)).length;
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

export function businessDisplayName(value: string | null | undefined): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const words = [...text.matchAll(/[A-Za-z]+/g)];
  let out = "";
  let last = 0;
  words.forEach((m, i) => {
    const w = m[0];
    const start = m.index!;
    const end = start + w.length;
    const k = w.toLowerCase();
    const next = words[i + 1]?.[0].toLowerCase() ?? "";
    let word: string;
    if (isDigit(text[start - 1]) || isDigit(text[end])) word = w;
    else if (k === "it") word = isUpper(w) || IT_BEFORE.has(next) ? "IT" : "It";
    else if (k in KNOWN_SPELLINGS) word = KNOWN_SPELLINGS[k]!;
    else if (isUpper(w)) word = SHORT_WORDS.has(w) || (w.length >= 4 && /[AEIOU]/.test(w)) ? capitalize(w) : w;
    else if (isLower(w)) word = i > 0 && LOWER_CONNECTORS.has(k) ? w : capitalize(w);
    else word = caseSwitches(w) >= 2 ? capitalize(w) : w;
    out += text.slice(last, start) + word;
    last = end;
  });
  return out + text.slice(last);
}
