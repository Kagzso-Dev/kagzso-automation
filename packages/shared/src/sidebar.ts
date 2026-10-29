import { z } from "zod";

/* ------------------------------------------------------------------ sidebar menu */
// Workspace-wide choice of which optional menu items the sidebar hides. Hiding
// only removes the link from the menu; the page and its route keep working.

/**
 * The only menu items an admin may hide. Everything else always shows. New keys
 * are appended: a stored list without them simply shows those items.
 * "settings-editors" hides Settings from editors only — admins always keep it.
 * "ai-providers" is an admin-only page, so hiding it only changes the admins' menu.
 */
export const HIDEABLE_NAV_ITEMS = ["insights", "lists", "campaigns", "triggers", "whatsapp-inbox", "settings-editors", "ai-providers"] as const;
export type HideableNavItem = (typeof HIDEABLE_NAV_ITEMS)[number];

/** Setting-table key holding the hidden items as a JSON array, e.g. ["insights","lists"]. */
export const SIDEBAR_HIDDEN_ITEMS_KEY = "sidebar_hidden_items";

export const sidebarSettingsInput = z.object({
  hiddenItems: z.array(z.enum(HIDEABLE_NAV_ITEMS)).max(HIDEABLE_NAV_ITEMS.length),
});
export type SidebarSettingsInput = z.infer<typeof sidebarSettingsInput>;

/**
 * Turn whatever is stored (or nothing) into a clean list: unknown values,
 * duplicates and non-arrays are dropped, so a bad row means "show everything".
 */
export function normalizeHiddenNavItems(value: unknown): HideableNavItem[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<string>(HIDEABLE_NAV_ITEMS);
  return HIDEABLE_NAV_ITEMS.filter((item) => value.includes(item) && allowed.has(item));
}
