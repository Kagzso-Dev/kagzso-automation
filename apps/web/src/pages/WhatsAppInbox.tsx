import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { BUTTON_REPLY_INTENT_LABELS, formatPhoneDisplay } from "@dispatch/shared";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDateTime } from "../lib/schedule";
import { ACCEPT_ANY, formatBytes, uploadWithProgress } from "../lib/whatsappMedia";
import { INBOX_POLL_MS, type Conversation, type ConversationPage, type Thread, type ThreadMessage } from "../lib/whatsappInbox";
import { PageHeader } from "../components/Layout";
import { WhatsAppMedia } from "../components/WhatsAppMedia";
import { useFillHeight } from "../components/QueueTable";
import { Badge, EmptyState, ErrorNote } from "../components/ui";
import { Icon } from "../components/icons";

/**
 * WhatsApp Inbox (admins): conversations with customers who messaged us — their
 * photos, videos, voice notes, documents and locations — and free-form replies
 * (text or one attachment). WhatsApp only allows those replies within 24 hours
 * of the customer's last message; after that, send an approved template.
 *
 * Both panels scroll inside a fixed-height area (the page itself doesn't).
 * Refreshes every few seconds while the tab is visible, without moving the
 * selected chat or the scroll position.
 */

const TYPE_LABEL: Record<string, string> = {
  image: "📷 Photo",
  video: "🎬 Video",
  audio: "🎤 Voice / audio",
  document: "📄 Document",
  sticker: "Sticker",
  location: "📍 Location",
  button: "Button reply",
  interactive: "Button reply",
  reaction: "Reaction",
  contacts: "Contact card",
};

const LIST_PAGE = 30;
const THREAD_PAGE = 40;
const showPhone = (digits: string) => formatPhoneDisplay(`+${digits}`);

/** "14:05" today, "Mon" this week, else "12 Oct". */
function shortTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (now.getTime() - d.getTime() < 6 * 24 * 3600_000) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function WhatsAppInboxPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const list = useInfiniteQuery({
    queryKey: ["whatsapp-inbox", "list", query],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ page: String(pageParam), pageSize: String(LIST_PAGE) });
      if (query) p.set("search", query);
      return api<ConversationPage>(`/api/whatsapp/inbox?${p}`);
    },
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
    enabled: isAdmin,
    refetchInterval: INBOX_POLL_MS,
    refetchIntervalInBackground: false,
  });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const total = list.data?.pages[0]?.total ?? 0;

  const box = useRef<HTMLDivElement>(null);
  const height = useFillHeight(box, 24);

  if (!isAdmin) {
    return (
      <div>
        <PageHeader title="WhatsApp Inbox" />
        <EmptyState icon="inbox" title="Admins only">
          Customer messages and files are visible to admins only.
        </EmptyState>
      </div>
    );
  }

  const nothingYet = !list.isLoading && !list.error && total === 0 && !query;

  return (
    <div>
      <PageHeader
        title="WhatsApp Inbox"
        subtitle="Messages customers sent you, with their photos, videos, voice notes and documents. Reply within 24 hours of their last message."
      />
      {nothingYet ? (
        <EmptyState icon="inbox" title="No messages yet">
          Customer replies arrive here once the Meta webhook is connected (WhatsApp → Configuration in the Meta app,
          callback <code>/api/webhooks/whatsapp</code>).
        </EmptyState>
      ) : (
        <div
          ref={box}
          className="grid min-h-0 gap-4 md:grid-cols-[20rem_1fr]"
          style={{ height: height ?? undefined }}
        >
          {/* Conversations — on mobile hidden while a chat is open */}
          <section className={`min-h-0 flex-col overflow-hidden rounded-2xl border border-line/70 bg-surface shadow-card ${selected ? "hidden md:flex" : "flex"}`}>
            <div className="shrink-0 border-b border-line-subtle p-3">
              <input
                className="input py-1.5"
                placeholder="Search name or number"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search conversations"
              />
            </div>
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
              {list.isLoading ? (
                <ListSkeleton />
              ) : list.error ? (
                <div className="p-3">
                  <ErrorNote error={list.error} />
                </div>
              ) : items.length === 0 ? (
                <p className="p-4 text-sm text-slate-550">No conversations match “{query}”.</p>
              ) : (
                <ul>
                  {items.map((c) => (
                    <ConversationRow key={c.phone} c={c} active={c.phone === selected} onPick={() => setSelected(c.phone)} />
                  ))}
                </ul>
              )}
              {list.hasNextPage && (
                <div className="p-2 text-center">
                  <button className="btn-ghost py-1 text-xs" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
                    {list.isFetchingNextPage ? "Loading…" : "Load more"}
                  </button>
                </div>
              )}
            </div>
          </section>

          {/* Chat — on mobile shown full width with a back button */}
          <section className={`min-h-0 flex-col overflow-hidden rounded-2xl border border-line/70 bg-surface shadow-card ${selected ? "flex" : "hidden md:flex"}`}>
            {selected ? (
              <ConversationView key={selected} phone={selected} onBack={() => setSelected(null)} />
            ) : (
              <div className="grid flex-1 place-items-center p-6 text-center text-sm text-slate-550">
                Select a conversation to read and reply.
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function ConversationRow({ c, active, onPick }: { c: Conversation; active: boolean; onPick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className={`w-full border-b border-line-subtle px-3 py-3 text-left transition-colors duration-150 hover:bg-tint ${active ? "bg-accent-soft shadow-[inset_3px_0_0_rgb(var(--c-accent))] hover:bg-accent-soft" : ""}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className={`truncate ${c.unread ? "font-semibold" : "font-medium"}`}>{c.name || showPhone(c.phone)}</span>
          <span className={`shrink-0 text-[11px] ${c.unread ? "text-wa-ink" : "text-slate-550"}`}>{shortTime(c.lastMessageAt)}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-550">
          <span className="truncate">{c.lastPreview || TYPE_LABEL[c.lastType] || c.lastType}</span>
          {c.unread > 0 ? (
            <span className="pill-gradient ml-auto shrink-0">
              {c.unread > 99 ? "99+" : c.unread}
            </span>
          ) : (
            c.windowOpen && <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-wa/60" title="Reply window open" />
          )}
        </div>
      </button>
    </li>
  );
}

function ListSkeleton() {
  return (
    <ul aria-label="Loading" role="status">
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i} className="border-b border-line-subtle px-3 py-3">
          <div className="mb-2 h-3.5 w-2/3 animate-pulse rounded bg-surface-muted" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-surface-muted" />
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ one conversation */

function ConversationView({ phone, onBack }: { phone: string; onBack: () => void }) {
  const qc = useQueryClient();
  const scroller = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const now = useNow(30_000);

  const thread = useInfiniteQuery({
    queryKey: ["whatsapp-inbox", "thread", phone],
    queryFn: ({ pageParam }) =>
      api<Thread>(`/api/whatsapp/inbox/${phone}?limit=${THREAD_PAGE}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.nextBefore : undefined),
    refetchInterval: (q) =>
      q.state.data?.pages[0]?.messages.some((m) => m.media?.status === "PENDING" || m.status === "SENDING") ? 3000 : INBOX_POLL_MS,
    refetchIntervalInBackground: false,
  });

  // pages[0] = newest; older pages follow. Show oldest → newest, one entry per message.
  const messages = useMemo(() => {
    const seen = new Set<string>();
    const out: ThreadMessage[] = [];
    for (const p of [...(thread.data?.pages ?? [])].reverse()) {
      for (const m of p.messages) {
        const k = `${m.direction}-${m.id}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push(m);
        }
      }
    }
    return out;
  }, [thread.data]);
  const head = thread.data?.pages[0];

  // Scrolling: jump to the newest message when opened; follow new messages only if
  // already near the bottom; keep the view still when older messages are prepended.
  const prev = useRef<{ count: number; height: number; top: number; first: string | null } | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || messages.length === 0) return;
    const firstKey = `${messages[0]!.direction}-${messages[0]!.id}`;
    const p = prev.current;
    if (!p) el.scrollTop = el.scrollHeight;
    else if (p.first !== firstKey && messages.length > p.count) el.scrollTop = el.scrollHeight - p.height + p.top; // older loaded
    else if (messages.length > p.count && p.height - p.top - el.clientHeight < 120) el.scrollTop = el.scrollHeight; // new at bottom
    prev.current = { count: messages.length, height: el.scrollHeight, top: el.scrollTop, first: firstKey };
  }, [messages]);

  // Mark read when opened and whenever a new customer message shows up while it's open.
  const newestInbound = [...messages].reverse().find((m) => m.direction === "in")?.id ?? null;
  const markRead = useMutation({
    mutationFn: () => api(`/api/whatsapp/inbox/${phone}/read`, { method: "POST", notify: false }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["whatsapp-inbox", "list"] });
      void qc.invalidateQueries({ queryKey: ["whatsapp-inbox-unread"] });
    },
  });
  useEffect(() => {
    if (newestInbound) markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestInbound]);

  const send = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append("text", text);
      if (file) form.append("file", file);
      setProgress(file ? 0 : null);
      return uploadWithProgress<ThreadMessage>("POST", `/api/whatsapp/inbox/${phone}/reply`, form, setProgress);
    },
    onSettled: () => setProgress(null),
    onSuccess: (msg) => {
      if (msg.status !== "FAILED") {
        setText("");
        setFile(null);
      }
      void qc.invalidateQueries({ queryKey: ["whatsapp-inbox"] });
      requestAnimationFrame(() => scroller.current && (scroller.current.scrollTop = scroller.current.scrollHeight));
    },
  });

  const windowEnds = head?.windowEndsAt ? new Date(head.windowEndsAt).getTime() : 0;
  const windowOpen = windowEnds > now;
  const left = Math.max(0, windowEnds - now);
  const leftLabel = left >= 3600_000 ? `${Math.floor(left / 3600_000)}h ${Math.floor((left % 3600_000) / 60_000)}m` : `${Math.max(1, Math.ceil(left / 60_000))}m`;
  const canSend = windowOpen && (text.trim() !== "" || !!file) && !send.isPending;

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line-subtle px-3 py-3 sm:px-4">
        <button type="button" className="btn-ghost px-2 py-1 md:hidden" onClick={onBack} aria-label="Back to conversations">
          ←
        </button>
        <div className="min-w-0">
          <div className="truncate font-semibold text-ink">{head?.name || showPhone(phone)}</div>
          <div className="font-mono text-xs text-slate-550">{showPhone(phone)}</div>
        </div>
        {head &&
          (windowOpen ? (
            <span className="ml-auto rounded-full bg-ok-soft px-2.5 py-0.5 text-xs font-medium text-ok" title={`Until ${formatDateTime(head.windowEndsAt)}`}>
              Reply window: {leftLabel} left
            </span>
          ) : (
            <span className="ml-auto rounded-full bg-warn-soft px-2.5 py-0.5 text-xs font-medium text-warn">Reply window closed</span>
          ))}
      </div>

      <div ref={scroller} className="msg-list scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto bg-surface-sunken px-3 py-4 sm:px-4">
        {thread.isLoading ? (
          <ThreadSkeleton />
        ) : thread.error ? (
          <ErrorNote error={thread.error} />
        ) : (
          <>
            {thread.hasNextPage && (
              <div className="text-center">
                <button className="btn-ghost py-1 text-xs" disabled={thread.isFetchingNextPage} onClick={() => thread.fetchNextPage()}>
                  {thread.isFetchingNextPage ? "Loading…" : "Load older messages"}
                </button>
              </div>
            )}
            {messages.length === 0 && <p className="text-center text-sm text-slate-550">No messages in this conversation.</p>}
            {messages.map((m) => (
              <Bubble key={`${m.direction}-${m.id}`} m={m} />
            ))}
          </>
        )}
      </div>

      <form
        className="shrink-0 border-t border-line-subtle bg-surface px-3 py-3 sm:px-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) send.mutate();
        }}
      >
        {head && !windowOpen && (
          <p className="mb-2 rounded-lg border border-warn-bright/30 bg-warn-soft px-3 py-2 text-xs text-warn">
            More than 24 hours since the customer's last message — WhatsApp only allows an approved template now (WhatsApp
            Contacts → Send WhatsApp).
          </p>
        )}
        {file && (
          <div className="mb-2 flex items-center gap-2 text-xs text-slate-550">
            <Icon name="download" size={12} />
            <span className="truncate">
              {file.name} · {formatBytes(file.size)}
            </span>
            <button type="button" className="text-crit hover:underline" onClick={() => setFile(null)}>
              Remove
            </button>
          </div>
        )}
        {progress !== null && (
          <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
            <div className="h-full rounded-full bg-gradient-accent transition-[width]" style={{ width: `${progress}%` }} />
          </div>
        )}
        {send.error && <ErrorNote error={send.error} />}
        <div className="flex items-end gap-2">
          <button
            type="button"
            className="btn-ghost px-2.5"
            title="Attach a photo, video, audio file or document"
            disabled={!windowOpen || send.isPending}
            onClick={() => fileRef.current?.click()}
          >
            📎
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT_ANY}
            hidden
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              e.target.value = "";
            }}
          />
          <textarea
            className="input min-h-[2.5rem] flex-1 resize-y"
            rows={1}
            placeholder={windowOpen ? (file ? "Caption (optional)" : "Type a reply") : "Reply window closed"}
            value={text}
            maxLength={file ? 1024 : 4096}
            disabled={!windowOpen || send.isPending}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (canSend) send.mutate();
              }
            }}
          />
          <button className="btn-primary" disabled={!canSend}>
            {send.isPending ? (progress !== null ? `Sending ${progress}%` : "Sending…") : "Send"}
          </button>
        </div>
      </form>
    </>
  );
}

function Bubble({ m }: { m: ThreadMessage }) {
  const out = m.direction === "out";
  const hideText = !!m.media && !!m.text && m.text.startsWith(`[${m.media.kind}]`);
  return (
    <div className={`flex ${out ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm shadow-[0_2px_8px_rgba(17,24,39,0.06)] sm:max-w-[70%] ${out ? "rounded-br-md bg-accent-soft text-ink" : "rounded-bl-md border border-line/60 bg-surface text-ink"}`}>
        {m.template && <div className="mb-1 text-[11px] font-medium text-slate-550">Template · {m.template}</div>}
        {m.replyIntent && (
          <div className="mb-1" title="Quick-reply button the customer tapped (label only; nothing is changed)">
            <Badge tone={m.replyIntent === "interested" ? "ok" : "neutral"}>{BUTTON_REPLY_INTENT_LABELS[m.replyIntent]}</Badge>
          </div>
        )}
        {m.media && (
          <div className="mb-1">
            <WhatsAppMedia media={m.media} compact zoomable />
          </div>
        )}
        {m.type === "location" && m.location ? (
          <a
            className="text-accent-ink hover:underline"
            href={`https://www.google.com/maps?q=${m.location.latitude},${m.location.longitude}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            📍 {[m.location.name, m.location.address].filter(Boolean).join(" — ") || `${m.location.latitude}, ${m.location.longitude}`}
          </a>
        ) : (
          m.text && !hideText && <div className="whitespace-pre-wrap break-words">{m.text}</div>
        )}
        {!m.text && !m.media && !m.location && <div className="italic text-slate-550">{TYPE_LABEL[m.type] ?? m.type}</div>}
        <div className="mt-1 flex items-center justify-end gap-1.5 text-[11px] text-slate-550">
          <span title={formatDateTime(m.at)}>{shortTime(m.at)}</span>
          {out && <Ticks status={m.status} error={m.error} />}
        </div>
        {m.error && <div className="mt-1 text-[11px] text-crit">{m.error}</div>}
      </div>
    </div>
  );
}

/** WhatsApp-style delivery ticks for our messages. */
function Ticks({ status, error }: { status: string | null; error: string | null }) {
  switch (status) {
    case "QUEUED":
    case "SENDING":
      return <span title="Sending">🕓</span>;
    case "SENT":
      return <span title="Sent">✓</span>;
    case "DELIVERED":
      return <span title="Delivered">✓✓</span>;
    case "READ":
      return (
        <span className="text-accent-ink" title="Read">
          ✓✓
        </span>
      );
    case "FAILED":
      return (
        <span className="font-semibold text-crit" title={error ?? "Failed"}>
          !
        </span>
      );
    case "SKIPPED":
      return <span title={error ?? "Skipped"}>—</span>;
    default:
      return null;
  }
}

function ThreadSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="space-y-3">
      {[60, 40, 70, 35].map((w, i) => (
        <div key={i} className={`flex ${i % 2 ? "justify-end" : "justify-start"}`}>
          <div className="skeleton h-10 rounded-2xl" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}
