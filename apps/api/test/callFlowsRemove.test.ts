import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// DELETE /api/call-flows/:id against an in-memory Prisma: hard delete of an unused
// draft, soft delete (archivedAt) when a run used the flow, published / built-in /
// non-admin refusals, and removed flows disappearing from the list (and therefore
// from the AI Call flow picker, which reads the same list).

type Version = { id: string; status: "DRAFT" | "PUBLISHED"; runs: number; running?: boolean };
type Flow = { id: string; name: string; archivedAt: Date | null; versions: Version[] };
let flows: Flow[] = [];
const deletedVersionsFor: string[] = [];
let listWhere: unknown = null;

const tx = {
  callFlow: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const f = flows.find((x) => x.id === where.id);
      return f ? { ...f, versions: f.versions.map((v, i) => ({ id: v.id, version: i + 1, status: v.status, _count: { runs: v.runs } })) } : null;
    },
    update: async ({ where, data }: { where: { id: string }; data: { archivedAt: Date } }) => {
      const f = flows.find((x) => x.id === where.id)!;
      f.archivedAt = data.archivedAt;
      return f;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      flows = flows.filter((x) => x.id !== where.id);
      return {};
    },
    findMany: async ({ where }: { where: { archivedAt: null } }) => {
      listWhere = where;
      return flows
        .filter((f) => where.archivedAt !== null || !f.archivedAt)
        .map((f) => ({
          id: f.id,
          name: f.name,
          archivedAt: f.archivedAt,
          versions: f.versions.map((v, i) => ({ id: v.id, version: i + 1, status: v.status, publishedAt: null, updatedAt: new Date() })),
        }));
    },
  },
  aiCallRunFlow: {
    // RUNNING runs pinned to any of these versions
    count: async ({ where }: { where: { flowVersionId: { in: string[] } } }) =>
      flows.flatMap((f) => f.versions).filter((v) => where.flowVersionId.in.includes(v.id) && v.running).length,
  },
  callFlowVersion: {
    deleteMany: async ({ where }: { where: { flowId: string } }) => {
      deletedVersionsFor.push(where.flowId);
      return { count: 1 };
    },
  },
};
vi.mock("../src/prisma.js", () => ({
  prisma: { ...tx, $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) },
}));

let server: Server;
let base = "";
const token = (role: "ADMIN" | "EDITOR") =>
  jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);

beforeAll(async () => {
  process.env.ENABLE_AI_CALLS = "true";
  process.env.ENABLE_CALL_FLOW_EDITOR = "true";
  const { createApp } = await import("../src/http/app.js");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  flows = [
    { id: "draft_only", name: "Draft only", archivedAt: null, versions: [{ id: "v1", status: "DRAFT", runs: 0 }] },
    { id: "tested", name: "Tested draft", archivedAt: null, versions: [{ id: "v2", status: "DRAFT", runs: 1 }] },
    {
      id: "live",
      name: "Live flow",
      archivedAt: null,
      versions: [
        { id: "v3", status: "PUBLISHED", runs: 4 },
        { id: "v4", status: "DRAFT", runs: 0 },
      ],
    },
  ];
  deletedVersionsFor.length = 0;
});

const del = (id: string, role: "ADMIN" | "EDITOR" = "ADMIN", body?: unknown) =>
  fetch(`${base}/api/call-flows/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token(role)}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;
const list = async () =>
  ((await (await fetch(`${base}/api/call-flows`, { headers: { Authorization: `Bearer ${token("ADMIN")}` } })).json()) as {
    items: { id: string }[];
  }).items.map((f) => f.id);

describe("DELETE /api/call-flows/:id", () => {
  it("hard-deletes an unused draft flow with its versions", async () => {
    const res = await del("draft_only");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: "deleted" });
    expect(flows.map((f) => f.id)).not.toContain("draft_only");
    expect(deletedVersionsFor).toEqual(["draft_only"]);
  });

  it("only hides a flow a run used, so run history keeps its version", async () => {
    const res = await del("tested");
    expect(await res.json()).toEqual({ ok: true, result: "archived" });
    const kept = flows.find((f) => f.id === "tested")!;
    expect(kept.archivedAt).toBeInstanceOf(Date);
    expect(kept.versions).toHaveLength(1); // the pinned version (and the logs pointing at it) stay
    expect(deletedVersionsFor).toEqual([]);
  });

  it("a live flow needs DELETE typed exactly: missing or wrong text is a 400 and changes nothing", async () => {
    for (const body of [undefined, {}, { confirm: "delete" }, { confirm: "DELETE " }, { confirm: "yes" }]) {
      const res = await del("live", "ADMIN", body);
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toMatch(/is live \(v1\)\. Type DELETE to confirm/);
    }
    expect(flows.find((f) => f.id === "live")!.archivedAt).toBeNull();
    expect(deletedVersionsFor).toEqual([]);
  });

  it("with DELETE a live flow a run used is removed but kept (archived), so call logs keep their version", async () => {
    const res = await del("live", "ADMIN", { confirm: "DELETE" });
    expect(await res.json()).toEqual({ ok: true, result: "archived" });
    const kept = flows.find((f) => f.id === "live")!;
    expect(kept.archivedAt).toBeInstanceOf(Date);
    expect(kept.versions).toHaveLength(2);
    expect(deletedVersionsFor).toEqual([]);
    expect(await list()).not.toContain("live"); // gone from the list / AI Call picker
  });

  it("with DELETE a live flow nothing used is deleted with its versions", async () => {
    flows.push({ id: "live_unused", name: "Live unused", archivedAt: null, versions: [{ id: "v9", status: "PUBLISHED", runs: 0 }] });
    const res = await del("live_unused", "ADMIN", { confirm: "DELETE" });
    expect(await res.json()).toEqual({ ok: true, result: "deleted" });
    expect(deletedVersionsFor).toEqual(["live_unused"]);
  });

  it("a flow a running call run uses is refused with the reason", async () => {
    flows.find((f) => f.id === "live")!.versions[0]!.running = true;
    const res = await del("live", "ADMIN", { confirm: "DELETE" });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("A call run is using this flow right now. Try again when it finishes.");
    expect(flows.find((f) => f.id === "live")!.archivedAt).toBeNull();
  });

  it("refuses the built-in scripts with 403", async () => {
    for (const id of ["nila", "followup"]) expect((await del(id)).status).toBe(403);
  });

  it("removing a flow is admin-only: editors are stopped at the role gate", async () => {
    expect((await del("nope", "EDITOR")).status).toBe(403);
    expect((await del("live", "EDITOR", { confirm: "DELETE" })).status).toBe(403);
    expect((await del("nope", "ADMIN")).status).toBe(404); // admins pass the gate (then 404: unknown flow)
  });

  it("404s for unknown or already removed flows", async () => {
    expect((await del("nope")).status).toBe(404);
    await del("tested");
    expect((await del("tested")).status).toBe(404);
  });

  it("removed flows disappear from the list the AI Call picker uses", async () => {
    await del("draft_only");
    await del("tested");
    expect(await list()).toEqual(["live"]);
    expect(listWhere).toEqual({ archivedAt: null, language: "en" }); // the English page (no ?language=)
  });
});
