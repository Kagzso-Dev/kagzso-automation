import type { AiCallLanguage } from "./aiCallLanguages.js";

/*
 * No built-in conversation instructions (removed 2026-11-26): a new agent starts with an empty "AI Conversation
 * Instructions" box in every language, and only what an admin writes there shapes how the agent talks. The safety,
 * refusal, do-not-call and truthfulness rules are the system's own (compiler + voice backend), never this box.
 */

/**
 * `{agent_name}`-style placeholders in an agent's instructions. The box fills none: the model would read them as they
 * are written. The agent's name comes from "AI executive name"; the customer's name is added to every call.
 */
export function instructionPlaceholders(text: string): string[] {
  return [...new Set(text.match(/\{+\s*[A-Za-z_][A-Za-z0-9_]*\s*\}+/g) ?? [])];
}

/**
 * True when a voice was made from a sample in another language than the agent's (its `source_language`, e.g. "en-IN",
 * when the voice backend knows it). Unknown = no mismatch.
 */
export function voiceLanguageMismatch(sourceLanguage: string | null | undefined, agentLanguage: AiCallLanguage): boolean {
  const base = (sourceLanguage ?? "").split("-")[0]!.trim().toLowerCase();
  return !!base && base !== agentLanguage;
}
