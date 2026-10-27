import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useAiCallsConfig } from "../lib/aiCalls";
import { useInboxUnread } from "../lib/whatsappInbox";
import { useSidebarHiddenItems } from "../lib/sidebar";
import { useBranding, useDocumentTitle } from "../lib/branding";
import { navForRole } from "../lib/navAccess";
import { aiCallLanguagePath, splitAiCallLanguagePath, type AiCallLanguageInfo, type HideableNavItem } from "@dispatch/shared";
import { Icon, type IconName } from "./icons";
import { Logo } from "./Logo";

type NavEntry = {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
  /** Set only on items an admin may hide from Settings → Sidebar menu. */
  hideKey?: HideableNavItem;
};

type NavGroup = { label: string; items: NavEntry[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Main",
    items: [
      { to: "/", label: "Dashboard", icon: "dashboard", end: true },
      { to: "/data-quality", label: "Data Quality", icon: "quality" }, // admins only (lib/navAccess)
      { to: "/insights", label: "Insights", icon: "insights", hideKey: "insights" },
      { to: "/lists", label: "Lists", icon: "lists", hideKey: "lists" },
    ],
  },
  {
    label: "Email",
    items: [
      { to: "/contacts", label: "Email Contacts", icon: "contacts" },
      { to: "/templates", label: "Email Templates", icon: "templates" },
      { to: "/campaigns", label: "Campaigns", icon: "campaigns", hideKey: "campaigns" },
      { to: "/triggers", label: "Triggers", icon: "triggers", hideKey: "triggers" },
    ],
  },
  {
    label: "WhatsApp",
    items: [
      { to: "/whatsapp-contacts", label: "WhatsApp Contacts", icon: "whatsapp" },
      { to: "/whatsapp-templates", label: "WhatsApp Templates", icon: "whatsapp" },
      { to: "/whatsapp-inbox", label: "WhatsApp Inbox", icon: "inbox", hideKey: "whatsapp-inbox" },
    ],
  },
  {
    label: "Calls",
    items: [
      { to: "/ai-call-customers", label: "Voicecall Contact", icon: "phone" },
      { to: "/call-flows", label: "Voice Call Flows", icon: "phone" },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/send-queue", label: "Send Queue", icon: "activity" },
      { to: "/settings", label: "Settings", icon: "settings", hideKey: "settings-editors" },
    ],
  },
];

/**
 * The "Calls" section once more AI call languages are switched on: English keeps its items
 * (labelled "Calls · English"), and each other language gets the same two pages under its own
 * address (/ta/ai-call-customers, /ta/call-flows) in a section of its own, right after it.
 */
export function withLanguageGroups(groups: NavGroup[], languages: AiCallLanguageInfo[]): NavGroup[] {
  const others = languages.filter((l) => l.code !== "en" && l.enabled);
  if (others.length === 0) return groups;
  return groups.flatMap((g) =>
    g.label !== "Calls"
      ? [g]
      : [
          { ...g, label: "Calls · English" },
          ...others.map((l) => ({
            label: `Calls · ${l.name}`,
            items: g.items.map((n) => ({ ...n, to: aiCallLanguagePath(l.code, n.to) })),
          })),
        ],
  );
}

const COLLAPSE_KEY = "dispatch:sidebar-collapsed";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  // "Voice Call Flows" (/call-flows) shows for admins and editors while ENABLE_AI_CALLS + ENABLE_CALL_FLOW_EDITOR are on.
  const aiCalls = useAiCallsConfig();
  const showCallFlows = !!aiCalls.data?.flowEditor && !!aiCalls.data.canStart;
  // "Voicecall Contact" (/ai-call-customers) only shows for admins while ENABLE_AI_CALLS is on.
  const showAiCustomers = !!aiCalls.data?.enabled && !!aiCalls.data.canStart;
  // Optional items an admin hid in Settings → Sidebar menu (workspace-wide).
  const hidden = new Set<string>(useSidebarHiddenItems());
  // Unread customer messages on the "WhatsApp Inbox" item (admins only; polls while the tab is
  // visible, and not at all while the item is hidden from the menu).
  const inboxUnread = useInboxUnread(user?.role === "ADMIN" && !hidden.has("whatsapp-inbox")).data?.messages ?? 0;
  // App name from Settings → Branding ("Dispatch" until an admin changes it).
  const { appName } = useBranding();
  useDocumentTitle(appName);
  const groups = navForRole(
    withLanguageGroups(NAV_GROUPS, aiCalls.data?.languages ?? []).map((g) => ({
      ...g,
      items: g.items.filter((n) => {
        const page = splitAiCallLanguagePath(n.to).path; // "/ta/call-flows" follows "/call-flows"
        return (
          (page !== "/call-flows" || showCallFlows) &&
          (page !== "/ai-call-customers" || showAiCustomers) &&
          (n.to !== "/whatsapp-inbox" || user?.role === "ADMIN") && // customer messages: admins only
          // Settings hidden "for editors" never hides from admins (they must be able to turn it back on).
          !(n.hideKey && hidden.has(n.hideKey) && !(n.hideKey === "settings-editors" && user?.role === "ADMIN"))
        );
      }),
    })),
    user?.role, // editors don't see the template and call-flow editors (lib/navAccess)
  ); // a group with nothing left loses its label too
  // The page's language and its page without the language part ("/ta/call-flows" → "ta", "/call-flows").
  const current = splitAiCallLanguagePath(location.pathname);

  // Desktop icon-rail state — persisted across reloads.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  // Mobile off-canvas drawer — always starts closed.
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      /* storage unavailable — non-fatal */
    }
  }, [collapsed]);

  // Route change closes the mobile drawer.
  useEffect(() => setMobileOpen(false), [location.pathname]);

  // While the drawer is open: Escape closes it and body scroll is locked.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [mobileOpen]);

  return (
    <div className="md:flex">
      {/* Mobile top bar (hidden on desktop) */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-surface/90 px-3 backdrop-blur md:hidden">
        <button
          type="button"
          className="grid h-9 w-9 place-items-center rounded-lg text-slate-550 transition-colors hover:bg-tint hover:text-ink"
          aria-label="Open navigation menu"
          aria-expanded={mobileOpen}
          aria-controls="app-sidebar"
          onClick={() => setMobileOpen(true)}
        >
          <Icon name="menu" size={20} />
        </button>
        <span className="flex items-center gap-2 font-mono text-sm font-semibold">
          <Logo size={28} /> {appName}
        </span>
      </header>

      {/* Backdrop for the mobile drawer */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-[6px] animate-overlay-in md:hidden"
          aria-hidden="true"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar — off-canvas drawer on mobile, width-animated rail on desktop */}
      <aside
        id="app-sidebar"
        className={cx(
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-line/70 bg-surface/90 backdrop-blur-xl",
          "transition-[transform,width] duration-300 ease-in-out-soft motion-reduce:transition-none",
          "md:sticky md:top-0 md:z-auto md:h-screen md:bg-surface/80 md:shadow-[4px_0_24px_rgba(17,24,39,0.04)]",
          mobileOpen ? "translate-x-0 shadow-rail" : "-translate-x-full",
          "md:translate-x-0",
          collapsed ? "md:w-16" : "md:w-64",
        )}
      >
        {/* Collapsed desktop rail: logo only, centred */}
        {collapsed && (
          <div className="hidden shrink-0 justify-center pt-3 md:flex">
            <Logo size={28} />
          </div>
        )}

        {/* Brand + collapse / close toggles */}
        <div
          className={cx(
            "flex h-14 shrink-0 items-center gap-2 px-3",
            collapsed && "md:justify-center md:px-2",
          )}
        >
          <span
            className={cx(
              "flex min-w-0 items-center gap-2 font-mono text-sm font-bold tracking-tight text-ink",
              collapsed && "md:hidden",
            )}
          >
            <Logo size={28} />
            <span className="truncate">{appName}</span>
          </span>

          {/* Desktop collapse toggle */}
          <button
            type="button"
            className={cx(
              "hidden h-9 w-9 place-items-center rounded-lg text-slate-550 transition-colors hover:bg-tint hover:text-ink md:grid",
              collapsed ? "md:ml-0" : "md:ml-auto",
            )}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={collapsed}
            onClick={() => setCollapsed((v) => !v)}
          >
            <Icon name="sidebar" size={18} />
          </button>

          {/* Mobile close */}
          <button
            type="button"
            className="ml-auto grid h-9 w-9 place-items-center rounded-lg text-slate-550 transition-colors hover:bg-tint hover:text-ink md:hidden"
            aria-label="Close navigation menu"
            onClick={() => setMobileOpen(false)}
          >
            <Icon name="close" size={20} />
          </button>
        </div>

        {/* Primary navigation */}
        {/* Scrolls on its own so the footer below never covers the last item. */}
        <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4 pt-2">
          {groups.map((g, gi) => (
            <div
              key={g.label}
              role="group"
              aria-labelledby={`nav-group-${gi}`}
              className={cx(gi > 0 && "mt-5", gi > 0 && collapsed && "md:mt-2 md:border-t md:border-line/70 md:pt-2")}
            >
              {/* Section label — hidden on the collapsed desktop rail (a divider shows instead). */}
              <div
                id={`nav-group-${gi}`}
                className={cx(
                  "mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500",
                  collapsed && "md:sr-only",
                )}
              >
                {g.label}
              </div>
              <ul className="flex flex-col gap-0.5">
                {g.items.map((n) => (
                  <li key={n.to}>
                    <NavLink
                      to={n.to}
                      end={n.end}
                      title={collapsed ? n.label : undefined}
                      className={({ isActive }) =>
                        cx(
                          "nav-link",
                          collapsed && "md:justify-center md:px-0",
                          isActive && "nav-link-active",
                        )
                      }
                    >
                      <Icon name={n.icon} size={18} className="shrink-0" />
                      <span className={cx("nav-label truncate", collapsed && "md:hidden")}>{n.label}</span>
                      {n.to === "/whatsapp-inbox" && inboxUnread > 0 && (
                        <span
                          className={cx(
                            "pill-gradient ml-auto",
                            collapsed && "md:hidden",
                          )}
                          aria-label={`${inboxUnread} unread`}
                        >
                          {inboxUnread > 99 ? "99+" : inboxUnread}
                        </span>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        {/* Footer — account + sign out (pinned below the scrolling menu) */}
        <div className={cx("shrink-0 border-t border-line/70 p-3", collapsed && "md:px-2")}>
          {/* Expanded footer: always on mobile, on desktop only when not collapsed */}
          <div className={cx("sidebar-user", collapsed && "md:hidden")}>
            <div className="flex min-w-0 items-center gap-3">
              <span className="sidebar-avatar" aria-hidden="true">
                {user?.email?.[0] ?? "?"}
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-ink" title={user?.email}>
                  {user?.email}
                </div>
                <span className="sidebar-role">{user?.role}</span>
              </div>
            </div>
            <button type="button" className="sidebar-signout" onClick={() => logout()}>
              <Icon name="logout" size={14} /> Sign out
            </button>
          </div>

          {/* Collapsed rail footer: desktop only, only when collapsed */}
          {collapsed && (
            <div className="hidden flex-col items-center gap-2 md:flex">
              <span className="sidebar-avatar" title={user?.email}>
                {user?.email?.[0] ?? "?"}
              </span>
              <button
                type="button"
                className="grid h-8 w-8 place-items-center rounded-lg text-slate-550 transition-colors hover:bg-crit-soft hover:text-crit"
                aria-label="Sign out"
                title="Sign out"
                onClick={() => logout()}
              >
                <Icon name="logout" size={16} />
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Page content */}
      <main className="min-w-0 flex-1 pb-16">
        {/* Keyed on the top-level section only: replays the entrance animation when switching pages
            without remounting anything a route change wouldn't already remount. */}
        <div
          key={(current.language === "en" ? "" : `${current.language}:`) + current.path.split("/")[1]}
          className={cx(
            "page-enter mx-auto px-4 py-6 sm:px-6 lg:px-8 lg:py-8",
            // Voice Call Flows needs room for list + editor + live preview; every other page keeps 1120px.
            current.path.startsWith("/call-flows") ? "max-w-[1400px]" : "max-w-[1120px]",
          )}
        >
          {children}
        </div>
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="page-title">
          <GradientLastWord text={title} />
        </h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}

/** Renders a multi-word title with its last word in the accent gradient ("Send <Queue>"). Text is unchanged. */
function GradientLastWord({ text }: { text: string }) {
  const cut = text.trimEnd().lastIndexOf(" ");
  if (cut <= 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, cut + 1)}
      <span className="text-gradient">{text.slice(cut + 1)}</span>
    </>
  );
}
