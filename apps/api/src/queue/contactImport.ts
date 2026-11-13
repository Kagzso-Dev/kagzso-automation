// Contacts → Import file (csv / xlsx / pdf), run as a `csv-import` queue job. Import = upsert on
// email (design §13). Only the first IMPORT_MAX_ROWS data rows of a file are imported; the rest
// are counted (skippedOverLimit) for the Contacts page summary, never dropped silently.

import { logger } from "../logger.js";
import { prisma } from "../prisma.js";
import { domainAllowed, loadAllowedDomains } from "../domain/allowedDomains.js";
import { parseContactFile } from "../domain/contactImport.js";
import { IMPORT_MAX_ROWS, type ImportLimit } from "../domain/importLimit.js";
import type { ContactImportJob } from "./queues.js";

/** The job's result, read by GET /api/contacts/import/:jobId. created + updated + duplicates + failed = selectedRows. */
export interface ContactImportResult extends ImportLimit {
  /** New contacts. */
  created: number;
  /** Contacts that were already saved, updated from the file. */
  updated: number;
  /** Rows repeating an email from an earlier row of the file. Applied to that contact, as before. */
  duplicates: number;
  /** Rows without a usable email address. */
  skipped: number;
  /** Rows whose email domain is not on the approved sending list. */
  rejectedDomain: number;
  /** skipped + rejectedDomain: rows not imported. */
  failed: number;
  /** Selected rows that had an email address. */
  total: number;
}

export async function processContactImport(
  payload: Record<string, unknown>,
  maxRows: number = IMPORT_MAX_ROWS,
): Promise<ContactImportResult> {
  const job = payload as unknown as ContactImportJob;
  // A big file was read by the API already (only its first rows are here); a small one is read now.
  const { contacts, noEmail, limit } =
    job.parsed ?? (await parseContactFile(Buffer.from(job.fileBase64 ?? "", "base64"), job.format, maxRows));
  const allowedDomains = await loadAllowedDomains();

  let created = 0;
  let updated = 0;
  let duplicates = 0;
  let skipped = noEmail; // no usable email address
  let rejectedDomain = 0; // email domain not on the approved list
  const seen = new Set<string>();
  for (const row of contacts) {
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
    const repeated = seen.has(email);
    seen.add(email);
    const existing = repeated ? null : await prisma.contact.findUnique({ where: { email } });
    const contact = await prisma.contact.upsert({
      where: { email },
      create: { email, ...data },
      update: data, // import = upsert on email (design §13)
    });
    if (repeated) duplicates++;
    else if (existing) updated++;
    else created++;
    if (job.listId) {
      await prisma.listMembership.upsert({
        where: { listId_contactId: { listId: job.listId, contactId: contact.id } },
        create: { listId: job.listId, contactId: contact.id },
        update: {},
      });
    }
  }
  const result: ContactImportResult = {
    ...limit,
    created,
    updated,
    duplicates,
    skipped,
    rejectedDomain,
    failed: skipped + rejectedDomain,
    total: contacts.length,
  };
  logger.info({ format: job.format, ...result }, "contact import complete");
  return result;
}
