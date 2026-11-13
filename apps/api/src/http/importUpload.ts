// File upload for the bulk imports only (Contacts, WhatsApp Contacts, AI Call Customers): up to
// 500 MB, saved to a temp file instead of memory, then read row by row when big (importStream.ts).
// Every other upload keeps its own limit.

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { ImportFileError } from "../domain/importStream.js";
import { badRequest } from "./errors.js";

export const IMPORT_MAX_FILE_BYTES = 500 * 1024 * 1024;

/** Multipart field "file" to a temp file; over `maxBytes` → 400 with a clear message. */
export function importUpload(maxBytes: number = IMPORT_MAX_FILE_BYTES) {
  const single = multer({ dest: tmpdir(), limits: { fileSize: maxBytes, files: 1 } }).single("file");
  const mb = Math.round(maxBytes / (1024 * 1024));
  return (req: Request, res: Response, next: NextFunction) =>
    single(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        return next(badRequest(err.code === "LIMIT_FILE_SIZE" ? `File is larger than ${mb} MB. Split it into smaller files.` : err.message));
      }
      next(err as Error | undefined);
    });
}

/** A problem with the file itself (too big a pdf, …) → 400 with its message; anything else is rethrown. */
export function importFileProblem(err: unknown): never {
  if (err instanceof ImportFileError) throw badRequest(err.message);
  throw err;
}

/** The file couldn't be read → 400: an ImportFileError's own message, or "Couldn't read the file: …". */
export function unreadableFile(err: unknown): never {
  if (err instanceof ImportFileError) throw badRequest(err.message);
  throw badRequest(`Couldn't read the file: ${err instanceof Error ? err.message : String(err)}`);
}

/** Remove the upload's temp file. Call when done, also after an error. */
export async function removeUpload(file: Express.Multer.File | undefined): Promise<void> {
  if (file?.path) await rm(file.path, { force: true }).catch(() => {});
}
