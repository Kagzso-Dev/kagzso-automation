// Voice "Listen" previews for the Voice Call Flows editor. ADMIN and EDITOR, and 404 unless
// both ENABLE_AI_CALLS and ENABLE_CALL_FLOW_EDITOR are on (same gate as /api/call-flows).
//
//   POST /api/voices/preview   { voice_id, text } -> audio/wav of that voice saying the line
//
// Text-to-speech only: nothing is dialled and nothing is saved. The voice backend holds
// the provider key and the list of offered voices (an unknown voice is a 400 from it).
// Audio is cached per voice + text, so repeated clicks don't cost another provider call.

import { Router, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { isCallFlowEditorEnabled } from "../../config/aiCalls.js";
import { previewVoice, VoiceBackendError } from "../../services/voiceBackend.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { AppError, wrap } from "../errors.js";

export const voicesRouter = Router();
voicesRouter.use(authRequired);
voicesRouter.use((_req: Request, _res: Response, next: NextFunction) => {
  if (!isCallFlowEditorEnabled()) {
    return next(new AppError(404, "Call flows are disabled (set ENABLE_AI_CALLS and ENABLE_CALL_FLOW_EDITOR)", "not_found"));
  }
  next();
}, requireRole("ADMIN", "EDITOR"));

const previewLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
  message: { error: "Too many voice previews — wait a minute and try again.", code: "rate_limited" },
});

const previewInput = z.object({
  voice_id: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{0,63}$/, "Choose a voice"),
  text: z
    .string()
    .transform((s) => s.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1, "Enter a sample line").max(200, "The sample line can be at most 200 characters")),
});

/** Small in-memory LRU: voice + text → WAV. */
const CACHE_MAX = 64;
const cache = new Map<string, Buffer>();
function cached(key: string): Buffer | undefined {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // move to the newest end
    cache.set(key, hit);
  }
  return hit;
}
function remember(key: string, wav: Buffer) {
  cache.set(key, wav);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

voicesRouter.post(
  "/preview",
  previewLimiter,
  wrap(async (req, res) => {
    const { voice_id, text } = previewInput.parse(req.body ?? {});
    const key = `${voice_id}\u0000${text}`;
    let wav = cached(key);
    if (!wav) {
      try {
        wav = await previewVoice(voice_id, text);
      } catch (err) {
        if (err instanceof VoiceBackendError) {
          const status = err.status !== null && err.status < 500 && err.status !== 429 ? 400 : 503;
          throw new AppError(status, err.message.replace(/^Voice backend \d+: /, ""), status === 400 ? "bad_request" : "unavailable");
        }
        throw err;
      }
      remember(key, wav);
    }
    res.type("audio/wav").set("Cache-Control", "private, max-age=3600").send(wav);
  }),
);
