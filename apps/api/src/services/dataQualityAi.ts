// AI score client for Data Quality — the ONLY network code of the Data Quality module.
// One service at a time, chosen by DATA_QUALITY_AI_PROVIDER (config/dataQuality.ts):
//   ollama  local server (this machine only)   GET /api/tags, POST /api/generate
//   groq    https://api.groq.com                GET /openai/v1/models, POST /openai/v1/chat/completions
//   gemini  https://generativelanguage.googleapis.com
//                                               GET /v1beta/models/<model>, POST /v1beta/models/<model>:generateContent
//
// Guard: every URL is built here from that service's origin and one of its two paths; anything
// else throws before a socket is opened. Keys go in headers only (never in a URL or a log).
// One request at a time (a promise chain), each with a timeout.

import { dataQualityConfig, PROVIDER_LABELS, type AiProvider, type AiSettings } from "../config/dataQuality.js";

export class AiError extends Error {
  constructor(
    message: string,
    /** The service said "too many requests": wait and try the same row again. */
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "AiError";
  }
}

/** The two paths each service may be called on (the model is part of Gemini's paths). */
export function allowedPaths(provider: AiProvider, model: string | null): string[] {
  if (provider === "ollama") return ["/api/tags", "/api/generate"];
  if (provider === "groq") return ["/openai/v1/models", "/openai/v1/chat/completions"];
  return model ? [`/v1beta/models/${model}`, `/v1beta/models/${model}:generateContent`] : [];
}

/** The one URL a request may go to; throws for an unusable setting or any other path. */
export function aiUrl(path: string, settings: AiSettings = dataQualityConfig.ai): string {
  if (!settings.origin || settings.problem) throw new AiError(settings.problem ?? "AI scoring is not configured");
  if (!allowedPaths(settings.provider, settings.model).includes(path)) throw new AiError(`Path not allowed for ${PROVIDER_LABELS[settings.provider]}: ${path}`);
  const url = new URL(path, settings.origin);
  if (url.origin !== settings.origin) throw new AiError("AI request blocked: wrong host");
  return url.toString();
}

let chain: Promise<unknown> = Promise.resolve();

/** Run `fn` after every earlier AI request has finished (never two at once). */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

function authHeaders(s: AiSettings): Record<string, string> {
  if (s.provider === "groq") return { Authorization: `Bearer ${s.apiKey}` };
  if (s.provider === "gemini") return { "x-goog-api-key": s.apiKey ?? "" };
  return {};
}

function errorText(body: unknown, fallback: string): string {
  const e = (body as { error?: unknown } | null)?.error;
  if (typeof e === "string") return e.slice(0, 200);
  const msg = (e as { message?: unknown } | null)?.message;
  return typeof msg === "string" ? msg.slice(0, 200) : fallback;
}

async function request(path: string, init: RequestInit, timeoutMs: number, s: AiSettings): Promise<unknown> {
  const url = aiUrl(path, s);
  const label = PROVIDER_LABELS[s.provider];
  return exclusive(async () => {
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), ...authHeaders(s) }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const why = err instanceof Error && err.name === "TimeoutError" ? `no reply within ${Math.round(timeoutMs / 1000)}s` : err instanceof Error ? err.message : String(err);
      throw new AiError(`${label} unreachable: ${why}`);
    }
    const body = await res.json().catch(() => null);
    if (res.status === 429) {
      const after = Number.parseFloat(res.headers.get("retry-after") ?? "");
      throw new AiError(`${label} rate limit reached`, Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 300_000) : 30_000);
    }
    if (!res.ok) throw new AiError(`${label} ${res.status}: ${errorText(body, res.statusText)}`);
    return body;
  });
}

export interface AiHealth {
  provider: AiProvider;
  configured: boolean;
  available: boolean;
  model: string | null;
  /** Shown as "<service> not available: <reason>"; null when available. */
  reason: string | null;
}

async function probe(s: AiSettings): Promise<AiHealth> {
  const base = { provider: s.provider, configured: true, model: s.model };
  if (s.provider === "ollama") {
    const body = (await request("/api/tags", { method: "GET" }, 3000, s)) as { models?: { name?: string }[] } | null;
    const names = (body?.models ?? []).map((m) => String(m.name ?? ""));
    const want = s.model!;
    const found = names.some((n) => n === want || n === `${want}:latest` || n.split(":")[0] === want);
    return found ? { ...base, available: true, reason: null } : { ...base, available: false, reason: `model "${want}" is not pulled (run: ollama pull ${want})` };
  }
  if (s.provider === "groq") {
    const body = (await request("/openai/v1/models", { method: "GET" }, 8000, s)) as { data?: { id?: string }[] } | null;
    const found = (body?.data ?? []).some((m) => m.id === s.model);
    return found ? { ...base, available: true, reason: null } : { ...base, available: false, reason: `model "${s.model}" is not offered by Groq for this key` };
  }
  await request(`/v1beta/models/${s.model}`, { method: "GET" }, 8000, s); // 404 / 403 → AiError
  return { ...base, available: true, reason: null };
}

const CLOUD_HEALTH_TTL_MS = 60_000;
let cached: { key: string; at: number; health: AiHealth } | null = null;

/** Is the service usable with these settings? Never throws. Cloud answers are cached for a minute. */
export async function checkAi(s: AiSettings = dataQualityConfig.ai): Promise<AiHealth> {
  if (s.problem) return { provider: s.provider, configured: false, available: false, model: s.model, reason: s.problem };
  const key = `${s.provider}|${s.origin}|${s.model}`;
  if (s.provider !== "ollama" && cached?.key === key && Date.now() - cached.at < CLOUD_HEALTH_TTL_MS) return cached.health;
  let health: AiHealth;
  try {
    health = await probe(s);
  } catch (err) {
    health = { provider: s.provider, configured: true, available: false, model: s.model, reason: err instanceof Error ? err.message : String(err) };
  }
  cached = { key, at: Date.now(), health };
  return health;
}

/** Forget the cached cloud health (tests). */
export function resetAiHealthCache(): void {
  cached = null;
}

/** One generation that must answer with a JSON object; returns it parsed. Throws AiError. */
export async function generateJson(prompt: string, s: AiSettings = dataQualityConfig.ai): Promise<unknown> {
  const json = { "Content-Type": "application/json" };
  let text = "";
  if (s.provider === "ollama") {
    const body = (await request(
      "/api/generate",
      {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          model: s.model,
          prompt,
          stream: false,
          format: "json",
          // Thinking models (qwen3, …) would otherwise spend the whole answer budget thinking and
          // return an empty response; models without thinking ignore it.
          think: false,
          options: { temperature: 0, num_predict: 200 },
        }),
      },
      s.timeoutMs,
      s,
    )) as { response?: unknown } | null;
    text = typeof body?.response === "string" ? body.response : "";
  } else if (s.provider === "groq") {
    const body = (await request(
      "/openai/v1/chat/completions",
      {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          model: s.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          max_completion_tokens: 300,
          response_format: { type: "json_object" },
        }),
      },
      s.timeoutMs,
      s,
    )) as { choices?: { message?: { content?: unknown } }[] } | null;
    const content = body?.choices?.[0]?.message?.content;
    text = typeof content === "string" ? content : "";
  } else {
    const body = (await request(
      `/v1beta/models/${s.model}:generateContent`,
      {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          // Room for a thinking model's own thinking before the short JSON answer.
          generationConfig: { temperature: 0, maxOutputTokens: 1024, responseMimeType: "application/json" },
        }),
      },
      s.timeoutMs,
      s,
    )) as { candidates?: { content?: { parts?: { text?: unknown; thought?: unknown }[] } }[]; promptFeedback?: { blockReason?: string } } | null;
    if (body?.promptFeedback?.blockReason) throw new AiError(`Gemini blocked the row: ${body.promptFeedback.blockReason}`);
    text = (body?.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError(`${PROVIDER_LABELS[s.provider]} did not answer with JSON`);
  }
}
