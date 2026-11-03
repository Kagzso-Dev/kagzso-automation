// The shared category / industry library of AI Agents (one for every language: no language column).
// Archived entries stay for agents that already use them, but can't be picked for new ones.

import type { AiCategoryView } from "@dispatch/shared";
import { prisma } from "../prisma.js";

export class AiIndustryError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "AiIndustryError";
  }
}

const dupe = (err: unknown) => (err as { code?: string } | null)?.code === "P2002";

export async function listLibrary(includeArchived = false): Promise<AiCategoryView[]> {
  const cats = await prisma.aiBusinessCategory.findMany({
    where: includeArchived ? {} : { archivedAt: null },
    orderBy: { name: "asc" },
    include: { industries: { where: includeArchived ? {} : { archivedAt: null }, orderBy: { name: "asc" } } },
  });
  return cats.map((c) => ({
    id: c.id,
    name: c.name,
    archivedAt: c.archivedAt?.toISOString() ?? null,
    industries: c.industries.map((i) => ({
      id: i.id,
      categoryId: i.categoryId,
      name: i.name,
      discoveryTopics: i.discoveryTopics ?? "",
      archivedAt: i.archivedAt?.toISOString() ?? null,
    })),
  }));
}

export async function createCategory(name: string) {
  try {
    return await prisma.aiBusinessCategory.create({ data: { name } });
  } catch (err) {
    if (dupe(err)) throw new AiIndustryError(`A category "${name}" already exists`, 409);
    throw err;
  }
}

export async function updateCategory(id: string, data: { name?: string; archived?: boolean }) {
  const c = await prisma.aiBusinessCategory.findUnique({ where: { id } });
  if (!c) throw new AiIndustryError("Category not found", 404);
  try {
    return await prisma.aiBusinessCategory.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.archived !== undefined ? { archivedAt: data.archived ? new Date() : null } : {}),
      },
    });
  } catch (err) {
    if (dupe(err)) throw new AiIndustryError(`A category "${data.name}" already exists`, 409);
    throw err;
  }
}

export async function createIndustry(input: { categoryId: string; name: string; discoveryTopics: string }) {
  const c = await prisma.aiBusinessCategory.findUnique({ where: { id: input.categoryId } });
  if (!c || c.archivedAt) throw new AiIndustryError("Category not found", 404);
  try {
    return await prisma.aiIndustry.create({ data: { ...input, discoveryTopics: input.discoveryTopics || null } });
  } catch (err) {
    if (dupe(err)) throw new AiIndustryError(`"${input.name}" already exists in that category`, 409);
    throw err;
  }
}

export async function updateIndustry(id: string, data: { name?: string; discoveryTopics?: string; archived?: boolean }) {
  const i = await prisma.aiIndustry.findUnique({ where: { id } });
  if (!i) throw new AiIndustryError("Industry not found", 404);
  try {
    return await prisma.aiIndustry.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.discoveryTopics !== undefined ? { discoveryTopics: data.discoveryTopics || null } : {}),
        ...(data.archived !== undefined ? { archivedAt: data.archived ? new Date() : null } : {}),
      },
    });
  } catch (err) {
    if (dupe(err)) throw new AiIndustryError(`"${data.name}" already exists in that category`, 409);
    throw err;
  }
}
