// HTTP client for the local Ollama server — the ONLY network code of the Data Quality module.
//
// Guard: every request URL is built here from the configured origin (OLLAMA_BASE_URL, which
// config/dataQuality.ts only accepts on this machine) and one of two Ollama paths. Anything
// else throws before a socket is opened, so no uploaded record can go to another host.
// One request at a time (a promise chain), each with a timeout, to keep the voice server fast.

import { dataQualityConfig, type OllamaSettings } from "../config/dataQuality.js";

export const OLLAMA_PATHS = ["/api/tags", "/api/generate"] as const;
type OllamaPath = (typeof OLLAMA_PATHS)[number];

export class OllamaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaError";
  }
}

/** The one URL a request may go to; throws for an unset origin or any other path. */
export function ollamaUrl(path: string, settings: OllamaSettings = dataQualityConfig.ollama): string {
  if (!settings.origin) throw new OllamaError(settings.problem ?? "Ollama is not configured");
  if (!(OLLAMA_PATHS as readonly string[]).includes(path)) throw new OllamaError(`Path not allowed for Ollama: ${path}`);
  const url = new URL(path, settings.origin);
  if (url.origin !== settings.origin) throw new OllamaError("Ollama request blocked: wrong host");
  return url.toString();
}

let chain: Promise<unknown> = Promise.resolve();

/** Run `fn` after every earlier Ollama request has finished (never two at once). */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

async function request(path: OllamaPath, init: RequestInit, timeoutMs: number, settings: OllamaSettings): Promise<unknown> {
  const url = ollamaUrl(path, settings);
  return exclusive(async () => {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const why = err instanceof Error && err.name === "TimeoutError" ? `no reply within ${Math.round(timeoutMs / 1000)}s` : err instanceof Error ? err.message : String(err);
      throw new OllamaError(`Ollama unreachable: ${why}`);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (body as { error?: unknown } | null)?.error;
      throw new OllamaError(`Ollama ${res.status}: ${typeof msg === "string" ? msg.slice(0, 200) : res.statusText}`);
    }
    return body;
  });
}

export interface OllamaHealth {
  configured: boolean;
  available: boolean;
  model: string | null;
  /** Shown as "Ollama not available: <reason>"; null when available. */
  reason: string | null;
}

/** Is the server up and is OLLAMA_MODEL pulled? Never throws. */
export async function checkOllama(settings: OllamaSettings = dataQualityConfig.ollama): Promise<OllamaHealth> {
  if (settings.problem) return { configured: false, available: false, model: settings.model, reason: settings.problem };
  try {
    const body = (await request("/api/tags", { method: "GET" }, 3000, settings)) as { models?: { name?: string }[] } | null;
    const names = (body?.models ?? []).map((m) => String(m.name ?? ""));
    const want = settings.model!;
    const found = names.some((n) => n === want || n === `${want}:latest` || n.split(":")[0] === want);
    return found
      ? { configured: true, available: true, model: want, reason: null }
      : { configured: true, available: false, model: want, reason: `model "${want}" is not pulled (run: ollama pull ${want})` };
  } catch (err) {
    return { configured: true, available: false, model: settings.model, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** One non-streamed generation that must answer with JSON. Throws OllamaError. */
export async function generateJson(prompt: string, settings: OllamaSettings = dataQualityConfig.ollama): Promise<unknown> {
  const body = (await request(
    "/api/generate",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.model,
        prompt,
        stream: false,
        format: "json",
        // Thinking models (qwen3, …) would otherwise spend the whole answer budget thinking and
        // return an empty response; models without thinking ignore it.
        think: false,
        options: { temperature: 0, num_predict: 200 },
      }),
    },
    settings.timeoutMs,
    settings,
  )) as { response?: unknown } | null;
  const text = typeof body?.response === "string" ? body.response : "";
  try {
    return JSON.parse(text);
  } catch {
    throw new OllamaError("Ollama did not answer with JSON");
  }
}
