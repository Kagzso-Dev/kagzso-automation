import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Templates → Delete. A template used by a finished bulk send (Send Queue) can be deleted: the batch
// keeps its history and the template's name. Campaigns, triggers and running sends still block it,
// with a message instead of the old 500. Prisma is mocked.

const db = vi.hoisted(() => ({
  template: { findUnique: vi.fn(), delete: vi.fn() },
  manualSendBatch: { count: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
}));
vi.mock("../src/prisma.js", () => ({ prisma: db }));

const { deleteTemplate, batchTemplateLabel } = await import("../src/domain/templateDelete.js");

const tpl = (campaigns = 0, triggers = 0) => ({ name: "Kagzso-lead", _count: { campaigns, triggers } });

beforeEach(() => {
  vi.clearAllMocks();
  db.template.findUnique.mockResolvedValue(tpl());
  db.template.delete.mockResolvedValue({});
  db.manualSendBatch.count.mockResolvedValue(0);
  db.manualSendBatch.updateMany.mockResolvedValue({ count: 9 });
});

describe("deleteTemplate", () => {
  it("deletes a template used by finished bulk sends, keeping their history and its name", async () => {
    await expect(deleteTemplate("t1")).resolves.toEqual({ ok: true });
    expect(db.manualSendBatch.count).toHaveBeenCalledWith({ where: { templateId: "t1", status: "RUNNING" } });
    expect(db.manualSendBatch.updateMany).toHaveBeenCalledWith({
      where: { templateId: "t1" },
      data: { templateId: null, deletedTemplateName: "Kagzso-lead" },
    });
    expect(db.template.delete).toHaveBeenCalledWith({ where: { id: "t1" } });
    expect(db.$transaction).toHaveBeenCalledTimes(1); // unlink + delete together, or neither
  });

  it("refuses while a bulk send using it is still running", async () => {
    db.manualSendBatch.count.mockResolvedValue(1);
    const r = await deleteTemplate("t1");
    expect(r).toMatchObject({ ok: false, status: 409, message: expect.stringMatching(/still running in the Send Queue/) });
    expect(db.template.delete).not.toHaveBeenCalled();
    expect(db.manualSendBatch.updateMany).not.toHaveBeenCalled();
  });

  it("refuses while a campaign or trigger uses it, saying which", async () => {
    db.template.findUnique.mockResolvedValue(tpl(1, 0));
    expect(await deleteTemplate("t1")).toMatchObject({ status: 409, message: expect.stringMatching(/used by 1 campaign\. Change or delete it first/) });
    db.template.findUnique.mockResolvedValue(tpl(2, 1));
    expect(await deleteTemplate("t1")).toMatchObject({ status: 409, message: expect.stringMatching(/used by 2 campaigns and 1 trigger\. Change or delete them/) });
    expect(db.template.delete).not.toHaveBeenCalled();
  });

  it("not found → 404; put to use mid-delete (P2003) → 409, never a 500", async () => {
    db.template.findUnique.mockResolvedValueOnce(null);
    expect(await deleteTemplate("nope")).toMatchObject({ ok: false, status: 404 });
    db.template.delete.mockRejectedValueOnce(Object.assign(new Error("Foreign key constraint violated"), { code: "P2003" }));
    expect(await deleteTemplate("t1")).toMatchObject({ ok: false, status: 409 });
  });

  it("labels a batch whose template was deleted", () => {
    expect(batchTemplateLabel({ template: { name: "Welcome" }, deletedTemplateName: null })).toBe("Welcome");
    expect(batchTemplateLabel({ template: null, deletedTemplateName: "Kagzso-lead" })).toBe("Kagzso-lead (deleted)");
    expect(batchTemplateLabel({ template: null, deletedTemplateName: null })).toBe("Template (deleted)");
  });
});

describe("DELETE /api/templates/:id", () => {
  let server: Server;
  let base = "";
  const token = (role: "ADMIN" | "EDITOR") =>
    jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);
  const del = (role: "ADMIN" | "EDITOR" = "ADMIN") =>
    fetch(`${base}/api/templates/t1`, { method: "DELETE", headers: { Authorization: `Bearer ${token(role)}` } });

  beforeAll(async () => {
    const { createApp } = await import("../src/http/app.js");
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("204 when deleted", async () => {
    expect((await del()).status).toBe(204);
  });

  it("409 with the reason (shown under the Delete button) instead of a 500", async () => {
    db.manualSendBatch.count.mockResolvedValue(2);
    const res = await del();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/still running in the Send Queue/);
  });

  it("404 for an unknown template; editors still can't delete", async () => {
    db.template.findUnique.mockResolvedValueOnce(null);
    expect((await del()).status).toBe(404);
    expect((await del("EDITOR")).status).toBe(403);
    expect(db.template.delete).not.toHaveBeenCalled();
  });
});
