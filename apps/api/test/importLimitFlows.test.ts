import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Import row limit, end to end against an in-memory stand-in for Prisma (no MySQL):
//   Contacts → Import file (the csv-import job), WhatsApp Contacts → Import file (POST
//   /api/whatsapp/contacts/import), AI Call Customers → Import (POST /api/ai-call-customers/parse).
// Files below, at and above the limit: the first rows are imported with the usual rules (upsert,
// approved domains, duplicates, invalid rows) and the summary counts every row of the file.

process.env.ENABLE_AI_CALLS = "true";

type Row = Record<string, any>;
let seq = 0;
const tables: Record<string, Row[]> = {};
const T = (name: string) => (tables[name] ??= []);

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (cond !== null && typeof cond === "object") {
      if ("in" in cond) return cond.in.includes(row[k]);
      return matches(row, cond); // compound unique key, e.g. listId_contactId
    }
    return (row[k] ?? null) === cond;
  });
}
const defined = (data: Row) => Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));

// Lookups by a unique key go through an index, so big files stay fast.
const UNIQUE = ["email", "phone"];
const keyOf = (k: string, v: unknown) => `${k}:${String(v)}`;
const indexes: Record<string, { size: number; map: Map<string, Row> }> = {};
function index(name: string) {
  const rows = T(name);
  let idx = indexes[name];
  if (!idx || idx.size !== rows.length) {
    // Rows pushed straight into the table by a test: rebuild.
    idx = indexes[name] = { size: rows.length, map: new Map() };
    for (const r of rows) for (const k of UNIQUE) if (r[k] != null) idx.map.set(keyOf(k, r[k]), r);
  }
  return idx;
}
function find(name: string, where: Row): Row | undefined {
  const keys = Object.keys(where);
  if (keys.length === 1 && UNIQUE.includes(keys[0]!)) return index(name).map.get(keyOf(keys[0]!, where[keys[0]!]));
  return T(name).find((x) => matches(x, where));
}

function model(name: string) {
  const rows = () => T(name);
  return {
    findUnique: vi.fn(async ({ where }: Row) => {
      const r = find(name, where);
      return r ? { ...r } : null;
    }),
    findMany: vi.fn(async (args: Row = {}) => rows().filter((r) => matches(r, args.where)).map((r) => ({ ...r }))),
    create: vi.fn(async ({ data }: Row) => {
      const row: Row = { id: `${name}-${++seq}`, ...defined(data) };
      rows().push(row);
      return { ...row };
    }),
    upsert: vi.fn(async ({ where, create, update }: Row) => {
      const r = find(name, where);
      if (r) {
        Object.assign(r, defined(update)); // Prisma leaves undefined fields alone
        return { ...r };
      }
      const idx = index(name);
      const row: Row = { id: `${name}-${++seq}`, ...defined(create) };
      rows().push(row);
      idx.size++;
      for (const k of UNIQUE) if (row[k] != null) idx.map.set(keyOf(k, row[k]), row);
      return { ...row };
    }),
  };
}
const models: Record<string, ReturnType<typeof model>> = {};
const db = new Proxy({} as Row, { get: (_t, p: string) => (models[p] ??= model(p)) });
vi.mock("../src/prisma.js", () => ({ prisma: db }));

// A pdf's text, without a real pdf.
const pdf = vi.hoisted(() => ({ text: "" }));
vi.mock("pdf-parse/lib/pdf-parse.js", () => ({ default: async () => ({ text: pdf.text }) }));

const { processContactImport } = await import("../src/queue/contactImport.js");

const LIMIT = 1000;
const range = (n: number, from = 1) => Array.from({ length: n }, (_, i) => i + from);
const csv = (header: string, lines: string[]) => Buffer.from([header, ...lines].join("\n") + "\n");
const job = (file: Buffer, format: "csv" | "xlsx" | "pdf" = "csv", listId?: string) => ({
  fileBase64: file.toString("base64"),
  filename: `contacts.${format}`,
  format,
  ...(listId ? { listId } : {}),
});
const emails = () => T("contact").map((c) => c.email);

const BIG = 15_000; // timeout for the limit-sized files on a slow machine

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  for (const k of Object.keys(indexes)) delete indexes[k];
  for (const m of Object.values(models)) for (const fn of Object.values(m)) fn.mockClear();
  pdf.text = "";
});

describe("Contacts → Import file (csv-import job)", () => {
  it("the example, scaled down: 20 rows, a limit of 10 → the first 10 checked and imported, 10 skipped", async () => {
    T("allowedDomain").push({ domain: "ok.com" });
    T("contact").push({ id: "saved-1", email: "saved@ok.com", firstName: "Old" });
    const lines = [
      "new1@ok.com,One", //        1 new
      "new2@ok.com,Two", //        2 new
      "saved@ok.com,Saved", //     3 already saved → updated
      ",NoEmail", //               4 failed: no email
      "new1@ok.com,One again", //  5 duplicate of row 1
      "bad@blocked.com,Bad", //    6 failed: domain not approved
      "new3@ok.com,Three", //      7 new
      "new2@ok.com,Two again", //  8 duplicate of row 2
      "new4@ok.com,Four", //       9 new
      "new5@ok.com,Five", //      10 new
      ...range(10, 11).map((i) => `over${i}@ok.com,Over${i}`), // 11-20: over the limit
    ];
    const res = await processContactImport(job(csv("email,first name", lines), "csv", "list-1"), 10);

    expect(res).toEqual({
      totalRows: 20,
      maxRows: 10,
      selectedRows: 10,
      skippedOverLimit: 10,
      created: 5,
      updated: 1,
      duplicates: 2,
      skipped: 1,
      rejectedDomain: 1,
      failed: 2,
      total: 9,
    });
    // Every selected row is accounted for.
    expect(res.created + res.updated + res.duplicates + res.failed).toBe(res.selectedRows);
    // Rows after the limit never reach the database.
    expect(emails().filter((e) => e.startsWith("over"))).toEqual([]);
    expect(db.contact.upsert.mock.calls.some(([a]: Row[]) => String(a!.where.email).startsWith("over"))).toBe(false);
    // Existing behaviour kept: upsert on email (a repeat updates that contact), list memberships.
    expect(emails().sort()).toEqual(["new1@ok.com", "new2@ok.com", "new3@ok.com", "new4@ok.com", "new5@ok.com", "saved@ok.com"]);
    expect(T("contact").find((c) => c.email === "saved@ok.com")!.firstName).toBe("Saved");
    expect(T("contact").find((c) => c.email === "new1@ok.com")!.firstName).toBe("One again");
    expect(T("listMembership")).toHaveLength(6);
  });

  it.each([
    [LIMIT - 1, LIMIT - 1, 0],
    [LIMIT, LIMIT, 0],
    [LIMIT + 1, LIMIT, 1],
  ])("the real limit: %i rows → %i imported, %i skipped over the limit", async (n, imported, skipped) => {
    const res = await processContactImport(job(csv("email", range(n).map((i) => `user${i}@example.com`))));
    expect(res).toMatchObject({ totalRows: n, maxRows: LIMIT, selectedRows: imported, skippedOverLimit: skipped, created: imported, failed: 0, duplicates: 0 });
    expect(T("contact")).toHaveLength(imported);
    expect(emails()).not.toContain(`user${LIMIT + 1}@example.com`);
  }, BIG);

  it("a pdf: each distinct email is a record; the first ones (in the order they appear) up to the limit", async () => {
    pdf.text = "Contacts: a@x.com, b@x.com. Again a@x.com. Then c@x.com d@x.com e@x.com f@x.com g@x.com";
    const res = await processContactImport(job(Buffer.from("%PDF"), "pdf"), 5);
    expect(res).toMatchObject({ totalRows: 7, maxRows: 5, selectedRows: 5, skippedOverLimit: 2, created: 5, duplicates: 0, failed: 0 });
    expect(emails()).toEqual(["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"]);
  });
});

describe("over HTTP", () => {
  let server: Server;
  let base = "";
  const auth = { Authorization: `Bearer ${jwt.sign({ sub: "u-admin", email: "admin@test", role: "ADMIN" }, process.env.JWT_ACCESS_SECRET!)}` };
  const upload = (path: string, file: Buffer, name: string) => {
    const fd = new FormData();
    fd.append("file", new Blob([file]), name);
    return fetch(base + path, { method: "POST", headers: auth, body: fd });
  };
  const phone = (i: number) => `+91 9${String(i).padStart(9, "0")}`;

  beforeAll(async () => {
    const { createApp } = await import("../src/http/app.js");
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  describe("WhatsApp Contacts → Import file", () => {
    it.each([
      [LIMIT - 1, LIMIT - 1, 0],
      [LIMIT, LIMIT, 0],
      [LIMIT + 1, LIMIT, 1],
    ])("%i rows → %i imported, %i skipped over the limit", async (n, imported, skipped) => {
      const res = await upload("/api/whatsapp/contacts/import", csv("phone,first name", range(n).map((i) => `${phone(i)},N${i}`)), "contacts.csv");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        totalRows: n,
        maxRows: LIMIT,
        selectedRows: imported,
        skippedOverLimit: skipped,
        created: imported,
        updated: 0,
        duplicates: 0,
        failed: 0,
        skipped: 0,
        total: imported,
      });
      expect(T("whatsAppContact")).toHaveLength(imported);
      expect(T("whatsAppContact").some((c) => c.phone === `919${String(LIMIT + 1).padStart(9, "0")}`)).toBe(false);
    }, BIG);

    it("saved, repeated and unusable numbers are counted; created + updated + duplicates + failed = selected", async () => {
      T("whatsAppContact").push({ id: "w1", phone: "919000000002", firstName: "Old" });
      // new, already saved, unusable, repeat of row 1, new, new
      const lines = ["+919000000001,A", "+919000000002,Saved", "12345,Bad", "+919000000001,A again", "+919000000003,C", "+919000000004,D"];
      const res = await upload("/api/whatsapp/contacts/import", csv("phone,first name", lines), "c.csv");
      expect(await res.json()).toMatchObject({ totalRows: 6, selectedRows: 6, skippedOverLimit: 0, created: 3, updated: 1, duplicates: 1, failed: 1 });
      expect(T("whatsAppContact").find((c) => c.phone === "919000000001")!.firstName).toBe("A again");
    });
  });

  describe("AI Call Customers → Import: the file read (parse)", () => {
    it.each([
      [LIMIT - 1, LIMIT - 1, false],
      [LIMIT, LIMIT, false],
      [LIMIT + 1, LIMIT, true],
    ])("%i rows → %i rows to import, truncated %s; the response says how many the file had", async (n, taken, truncated) => {
      const res = await upload("/api/ai-call-customers/parse", csv("customer_name,phone", range(n).map((i) => `C${i},${phone(i)}`)), "customers.csv");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rows: Record<string, string>[]; totalRows: number; maxRows: number; truncated: boolean };
      expect(body.rows).toHaveLength(taken);
      expect({ totalRows: body.totalRows, maxRows: body.maxRows, truncated: body.truncated }).toEqual({ totalRows: n, maxRows: LIMIT, truncated });
      expect(body.rows.at(-1)!.customer_name).toBe(`C${taken}`);
    }, BIG);
  });

  // Over the old sizes (10 MB; AI Call Customers 5 MB) a file is read row by row, up to 500 MB.
  describe("big files (over the old size limits)", () => {
    const MB = 1024 * 1024;
    /** A csv of at least `bytes`, and its row count. */
    const bigCsv = (header: string, line: (i: number) => string, bytes: number) => {
      const lines: string[] = [];
      let size = header.length;
      while (size < bytes) {
        const l = line(lines.length + 1);
        lines.push(l);
        size += l.length + 1;
      }
      return { file: csv(header, lines), rows: lines.length };
    };
    /** Upload temp files left in the temp folder (multer names them with 32 hex characters). */
    const uploadTemps = () => readdirSync(tmpdir()).filter((f) => /^[0-9a-f]{32}$/.test(f));

    it("WhatsApp Contacts: an 11 MB file → the first 1,000 imported, the rest counted; its temp file removed", async () => {
      const { file, rows } = bigCsv("phone,first name", (i) => `${phone(i)},N${i}`, 11 * MB);
      const before = uploadTemps();
      const res = await upload("/api/whatsapp/contacts/import", file, "big.csv");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ totalRows: rows, maxRows: LIMIT, selectedRows: LIMIT, skippedOverLimit: rows - LIMIT, created: LIMIT, failed: 0 });
      expect(T("whatsAppContact")).toHaveLength(LIMIT);
      expect(uploadTemps().filter((f) => !before.includes(f))).toEqual([]);
    }, BIG);

    it("AI Call Customers: a 6 MB file → 1,000 rows to import and the file's row count", async () => {
      const { file, rows } = bigCsv("customer_name,phone", (i) => `C${i},${phone(i)}`, 6 * MB);
      const res = await upload("/api/ai-call-customers/parse", file, "big.csv");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rows: Record<string, string>[]; totalRows: number; truncated: boolean };
      expect({ rows: body.rows.length, totalRows: body.totalRows, truncated: body.truncated }).toEqual({ rows: LIMIT, totalRows: rows, truncated: true });
      expect(body.rows.at(-1)!.customer_name).toBe(`C${LIMIT}`);
    }, BIG);

    it("Contacts: an 11 MB file is read by the API; the job gets only the first 1,000 rows, then imports them", async () => {
      const { file, rows } = bigCsv("email,first name", (i) => `user${i}@example.com,N${i}`, 11 * MB);
      const res = await upload("/api/contacts/import", file, "big.csv");
      expect(res.status).toBe(202);
      const queued = T("job").at(-1)!;
      expect(queued.queue).toBe("csv-import");
      expect(queued.payload.fileBase64).toBeUndefined(); // not the 11 MB file
      expect(queued.payload.parsed.contacts).toHaveLength(LIMIT);
      const result = await processContactImport(queued.payload);
      expect(result).toMatchObject({ totalRows: rows, selectedRows: LIMIT, skippedOverLimit: rows - LIMIT, created: LIMIT, failed: 0 });
      expect(emails()).not.toContain(`user${LIMIT + 1}@example.com`);
    }, BIG);

    it("Contacts: up to 10 MB the worker reads the file, exactly as before", async () => {
      const res = await upload("/api/contacts/import", csv("email", ["a@x.com"]), "small.csv");
      expect(res.status).toBe(202);
      const queued = T("job").at(-1)!;
      expect(queued.payload.fileBase64).toBe(csv("email", ["a@x.com"]).toString("base64"));
      expect(queued.payload.parsed).toBeUndefined();
    });

    it("Contacts: a pdf over 10 MB is refused with a clear message", async () => {
      const res = await upload("/api/contacts/import", Buffer.alloc(11 * MB, 32), "big.pdf");
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("A PDF can be up to 10 MB");
    }, BIG);

    it("a file over the upload limit: a clear message, not a server error", async () => {
      const { default: express } = await import("express");
      const { importUpload } = await import("../src/http/importUpload.js");
      const { errorHandler } = await import("../src/http/errors.js");
      const app = express();
      app.post("/x", importUpload(1 * MB), (req, res) => res.json({ size: req.file?.size }));
      app.use(errorHandler);
      const small = app.listen(0);
      try {
        const at = `http://127.0.0.1:${(small.address() as AddressInfo).port}/x`;
        const send = (bytes: number) => {
          const fd = new FormData();
          fd.append("file", new Blob([Buffer.alloc(bytes, 65)]), "f.csv");
          return fetch(at, { method: "POST", body: fd });
        };
        const over = await send(1.5 * MB);
        expect(over.status).toBe(400);
        expect(((await over.json()) as { error: string }).error).toBe("File is larger than 1 MB. Split it into smaller files.");
        expect(((await (await send(1000)).json()) as { size: number }).size).toBe(1000);
      } finally {
        await new Promise<void>((r) => small.close(() => r()));
      }
    });

    it("the import upload limit is 500 MB", async () => {
      expect((await import("../src/http/importUpload.js")).IMPORT_MAX_FILE_BYTES).toBe(500 * MB);
    });
  });
});
