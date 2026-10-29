import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { pinoHttp } from "pino-http";
import { randomUUID } from "node:crypto";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { uploadsRoot } from "../domain/imageUpload.js";
import { errorHandler, wrap } from "./errors.js";
import { getBranding } from "../domain/branding.js";
import { securityHeaders } from "./securityHeaders.js";
import { authRouter } from "./routes/auth.js";
import { contactsRouter } from "./routes/contacts.js";
import { whatsappRouter } from "./routes/whatsapp.js";
import { whatsappMediaRouter } from "./routes/whatsappMedia.js";
import { whatsappTemplateSyncRouter } from "./routes/whatsappTemplateSync.js";
import { callCostByFlowRouter } from "./routes/callCostByFlow.js";
import { listsRouter } from "./routes/lists.js";
import { templatesRouter } from "./routes/templates.js";
import { campaignsRouter } from "./routes/campaigns.js";
import { triggersRouter } from "./routes/triggers.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { whatsappWebhookRouter } from "./routes/whatsappWebhook.js";
import { trackRouter } from "./routes/track.js";
import { unsubscribeRouter } from "./routes/unsubscribe.js";
import { apiKeysRouter } from "./routes/apiKeys.js";
import { usersRouter } from "./routes/users.js";
import { healthRouter } from "./routes/health.js";
import { statsRouter } from "./routes/stats.js";
import { jobsRouter } from "./routes/jobs.js";
import { settingsRouter } from "./routes/settings.js";
import { aiCallsRouter } from "./routes/aiCalls.js";
import { aiCallRecordingsRouter } from "./routes/aiCallRecordings.js";
import { aiCallWebhookRouter } from "./routes/aiCallWebhook.js";
import { callFlowsRouter } from "./routes/callFlows.js";
import { voicesRouter } from "./routes/voices.js";
import { aiProvidersRouter } from "./routes/aiProviders.js";
import { aiCallCustomersRouter } from "./routes/aiCallCustomers.js";
import { aiCallFollowupsRouter } from "./routes/aiCallFollowups.js";
import { historyFilterRouter } from "./routes/historyFilter.js";
import { sendQueueHistoryRouter } from "./routes/sendQueueHistory.js";
import { dataQualityRouter } from "./routes/dataQuality.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(securityHeaders);

  app.use((req, _res, next) => {
    req.id = (req.headers["x-request-id"] as string) || randomUUID();
    next();
  });
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).id,
      autoLogging: { ignore: (req) => req.url === "/health" },
    }),
  );
  app.use(cors({ origin: env.WEB_ORIGIN.split(","), credentials: true }));
  app.use(cookieParser());
  // Meta WhatsApp webhook needs the raw body for its HMAC signature, so it is
  // mounted before the JSON parser (it parses the body itself once verified).
  app.use("/api/webhooks/whatsapp", whatsappWebhookRouter);
  // AI-call status callbacks are HMAC-signed over the raw body too.
  app.use("/api/webhooks/ai-calls", aiCallWebhookRouter);
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false }));

  // Uploaded template images — immutable, content-addressed filenames.
  app.use(
    "/uploads",
    express.static(uploadsRoot(), { index: false, maxAge: "365d", immutable: true }),
  );

  app.use("/health", healthRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/contacts", contactsRouter);
  app.use("/api/whatsapp", whatsappTemplateSyncRouter);
  app.use("/api/whatsapp", whatsappRouter);
  app.use("/api/whatsapp", whatsappMediaRouter);
  app.use("/api/lists", listsRouter);
  app.use("/api/templates", templatesRouter);
  app.use("/api/campaigns", campaignsRouter);
  app.use("/api/triggers", triggersRouter);
  app.use("/api/webhooks", webhooksRouter);
  app.use("/api/track", trackRouter);
  app.use("/api/unsubscribe", unsubscribeRouter);
  app.use("/api/api-keys", apiKeysRouter);
  app.use("/api/users", usersRouter); // admin-only user management
  app.use("/api/jobs", jobsRouter);
  // Public, read-only: just the display app name (Settings → Branding) so the
  // login page can show it. Same data as GET /api/settings/branding.
  app.get(
    "/api/branding",
    wrap(async (_req, res) => {
      const { labels, customized } = await getBranding();
      res.json({ labels: { appName: labels.appName }, customized });
    }),
  );
  app.use("/api/settings", settingsRouter);
  app.use("/api/ai-calls", aiCallRecordingsRouter); // recordings: ADMIN only, own paths
  app.use("/api/ai-calls", aiCallsRouter);
  app.use("/api/call-flows", callFlowsRouter);
  app.use("/api/voices", voicesRouter); // "Listen" voice previews (text-to-speech only, never a call)
  app.use("/api/ai-providers", aiProvidersRouter); // admin only; per-language voice backend provider settings
  app.use("/api/ai-call-customers", aiCallCustomersRouter);
  app.use("/api/ai-call-followups", aiCallFollowupsRouter);
  app.use("/api/send-queue/filter", historyFilterRouter); // read-only "filter new data"
  app.use("/api/send-queue/history", sendQueueHistoryRouter); // read-only "download all history"
  app.use("/api/data-quality", dataQualityRouter); // admin only; staging tables + local Ollama only
  app.use("/api", callCostByFlowRouter);
  app.use("/api", statsRouter);

  app.use(errorHandler);
  return app;
}
