import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// DELETE /api/call-flows/:id/versions/:version against an in-memory Prisma: an old
// version is deleted (only that row), the live version / the only version / a version a
// call run used are refused with 409, a version is looked up only inside the flow in the
// URL, and editors are stopped at the admin gate.

type Version = { id: string; version: number; status: "DRAFT" | "PUBLISHED"; runs: number };
type Flow = { id: string; name: string; archivedAt: Date | null; versions: Version[] };
let flows: Flow[] = [];
let deleteCalls: unknown[] = [];

const tx = {
  callFlow: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const f = flows.find((x) => x.id === where.id);
      return f ? { ...f, versions: f.versions.map((v) => ({ id: v.id, version: v.version, status: v.status, _count: { runs: v.runs } })) } : null;
    },
  },
  callFlowVersion: {
    deleteMany: async ({ where }: { where: { id: string; flowId: string; runs: { none: object } } }) => {
      deleteCalls.push(where);
      const f = flows.find((x) => x.id === where.flowId);
      const before = f?.versions.length ?? 0;
      if (f) f.versions = f.versions.filter((v) => !(v.id === where.id && v.runs === 0));
      return { count: before - (f?.versions.length ?? 0) };
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
    {
      id: "flow_a",
      name: "Flow A",
      archivedAt: null,
      versions: [
        { id: "a3", version: 3, status: "DRAFT", runs: 0 },
        { id: "a2", version: 2, status: "PUBLISHED", runs: 5 }, // live
        { id: "a1", version: 1, status: "PUBLISHED", runs: 0 },
      ],
    },
    {
      id: "flow_b",
      name: "Flow B",
      archivedAt: null,
      versions: [
        { id: "b5", version: 5, status: "PUBLISHED", runs: 0 }, // live
        { id: "b4", version: 4, status: "PUBLISHED", runs: 2 },
      ],
    },
    { id: "only", name: "Only draft", archivedAt: null, versions: [{ id: "o1", version: 1, status: "DRAFT", runs: 0 }] },
  ];
  deleteCalls = [];
});

const del = (id: string, version: number | string, role: "ADMIN" | "EDITOR" = "ADMIN") =>
  fetch(`${base}/api/call-flows/${id}/versions/${version}`, { method: "DELETE", headers: { Authorization: `Bearer ${token(role)}` } });
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;
const ids = (flowId: string) => flows.find((f) => f.id === flowId)!.versions.map((v) => v.id);

describe("DELETE /api/call-flows/:id/versions/:version", () => {
  it("deletes an old, unused published version and nothing else", async () => {
    const res = await del("flow_a", 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(ids("flow_a")).toEqual(["a3", "a2"]);
    expect(ids("flow_b")).toEqual(["b5", "b4"]);
    expect(deleteCalls).toEqual([{ id: "a1", flowId: "flow_a", runs: { none: {} } }]); // one row, by id, in this flow
  });

  it("deletes an unused draft version", async () => {
    expect((await del("flow_a", 3)).status).toBe(200);
    expect(ids("flow_a")).toEqual(["a2", "a1"]);
  });

  it("refuses the live version with 409", async () => {
    const res = await del("flow_a", 2);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("v2 is the live version. Publish a newer version first.");
    expect(ids("flow_a")).toEqual(["a3", "a2", "a1"]);
    expect(deleteCalls).toEqual([]);
  });

  it("refuses a version a call run used, so call history keeps it", async () => {
    const res = await del("flow_b", 4);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatch(/was used by a call run/);
    expect(ids("flow_b")).toEqual(["b5", "b4"]);
    expect(deleteCalls).toEqual([]);
  });

  it("refuses the flow's only version", async () => {
    const res = await del("only", 1);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("This is the flow's only version. Remove the flow instead.");
    expect(ids("only")).toEqual(["o1"]);
  });

  it("only finds versions of the flow in the URL: another flow's version is a 404", async () => {
    const res = await del("flow_a", 5); // v5 exists, but in flow_b
    expect(res.status).toBe(404);
    expect(ids("flow_b")).toEqual(["b5", "b4"]);
    expect(deleteCalls).toEqual([]);
  });

  it("404s for an unknown or archived flow, and 400s for a bad version number", async () => {
    expect((await del("nope", 1)).status).toBe(404);
    flows[0]!.archivedAt = new Date();
    expect((await del("flow_a", 1)).status).toBe(404);
    expect((await del("flow_b", "abc")).status).toBe(400);
    expect((await del("flow_b", 0)).status).toBe(400);
  });

  it("is admin-only: an editor gets 403 and nothing is deleted", async () => {
    const res = await del("flow_a", 1, "EDITOR");
    expect(res.status).toBe(403);
    expect(ids("flow_a")).toEqual(["a3", "a2", "a1"]);
    expect(deleteCalls).toEqual([]);
  });
});
