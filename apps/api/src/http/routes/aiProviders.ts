// AI provider settings (Settings → AI providers): ADMIN only, every endpoint. Each language's voice
// backend keeps its own settings and encrypted API keys; this is an authenticated proxy to it
// (X-API-Key server-side, the admin's e-mail in X-Actor for its audit log). No key is ever returned.
//
//   GET  /api/ai-providers/:lang                        settings (masked)
//   PUT  /api/ai-providers/:lang/providers/:id          { enabled?, model?, options?, api_key?, remove_key?, confirm? }
//   PUT  /api/ai-providers/:lang/selection              { live?, llm_order?, confirm? }
//   POST /api/ai-providers/:lang/providers/:id/test     one small real request (uses a little API credit)
//   POST /api/ai-providers/:lang/reencrypt              saved keys -> the backend's current encryption key

import { Router, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import {
  AI_CALL_LANGUAGE_NAMES,
  AI_PROVIDER_IDS,
  aiCallLanguage,
  aiProviderSelectionInput,
  aiProviderUpdateInput,
  type AiCallLanguage,
} from "@dispatch/shared";
import { voiceBackendFor } from "../../config/aiCalls.js";
import { logger } from "../../logger.js";
import {
  getAiProviderSettings,
  reencryptAiProviderKeys,
  testAiProvider,
  updateAiProvider,
  updateAiProviderSelection,
  VoiceBackendError,
} from "../../services/voiceBackend.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { AppError, wrap } from "../errors.js";

export const aiProvidersRouter = Router();
aiProvidersRouter.use(authRequired, requireRole("ADMIN"));
aiProvidersRouter.use((_req: Request, res: Response, next: NextFunction) => {
  res.set("Cache-Control", "no-store");
  next();
});

const testLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
  message: { error: "Too many connection tests — wait a minute and try again.", code: "rate_limited" },
});

const providerId = z.enum(AI_PROVIDER_IDS);

/** The language from the URL, and only when its voice backend is set up. */
function language(req: Request): AiCallLanguage {
  const lang = aiCallLanguage.safeParse(req.params.lang);
  if (!lang.success) throw new AppError(404, "Unknown language", "not_found");
  if (!voiceBackendFor(lang.data)) {
    throw new AppError(404, `The ${AI_CALL_LANGUAGE_NAMES[lang.data]} voice backend is not set up`, "not_found");
  }
  return lang.data;
}

/** Voice backend errors as the page shows them: its 4xx (validation, confirmations) pass through. */
async function proxied<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof VoiceBackendError) {
      const message = err.message.replace(/^Voice backend \d+: /, "");
      if (err.status !== null && err.status < 500 && err.status !== 429 && err.status !== 401) {
        throw new AppError(err.status === 422 ? 400 : err.status, message, err.code ?? "bad_request");
      }
      throw new AppError(503, err.status === 503 ? message : "The voice backend could not be reached or failed - try again", err.code ?? "unavailable");
    }
    throw err;
  }
}

aiProvidersRouter.get(
  "/:lang",
  wrap(async (req, res) => {
    res.json(await proxied(() => getAiProviderSettings(language(req))));
  }),
);

aiProvidersRouter.put(
  "/:lang/providers/:id",
  wrap(async (req, res) => {
    const lang = language(req);
    const id = providerId.parse(req.params.id);
    const body = aiProviderUpdateInput.parse(req.body ?? {});
    const change = { ...body, ...(body.api_key?.trim() ? { api_key: body.api_key.trim() } : { api_key: undefined }) };
    const view = await proxied(() => updateAiProvider(lang, id, change, req.user!.email));
    logger.info(
      { adminId: req.user!.id, language: lang, provider: id, fields: Object.keys(body).filter((k) => k !== "api_key"),
        key: change.api_key ? "replaced" : body.remove_key ? "removed" : undefined },
      "AI provider settings changed",
    );
    res.json(view);
  }),
);

aiProvidersRouter.put(
  "/:lang/selection",
  wrap(async (req, res) => {
    const lang = language(req);
    const body = aiProviderSelectionInput.parse(req.body ?? {});
    const view = await proxied(() => updateAiProviderSelection(lang, body, req.user!.email));
    logger.info({ adminId: req.user!.id, language: lang, fields: Object.keys(body) }, "AI provider selection changed");
    res.json(view);
  }),
);

aiProvidersRouter.post(
  "/:lang/providers/:id/test",
  testLimiter,
  wrap(async (req, res) => {
    const lang = language(req);
    const id = providerId.parse(req.params.id);
    const view = await proxied(() => testAiProvider(lang, id, req.user!.email));
    logger.info({ adminId: req.user!.id, language: lang, provider: id, result: view.test?.status }, "AI provider tested");
    res.json(view);
  }),
);

aiProvidersRouter.post(
  "/:lang/reencrypt",
  wrap(async (req, res) => {
    const lang = language(req);
    res.json(await proxied(() => reencryptAiProviderKeys(lang, req.user!.email)));
  }),
);
