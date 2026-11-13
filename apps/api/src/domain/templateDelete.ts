import { prisma } from "../prisma.js";

export type DeleteTemplateResult = { ok: true } | { ok: false; status: 404 | 409; message: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Delete an email template (Templates page → Delete).
 *
 * Refused while a campaign or trigger uses it (they would have nothing to send), and while a
 * bulk send using it is still running in the Send Queue. A bulk send that has finished or been
 * cancelled does not block it: the batch stays in the Send Queue with its counts and per-contact
 * results, its link to the template is cleared and the template's name is kept in
 * `deletedTemplateName`, so the history still says which email went out (migration 0035).
 */
export async function deleteTemplate(id: string): Promise<DeleteTemplateResult> {
  const tpl = await prisma.template.findUnique({
    where: { id },
    select: { name: true, _count: { select: { campaigns: true, triggers: true } } },
  });
  if (!tpl) return { ok: false, status: 404, message: "Template not found" };

  const { campaigns, triggers } = tpl._count;
  if (campaigns > 0 || triggers > 0) {
    const users = [campaigns && plural(campaigns, "campaign"), triggers && plural(triggers, "trigger")].filter(Boolean);
    return {
      ok: false,
      status: 409,
      message: `This template is used by ${users.join(" and ")}. Change or delete ${campaigns + triggers === 1 ? "it" : "them"} first, then delete the template.`,
    };
  }

  const running = await prisma.manualSendBatch.count({ where: { templateId: id, status: "RUNNING" } });
  if (running > 0) {
    return {
      ok: false,
      status: 409,
      message: `A bulk send using this template is still running in the Send Queue. Wait for it to finish (or cancel it), then delete the template.`,
    };
  }

  try {
    await prisma.$transaction([
      prisma.manualSendBatch.updateMany({
        where: { templateId: id },
        data: { templateId: null, deletedTemplateName: tpl.name },
      }),
      prisma.template.delete({ where: { id } }),
    ]);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "P2025") return { ok: false, status: 404, message: "Template not found" };
    // A campaign or trigger was pointed at it between the check and the delete.
    if (code === "P2003") {
      return { ok: false, status: 409, message: "This template was just put to use by a campaign or trigger. Reload and try again." };
    }
    throw err;
  }
  return { ok: true };
}

/** Send Queue label for a batch's template, also after the template was deleted. */
export function batchTemplateLabel(batch: { template: { name: string } | null; deletedTemplateName: string | null }): string {
  if (batch.template) return batch.template.name;
  return `${batch.deletedTemplateName ?? "Template"} (deleted)`;
}
