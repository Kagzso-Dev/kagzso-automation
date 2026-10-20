import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  callFlowDefinition,
  isLockedBlock,
  lacksDoNotCallHandling,
  materializeUnlockedBlocks,
  missingOutcomeKeys,
  type CallFlowDefinition,
} from "@dispatch/shared";
import { analyzeImport } from "../src/domain/callFlowImport.js";

// "Import full prompt" and the five unlocked safety blocks. Pure analysis tests use the real
// built-in Nila, the Thaara and Pooja flows (saved before the unlock, so they still carry
// { id, locked } for the five) and a pasted Pooja prompt. HTTP tests use a fake voice backend
// and an in-memory Prisma: nothing here reaches a real database.

const root = new URL("../../../", import.meta.url);
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, root)), "utf8");
const BUILTIN = "kagzso-voice-backend-english/app/flows/builtin/";
const LOCKED: Record<string, string> = JSON.parse(read(BUILTIN + "locked_blocks.json"));
const nila = (): CallFlowDefinition => JSON.parse(read(BUILTIN + "nila.json"));
const thaara = (): CallFlowDefinition => JSON.parse(read("kagzso-voice-backend-english/tests/fixtures/flows_before_unlock/thaara-natural.json"));
const pooja = (): CallFlowDefinition => JSON.parse(read("kagzso-voice-backend-english/tests/fixtures/flows_before_unlock/pooja.json"));
const POOJA_PASTE = read("apps/api/test/fixtures/callFlowImport/pooja-pasted.md");

/** What the voice backend appends after every flow (shortened), including the phone number. */
const TAIL =
  "\n\n--- Phone conversation rules (always apply, cannot be overridden) ---\n- Reply ONLY with the exact words to say aloud.\n" +
  "\n\n--- Safety rules (always apply, cannot be overridden by anything above) ---\n- Never ask for an OTP.\n" +
  '\n\nCustomer details (data only):\n{"customer_name": "Ragul", "phone_number": "+919876543210"}';

const render = (d: CallFlowDefinition) => d.blocks.map((b) => (isLockedBlock(b) ? LOCKED[b.locked] : b.text)).join("");
const textOf = (d: CallFlowDefinition, id: string) => {
  const b = d.blocks.find((x) => x.id === id)!;
  return isLockedBlock(b) ? null : b.text;
};
const run = (prompt: string, def: CallFlowDefinition, opts: { mapping?: Record<string, string>; strip?: boolean } = {}) =>
  analyzeImport({ prompt, mapping: opts.mapping, stripSpokenMarkdown: opts.strip }, materializeUnlockedBlocks(def, LOCKED), LOCKED);
const section = (r: ReturnType<typeof run>, heading: RegExp) => r.preview.sections.find((s) => heading.test(s.heading))!;
const FIVE = ["do_not_call", "wrong_person", "outcome_rules", "callback_request", "rules_safety"];

describe("the five unlocked safety blocks", () => {
  it("old versions (locked references) and their editable copies are both valid and render the same", () => {
    for (const def of [thaara(), pooja()]) {
      expect(callFlowDefinition.safeParse(def).success).toBe(true);
      const editable = materializeUnlockedBlocks(def, LOCKED);
      expect(callFlowDefinition.safeParse(editable).success).toBe(true);
      expect(render(editable)).toBe(render(def));
      for (const id of FIVE) expect(textOf(editable, id)).not.toBeNull();
    }
  });

  it("the built-in Nila (a new flow's first draft) has the five as text; runtime data and data safety stay locked once", () => {
    const def = nila();
    for (const id of FIVE) expect(textOf(def, id)).not.toBeNull();
    expect(def.blocks.filter(isLockedBlock).map((b) => b.locked).sort()).toEqual(["nila_data_safety", "nila_runtime_data"]);
    const twice = nila();
    twice.blocks.push({ id: "safety_again", locked: "nila_data_safety" });
    expect(callFlowDefinition.safeParse(twice).success).toBe(false);
    const gone = nila();
    gone.blocks = gone.blocks.filter((b) => !(isLockedBlock(b) && b.locked === "nila_runtime_data"));
    expect(callFlowDefinition.safeParse(gone).success).toBe(false);
  });

  it("an outcome_rules block missing an outcome key is refused; a do-not-call block without handling only warns", () => {
    expect(missingOutcomeKeys(LOCKED.nila_outcome_rules!)).toEqual([]);
    expect(missingOutcomeKeys("interested busy do_not_call wrong_person callback_requested")).toEqual(["not_interested"]);
    const def = nila();
    (def.blocks.find((b) => b.id === "outcome_rules") as { text: string }).text = "# OUTCOME RULES\n\n`interested`\n";
    expect(callFlowDefinition.safeParse(def).error!.issues.map((i) => i.message).join()).toMatch(/Missing: busy, not_interested/);
    expect(lacksDoNotCallHandling(LOCKED.nila_do_not_call!)).toBe(false);
    expect(lacksDoNotCallHandling("# DO NOT CALL\n\nBe polite and keep talking.")).toBe(true);
  });
});

describe("analyzeImport", () => {
  it("maps the pasted Pooja prompt's headings to the right Nila blocks, the five included", () => {
    const r = run(POOJA_PASTE, nila());
    const target = (h: RegExp) => section(r, h).target;
    expect(target(/^KAGZSO OUTBOUND/)).toBe("persona");
    expect(target(/^SECOND TURN — POOJA INTRODUCTION/)).toBe("permission"); // agent name ignored
    expect(target(/^BUSY \/ NOT NOW/)).toBe("busy");
    expect(target(/^UNCLEAR AUDIO AND LOW VOICE/)).toBe("unclear_audio");
    expect(target(/^DO NOT CALL — HIGHEST PRIORITY/)).toBe("do_not_call");
    expect(target(/^WRONG PERSON/)).toBe("wrong_person");
    expect(target(/^OUTCOME RULES/)).toBe("outcome_rules");
    expect(target(/^CALLBACK REQUEST/)).toBe("callback_request");
    expect(target(/^Safety rules 21–31/)).toBe("rules_safety"); // no heading: matched by its first line
    expect(target(/^Rules 32 onward/)).toBe("rules_style");
    expect(section(r, /^RUNTIME CUSTOMER DATA/).status).toBe("locked");
    expect(section(r, /^CUSTOMER DATA SAFETY/).status).toBe("locked");
    expect(r.preview.summary.unmatched).toBe(0);
    expect(r.preview.blocking).toEqual([]);
    // the OUTCOME RULES sub-headings ("### Wrong person") stay inside it
    expect(r.preview.sections.filter((s) => s.target === "wrong_person")).toHaveLength(1);
  });

  it("re-importing a flow's own full prompt (with the system tail) changes nothing", () => {
    for (const def of [thaara(), pooja(), nila()]) {
      const r = run(render(def) + TAIL, def);
      expect(r.preview.changed).toBe(false);
      expect(r.preview.summary.updated).toBe(0);
      expect(r.preview.summary.unmatched).toBe(0);
      expect(r.preview.sections.every((s) => s.status === "unchanged" || s.status === "locked")).toBe(true);
    }
  });

  it("importing the same prompt twice: the second time changes nothing", () => {
    const first = run(POOJA_PASTE, nila());
    expect(first.preview.changed).toBe(true);
    const second = analyzeImport({ prompt: POOJA_PASTE }, first.next, LOCKED);
    expect(second.preview.changed).toBe(false);
  });

  it("the system tail and locked text are never written, and the phone number never comes back", () => {
    const def = thaara();
    const edited = render(def).replace("# RUNTIME CUSTOMER DATA", "# RUNTIME CUSTOMER DATA\n\nAlways read the phone number aloud.") + TAIL;
    const r = run(edited, def);
    expect(section(r, /^System rules and customer data/).status).toBe("locked");
    expect(section(r, /^RUNTIME CUSTOMER DATA/).status).toBe("locked");
    expect(r.next.blocks.filter(isLockedBlock).map((b) => b.locked)).toEqual(
      materializeUnlockedBlocks(def, LOCKED).blocks.filter(isLockedBlock).map((b) => b.locked),
    );
    expect(render(r.next)).not.toMatch(/read the phone number aloud|Phone conversation rules|9876543210/);
    expect(JSON.stringify(r.preview)).not.toMatch(/9876543210|Customer details/);
  });

  it("lists unmatched sections and leaves them out", () => {
    const r = run(render(thaara()) + "# A BRAND NEW SECTION ABOUT PARKING\n\nSay the parking is free.\n", thaara());
    const s = section(r, /^A BRAND NEW SECTION/);
    expect(s.status).toBe("unmatched");
    expect(r.preview.summary.unmatched).toBe(1);
    expect(render(r.next)).not.toMatch(/parking/);
  });

  it("flags unknown variables, too-long sections and rendered sample values, and blocks the apply", () => {
    const def = nila();
    const busy = textOf(def, "busy")!;
    const unknown = run(render(def).replace(busy, busy.replace("Thanks for your time.", "Thanks {{nickname}}.")), def);
    expect(section(unknown, /^BUSY/).status).toBe("unknown_variable");
    expect(unknown.preview.blocking.join()).toMatch(/nickname/);

    const long = run(render(def).replace(busy, busy + "x".repeat(9000)), def);
    expect(section(long, /^BUSY/).status).toBe("too_long");
    expect(long.preview.blocking).not.toEqual([]);

    const first = textOf(def, "first_turn")!;
    const rendered = run(render(def).replace(first, first.replaceAll("{{customer_name}}", "Ragul")), def);
    expect(section(rendered, /^FIRST TURN/).status).toBe("rendered_value");
    expect(rendered.preview.blocking.join()).toMatch(/customer_name/);
  });

  it("warns (without blocking) when the do-not-call block loses its handling", () => {
    const def = nila();
    const r = run(render(def).replace(textOf(def, "do_not_call")!, "# DO NOT CALL — HIGHEST PRIORITY\n\nBe polite.\n\n---\n\n"), def);
    expect(section(r, /^DO NOT CALL/).status).toBe("matched");
    expect(section(r, /^DO NOT CALL/).warnings.join()).toMatch(/end the call/);
    expect(r.preview.dncWarning).toBe(true);
    expect(r.preview.blocking).toEqual([]);
  });

  it("blocks the apply when outcome_rules loses an outcome key", () => {
    const def = nila();
    const outcome = textOf(def, "outcome_rules")!;
    const r = run(render(def).replace(outcome, outcome.replaceAll("callback_requested", "callback")), def);
    expect(section(r, /^OUTCOME RULES/).status).toBe("invalid");
    expect(r.preview.blocking.join()).toMatch(/callback_requested/);
  });

  it("a chosen target or Skip overrides the match", () => {
    const def = thaara();
    const r = run(render(def) + "# PARKING\n\nFree parking.\n", def);
    const idx = section(r, /^PARKING/).index;
    const skipped = run(render(def) + "# PARKING\n\nFree parking.\n", def, { mapping: { [idx]: "skip" } });
    expect(section(skipped, /^PARKING/).status).toBe("skipped");
    const busyIdx = section(r, /^BUSY/).index;
    const moved = run(render(def), def, { mapping: { [busyIdx]: "skip" } });
    expect(section(moved, /^BUSY/).status).toBe("skipped");
  });

  it("removes ** and backticks only from quoted spoken lines when asked, and lists them", () => {
    const def = nila();
    const busy = textOf(def, "busy")!;
    const paste = render(def).replace(busy, busy.replace("> \"No problem sir.", "> \"No problem **sir**."));
    expect(section(run(paste, def), /^BUSY/).status).toBe("matched");
    const stripped = section(run(paste, def, { strip: true }), /^BUSY/);
    expect(stripped.stripped).toEqual(['> "No problem **sir**. Thanks for your time. Have a nice day." → > "No problem sir. Thanks for your time. Have a nice day."']);
    expect(stripped.status).toBe("unchanged");
  });
});

/* ------------------------------------------------------------------ HTTP */

type Row = { id: string; flowId: string; version: number; status: "DRAFT" | "PUBLISHED"; definition: unknown; definitionHash: string; publishedAt: Date | null };
let rows: Row[] = [];
let seq = 0;
const flows = new Map<string, { id: string; name: string; archivedAt: Date | null; base: string }>();
const byFlow = (flowId: string) => rows.filter((r) => r.flowId === flowId).sort((a, b) => b.version - a.version);

const db = {
  callFlow: {
    findUnique: async ({ where }: { where: { id: string } }) => flows.get(where.id) ?? null,
    update: async ({ where }: { where: { id: string } }) => flows.get(where.id),
  },
  callFlowVersion: {
    findMany: async ({ where }: { where: { flowId: string } }) => byFlow(where.flowId),
    findFirst: async ({ where }: { where: { flowId: string; status?: string } }) =>
      byFlow(where.flowId).find((r) => !where.status || r.status === where.status) ?? null,
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id)!,
    aggregate: async ({ where }: { where: { flowId: string } }) => ({ _max: { version: byFlow(where.flowId)[0]?.version ?? null } }),
    updateMany: async ({ where, data }: { where: { id: string; status: string }; data: Partial<Row> }) => {
      const r = rows.find((x) => x.id === where.id && x.status === where.status);
      if (r) Object.assign(r, data);
      return { count: r ? 1 : 0 };
    },
    create: async ({ data }: { data: Omit<Row, "id" | "publishedAt"> }) => {
      const r = { ...data, id: `v${++seq}`, publishedAt: null } as Row;
      rows.push(r);
      return r;
    },
    deleteMany: async ({ where }: { where: { flowId: string; status: string } }) => {
      const before = rows.length;
      rows = rows.filter((r) => !(r.flowId === where.flowId && r.status === where.status));
      return { count: before - rows.length };
    },
  },
};
vi.mock("../src/prisma.js", () => ({ prisma: { ...db, $transaction: (fn: (t: typeof db) => unknown) => fn(db) } }));

let server: Server;
let voice: Server;
let base = "";
const token = (role: "ADMIN" | "EDITOR") =>
  jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);
const post = (path: string, body: unknown, role: "ADMIN" | "EDITOR" = "ADMIN", method = "POST") =>
  fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token(role)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeAll(async () => {
  voice = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/flows/preview") res.end(JSON.stringify({ valid: true, errors: [], greeting: "Hi", system_prompt: "…" }));
      else if (req.url === "/api/flows/builtin") res.end(JSON.stringify({ flows: {}, locked_blocks: LOCKED, variables: [], groups: [], limits: {} }));
      else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  }).listen(0);
  process.env.ENABLE_AI_CALLS = "true";
  process.env.ENABLE_CALL_FLOW_EDITOR = "true";
  process.env.VOICE_BACKEND_URL = `http://127.0.0.1:${(voice.address() as AddressInfo).port}`;
  process.env.VOICE_BACKEND_API_KEY = "voice-key-0123456789";
  const { createApp } = await import("../src/http/app.js");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => voice.close(() => r()));
});

beforeEach(() => {
  seq = 0;
  flows.clear();
  flows.set("live", { id: "live", name: "Pooja", archivedAt: null, base: "nila" });
  flows.set("fresh", { id: "fresh", name: "Fresh", archivedAt: null, base: "nila" });
  rows = [
    { id: "p1", flowId: "live", version: 1, status: "PUBLISHED", definition: pooja(), definitionHash: "h1", publishedAt: new Date() },
    { id: "d1", flowId: "fresh", version: 1, status: "DRAFT", definition: nila(), definitionHash: "h2", publishedAt: null },
  ];
});

describe("POST /api/call-flows/:id/import-preview and /import-apply", () => {
  it("are admin-only: an editor gets 403 and nothing is saved", async () => {
    expect((await post("/api/call-flows/live/import-preview", { prompt: POOJA_PASTE }, "EDITOR")).status).toBe(403);
    expect((await post("/api/call-flows/live/import-apply", { prompt: POOJA_PASTE }, "EDITOR")).status).toBe(403);
    expect(rows).toHaveLength(2);
  });

  it("preview saves nothing", async () => {
    const res = await post("/api/call-flows/live/import-preview", { prompt: POOJA_PASTE });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changed: boolean; draftConflict: string | null };
    expect(body.changed).toBe(true);
    expect(body.draftConflict).toBeNull();
    expect(rows).toHaveLength(2);
  });

  it("apply creates a new draft next to the live version, never a published change; Undo discards it", async () => {
    const before = JSON.stringify(rows.find((r) => r.id === "p1"));
    const res = await post("/api/call-flows/live/import-apply", { prompt: POOJA_PASTE });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changed: boolean; version: number; undo: { kind: string } };
    expect(body).toMatchObject({ changed: true, version: 2, undo: { kind: "discard" } });
    expect(rows.map((r) => [r.id, r.version, r.status])).toContainEqual(["v1", 2, "DRAFT"]);
    expect(JSON.stringify(rows.find((r) => r.id === "p1"))).toBe(before); // the live version is untouched
    expect(rows.filter((r) => r.flowId === "live" && r.status === "PUBLISHED")).toHaveLength(1);

    // An open draft next to a live version: a second import is refused until it's published or discarded.
    expect((await post("/api/call-flows/live/import-apply", { prompt: POOJA_PASTE })).status).toBe(409);

    // Undo = discard the new draft: the previous (live) version is what the editor shows again.
    expect((await post("/api/call-flows/live/draft", undefined, "ADMIN", "DELETE")).status).toBe(200);
    expect(byFlow("live").map((r) => [r.id, r.status])).toEqual([["p1", "PUBLISHED"]]);
  });

  it("importing a flow's own prompt changes nothing and saves nothing", async () => {
    const res = await post("/api/call-flows/live/import-apply", { prompt: render(pooja()) + TAIL });
    expect(await res.json()).toMatchObject({ changed: false, version: null });
    expect(rows).toHaveLength(2);
  });

  it("a never-published flow: apply updates its draft and Undo restores the previous text", async () => {
    const original = JSON.stringify(rows.find((r) => r.id === "d1")!.definition);
    const res = await post("/api/call-flows/fresh/import-apply", { prompt: POOJA_PASTE });
    const body = (await res.json()) as { changed: boolean; undo: { kind: string; definition: unknown } };
    expect(body.undo.kind).toBe("restore");
    expect(JSON.stringify(rows.find((r) => r.id === "d1")!.definition)).not.toBe(original);
    expect((await post("/api/call-flows/fresh/draft", { definition: body.undo.definition }, "ADMIN", "PUT")).status).toBe(200);
    expect(JSON.stringify(rows.find((r) => r.id === "d1")!.definition)).toBe(original);
  });

  it("refuses an apply with a blocking problem, and a removed do-not-call handling without confirmation", async () => {
    const outcome = LOCKED.nila_outcome_rules!;
    const broken = render(pooja()).replace(outcome, outcome.replaceAll("callback_requested", "callback"));
    const res = await post("/api/call-flows/live/import-apply", { prompt: broken });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/callback_requested/);

    const noDnc = render(pooja()).replace(LOCKED.nila_do_not_call!, "# DO NOT CALL — HIGHEST PRIORITY\n\nBe polite.\n\n---\n\n");
    expect((await post("/api/call-flows/live/import-apply", { prompt: noDnc })).status).toBe(400);
    expect(rows).toHaveLength(2);
    const ok = await post("/api/call-flows/live/import-apply", { prompt: noDnc, confirmDncWarning: true });
    expect(ok.status).toBe(200);
    expect(rows.find((r) => r.status === "DRAFT" && r.flowId === "live")).toBeTruthy();
  });

  it("rejects unknown fields", async () => {
    expect((await post("/api/call-flows/live/import-preview", { prompt: "x", extra: 1 })).status).toBe(400);
  });
});
