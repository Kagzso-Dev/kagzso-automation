import { env } from "../env.js";
import { logger } from "../logger.js";
import { prisma } from "../prisma.js";
import { deliverEmail } from "../domain/delivery.js";
import { PermanentSendError } from "../provider/index.js";
import { DeferJobError, PermanentJobError, QueueWorker } from "./engine.js";
import { QUEUE, type CampaignDispatchJob, type ContactImportJob, type SendEmailJob } from "./queues.js";
import { dailyCapReached, msUntilNextWindow } from "./dailyCap.js";
import { processManualBulkSend } from "./manualBulkSend.js";
import { processWhatsAppBulkSend } from "./whatsappBulkSend.js";
import { processAiCallRun } from "./aiCallRun.js";
import { processAiCallFollowup } from "./aiCallFollowup.js";
import { processWhatsAppMediaDownload } from "./whatsappMediaDownload.js";
import { processDataQuality } from "./dataQuality.js";
import { fanOutCampaign } from "./dispatch.js";
import { parseContactFile } from "../domain/contactImport.js";
import { domainAllowed, loadAllowedDomains } from "../domain/allowedDomains.js";

/* ----------------------------------------------------- send-email */

const sendEmailWorker = new QueueWorker({
  queue: QUEUE.sendEmail,
  batch: 25,
  // Rate limit: one send per (1000 / rate) ms. Default 1/sec (SEND_RATE_PER_SEC).
  minIntervalMs: Math.ceil(1000 / Math.max(1, env.SEND_RATE_PER_SEC)),
  backoffMs: env.SEND_BACKOFF_MS,
  pollMs: 1000,
  processor: async (payload) => {
    if (await dailyCapReached()) {
      const runAt = new Date(Date.now() + msUntilNextWindow());
      logger.warn({ runAt }, "daily cap reached — deferring send to next window");
      throw new DeferJobError(runAt);
    }
    try {
      return await deliverEmail(payload as unknown as SendEmailJob);
    } catch (err) {
      if (err instanceof PermanentSendError) throw new PermanentJobError(err.message);
      throw err; // TransientSendError and anything else → normal retry
    }
  },
});

/* ----------------------------------------------------- campaign-dispatch */

const campaignDispatchWorker = new QueueWorker({
  queue: QUEUE.campaignDispatch,
  batch: 5,
  backoffMs: 30_000,
  pollMs: 3000,
  processor: async (payload) => {
    const job = payload as unknown as CampaignDispatchJob;
    const runDate = job.runDate || new Date().toISOString().slice(0, 10);
    const enqueued = await fanOutCampaign(job.campaignId, runDate);
    return { enqueued };
  },
});

/* ----------------------------------------------------- manual-bulk-send (drip) */

const manualBulkSendWorker = new QueueWorker({
  queue: QUEUE.manualBulkSend,
  batch: 1, // one batch job at a time per tick; each job sends exactly one contact
  pollMs: 1000,
  backoffMs: 5000,
  processor: (payload) => processManualBulkSend(payload),
});

/* ----------------------------------------------------- whatsapp-bulk-send (drip) */

const whatsappBulkSendWorker = new QueueWorker({
  queue: QUEUE.whatsappBulkSend,
  batch: 1, // one batch job per tick; each job sends exactly one message
  pollMs: 1000,
  backoffMs: 5000,
  processor: (payload) => processWhatsAppBulkSend(payload),
});

/* ----------------------------------------------------- ai-call-run (sequential AI voice calls) */

const aiCallRunWorker = new QueueWorker({
  queue: QUEUE.aiCallRun,
  batch: 1,
  pollMs: 1000,
  backoffMs: 5000,
  processor: (payload) => processAiCallRun(payload),
});

/* ----------------------------------------------------- ai-call-followup (approved "call again") */

const aiCallFollowupWorker = new QueueWorker({
  queue: QUEUE.aiCallFollowup,
  batch: 1,
  pollMs: 5000,
  backoffMs: 30_000,
  processor: (payload) => processAiCallFollowup(payload),
});

/* ----------------------------------------------------- whatsapp-media-download (inbound media) */

const whatsappMediaDownloadWorker = new QueueWorker({
  queue: QUEUE.whatsappMediaDownload,
  batch: 2,
  pollMs: 2000,
  backoffMs: 15_000,
  processor: (payload) => processWhatsAppMediaDownload(payload),
});

/* ----------------------------------------------------- data-quality (AI score via the local Ollama only) */

const dataQualityWorker = new QueueWorker({
  queue: QUEUE.dataQuality,
  batch: 1, // one job per tick and one row per job run: never two Ollama requests at once
  pollMs: 2000,
  backoffMs: 15_000,
  processor: (payload) => processDataQuality(payload),
});

/* ----------------------------------------------------- contact-import (csv / xlsx / pdf) */

const contactImportWorker = new QueueWorker({
  queue: QUEUE.csvImport,
  batch: 1,
  pollMs: 2000,
  processor: async (payload) => {
    const job = payload as unknown as ContactImportJob;
    const parsed = await parseContactFile(Buffer.from(job.fileBase64, "base64"), job.format);
    const allowedDomains = await loadAllowedDomains();

    let created = 0;
    let updated = 0;
    let skipped = 0; // no usable email address
    let rejectedDomain = 0; // email domain not on the approved list
    for (const row of parsed) {
      const email = row.email.toLowerCase().trim();
      if (!email || !email.includes("@")) {
        skipped++;
        continue;
      }
      if (!domainAllowed(email, allowedDomains)) {
        rejectedDomain++;
        continue;
      }
      const data = {
        firstName: row.firstName || undefined,
        lastName: row.lastName || undefined,
        phone: row.phone || undefined,
        businessName: row.businessName || undefined,
        customFields: row.customFields,
      };
      const existing = await prisma.contact.findUnique({ where: { email } });
      const contact = await prisma.contact.upsert({
        where: { email },
        create: { email, ...data },
        update: data, // import = upsert on email (design §13)
      });
      if (existing) updated++;
      else created++;
      if (job.listId) {
        await prisma.listMembership.upsert({
          where: { listId_contactId: { listId: job.listId, contactId: contact.id } },
          create: { listId: job.listId, contactId: contact.id },
          update: {},
        });
      }
    }
    logger.info(
      { format: job.format, created, updated, skipped, rejectedDomain },
      "contact import complete",
    );
    return { created, updated, skipped, rejectedDomain, total: parsed.length };
  },
});

export function startAllWorkers(): QueueWorker[] {
  return [
    sendEmailWorker.start(),
    campaignDispatchWorker.start(),
    contactImportWorker.start(),
    manualBulkSendWorker.start(),
    whatsappBulkSendWorker.start(),
    aiCallRunWorker.start(),
    aiCallFollowupWorker.start(),
    whatsappMediaDownloadWorker.start(),
    dataQualityWorker.start(),
  ];
}
