// Pages editors don't get: the template and call-flow editors. Admins see everything.
// Used by the sidebar (Layout) and the routes (App), so menu and URL access can't drift.
// No JSX here, so the rule is unit-tested from the API test suite.

/** Paths hidden from the EDITOR role (menu item and the page itself). */
export const EDITOR_HIDDEN_PATHS: readonly string[] = ["/templates", "/whatsapp-templates", "/call-flows"];

/** Whether `role` may see the page at `path`. Only EDITOR is restricted; other roles keep everything. */
export function canSeePath(path: string, role: string | null | undefined): boolean {
  return !(role === "EDITOR" && EDITOR_HIDDEN_PATHS.includes(path));
}

/** Drop the items `role` can't see, then any section left with no items (its heading goes too). */
export function navForRole<T extends { to: string }, G extends { items: T[] }>(groups: G[], role: string | null | undefined): G[] {
  return groups
    .map((g) => ({ ...g, items: g.items.filter((n) => canSeePath(n.to, role)) }))
    .filter((g) => g.items.length > 0);
}
