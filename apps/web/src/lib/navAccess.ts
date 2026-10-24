// Pages editors don't get: the template and call-flow editors, and the admin-only pages. Admins see everything.
// Used by the sidebar (Layout) and the routes (App), so menu and URL access can't drift.
// No JSX here, so the rule is unit-tested from the API test suite.

/** Paths hidden from the EDITOR role (menu item and the page itself). */
export const EDITOR_HIDDEN_PATHS: readonly string[] = ["/templates", "/whatsapp-templates", "/call-flows"];

/** Paths only ADMIN may see (menu item and the page itself). */
export const ADMIN_ONLY_PATHS: readonly string[] = ["/data-quality"];

/** Whether `role` may see the page at `path`. EDITOR loses EDITOR_HIDDEN_PATHS; only ADMIN gets ADMIN_ONLY_PATHS. */
export function canSeePath(path: string, role: string | null | undefined): boolean {
  if (ADMIN_ONLY_PATHS.includes(path)) return role === "ADMIN";
  return !(role === "EDITOR" && EDITOR_HIDDEN_PATHS.includes(path));
}

/** Drop the items `role` can't see, then any section left with no items (its heading goes too). */
export function navForRole<T extends { to: string }, G extends { items: T[] }>(groups: G[], role: string | null | undefined): G[] {
  return groups
    .map((g) => ({ ...g, items: g.items.filter((n) => canSeePath(n.to, role)) }))
    .filter((g) => g.items.length > 0);
}
