import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader } from "../components/Layout";
import { ErrorNote, Spinner, Table } from "../components/ui";
import { Icon } from "../components/icons";
import { useConfirm } from "../components/confirm";
import { HIDEABLE_NAV_ITEMS, type HideableNavItem } from "@dispatch/shared";
import { SIDEBAR_SETTINGS_KEY, useSidebarHiddenItems } from "../lib/sidebar";
import { CostRatesSection } from "../components/CostRatesSection";
import { ChangePasswordSection, UsersSection } from "../components/UserAdminSections";
import { BrandingSection } from "../components/BrandingSection";
import { CallRecordingsSection } from "../components/CallRecordingsSection";
import { AiCallLanguagesSection } from "../components/AiCallLanguagesSection";
import { Switch } from "../components/Switch";

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  lastUsed?: string | null;
  createdAt: string;
}

export function SettingsPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [name, setName] = useState("");
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const isAdmin = user?.role === "ADMIN";

  const keys = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => api<{ items: ApiKey[] }>("/api/api-keys"),
    enabled: isAdmin,
  });
  const create = useMutation({
    mutationFn: () => api<ApiKey & { key: string }>("/api/api-keys", { method: "POST", json: { name } }),
    onSuccess: (k) => {
      setFreshKey(k.key);
      setCopied(false);
      setName("");
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/api/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });

  // Admin hid Settings from editors (Settings → Sidebar menu): editors opening the link go to the dashboard.
  const hiddenForEditors = useSidebarHiddenItems().includes("settings-editors");
  if (!isAdmin && hiddenForEditors) return <Navigate to="/" replace />;

  return (
    <div className="settings-page">
      <PageHeader title="Settings" subtitle="Manage API keys, WhatsApp, sending limits and your workspace." />

      <section className="settings-section">
        <h2 className="settings-heading">API keys</h2>
        {!isAdmin ? (
          <div className="settings-card text-slate-550">Only admins can manage API keys.</div>
        ) : (
          <>
            <div className="settings-card mb-4">
              <label className="label">New key name</label>
              <div className="settings-row">
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Production webhook"
                />
                <button
                  className="btn-primary settings-btn"
                  disabled={!name || create.isPending}
                  onClick={() => create.mutate()}
                >
                  Create key
                </button>
              </div>
              {create.error ? <div className="mt-2"><ErrorNote error={create.error} /></div> : null}
              {freshKey && (
                <div className="mt-4 rounded-[14px] border border-warn-bright/30 bg-warn-soft p-3.5 text-sm">
                  <div className="mb-1 font-medium text-warn">
                    Your new API key — copy it now. You can also reveal it later from the table below.
                  </div>
                  <code className="mt-1 block break-all rounded-md bg-surface/70 px-2 py-1.5 font-mono text-xs text-ink">{freshKey}</code>
                  <button
                    className="text-action -ml-2 mt-2"
                    onClick={async () => {
                      await navigator.clipboard?.writeText(freshKey);
                      setCopied(true);
                    }}
                  >
                    {copied ? "Copied" : "Copy key"}
                  </button>
                </div>
              )}
            </div>

            {keys.isLoading ? (
              <Spinner />
            ) : keys.data && keys.data.items.length > 0 ? (
              <Table head={["Name", "Prefix", "Last used", "Created", ""]}>
                {keys.data.items.map((k) => {
                  const full = revealed[k.id];
                  return (
                  <tr key={k.id} className="border-b border-line-subtle last:border-0">
                    <td className="px-4 py-3 font-medium text-ink">{k.name}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className="mono-pill break-all">{full ?? `${k.prefix}…`}</span>
                      {full ? (
                        <button
                          className="text-action ml-1.5"
                          onClick={async () => {
                            await navigator.clipboard?.writeText(full);
                            setCopiedId(k.id);
                          }}
                        >
                          {copiedId === k.id ? "Copied" : "Copy"}
                        </button>
                      ) : (
                        <button
                          className="text-action ml-1.5"
                          onClick={async () => {
                            const { key } = await api<{ key: string }>(`/api/api-keys/${k.id}/reveal`);
                            setRevealed((r) => ({ ...r, [k.id]: key }));
                            setCopiedId(null);
                          }}
                        >
                          Reveal
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-slate-550">
                      {k.lastUsed ? new Date(k.lastUsed).toLocaleString() : "never"}
                    </td>
                    <td className="px-4 py-2.5 text-slate-550">
                      {new Date(k.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        className="text-action-danger"
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Revoke key "${k.name}"?`,
                            body: "Requests using this key will start failing immediately.",
                            confirmText: "Revoke",
                            tone: "danger",
                          });
                          if (ok) del.mutate(k.id);
                        }}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </Table>
            ) : (
              <div className="settings-card text-slate-550">No API keys yet.</div>
            )}
          </>
        )}
      </section>

      <WhatsAppSection isAdmin={isAdmin} />

      <BulkSendPacingSection isAdmin={isAdmin} />

      <AllowedDomainsSection isAdmin={isAdmin} />

      <SidebarMenuSection isAdmin={isAdmin} />

      {isAdmin && <BrandingSection />}

      <CostRatesSection isAdmin={isAdmin} />

      {isAdmin && <AiProvidersLink />}

      {isAdmin && <AiCallLanguagesSection />}

      {isAdmin && <CallRecordingsSection />}

      <UsersSection isAdmin={isAdmin} />

      <ChangePasswordSection isAdmin={isAdmin} />
    </div>
  );
}

/* ------------------------------------------------------------------ sidebar menu */

const SIDEBAR_ITEM_LABELS: Record<HideableNavItem, string> = {
  insights: "Insights",
  lists: "Lists",
  campaigns: "Campaigns",
  triggers: "Triggers",
  "whatsapp-inbox": "WhatsApp Inbox",
  "settings-editors": "Settings (for editors — admins always see it)",
  "ai-providers": "AI Providers",
};

/** Rows only admins see in the panel (they only change what admins see, or are admin pages). */
const ADMIN_ONLY_SIDEBAR_ROWS: readonly HideableNavItem[] = ["settings-editors", "ai-providers"];

/** A short line under a row in the Sidebar menu panel. */
const SIDEBAR_ITEM_NOTES: Partial<Record<HideableNavItem, string>> = {
  "ai-providers": "Admins can still open AI Providers from Settings.",
};

/**
 * Settings → "Open AI Providers" (admins only). Always reachable here, even when the AI Providers
 * item is hidden from the sidebar menu.
 */
export function AiProvidersLink() {
  return (
    <section className="settings-section">
      <h2 className="settings-heading">AI Providers</h2>
      <div className="settings-card flex flex-wrap items-center justify-between gap-3">
        <p className="text-slate-550">Language model, speech-to-text and text-to-speech providers for AI calls, per language.</p>
        <Link to="/admin/ai-providers" className="btn-ghost settings-btn">
          Open AI Providers
        </Link>
      </div>
    </section>
  );
}

export function SidebarMenuSection({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const saved = useSidebarHiddenItems();
  const savedKey = saved.join(",");
  const [hidden, setHidden] = useState<HideableNavItem[]>(saved);
  const [message, setMessage] = useState<string | null>(null);

  // Follow the server value (first load, or a save from another tab).
  useEffect(() => {
    setHidden(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const dirty = [...hidden].sort().join(",") !== [...saved].sort().join(",");

  const save = useMutation({
    mutationFn: (hiddenItems: HideableNavItem[]) =>
      api<{ hiddenItems: HideableNavItem[] }>("/api/settings/sidebar", {
        method: "PUT",
        json: { hiddenItems },
        notify: false,
      }),
    onSuccess: (res, sent) => {
      // Writing the cache updates the sidebar immediately — no reload.
      qc.setQueryData(SIDEBAR_SETTINGS_KEY, res);
      setHidden(res.hiddenItems);
      setMessage(sent.length === 0 ? "Saved — all menu items are shown." : "Saved — the sidebar is updated.");
    },
    onMutate: () => setMessage(null),
  });

  const toggle = (item: HideableNavItem, show: boolean) => {
    setMessage(null);
    setHidden((h) => (show ? h.filter((x) => x !== item) : [...h, item]));
  };

  return (
    <section className="settings-section">
      <h2 className="settings-heading">Sidebar</h2>
      <div className="settings-card space-y-4">
        <div className="font-semibold text-ink">Sidebar menu</div>
        <p className="text-slate-550">
          Hidden pages are only removed from the menu. They still work if you open the link directly.
          This applies to everyone in the workspace.
        </p>

        <ul className="divide-y divide-line-subtle">
          {/* Admin-only rows ("Settings (for editors)", "AI Providers") — editors don't see them. */}
          {HIDEABLE_NAV_ITEMS.filter((item) => isAdmin || !ADMIN_ONLY_SIDEBAR_ROWS.includes(item)).map((item) => {
            const shown = !hidden.includes(item);
            const note = SIDEBAR_ITEM_NOTES[item];
            return (
              <li key={item} className="flex items-center justify-between gap-3 py-3">
                <span>
                  <span className="block font-medium text-ink">{SIDEBAR_ITEM_LABELS[item]}</span>
                  {note && <span className="block text-xs text-slate-550">{note}</span>}
                </span>
                <label className="flex items-center gap-2 text-xs text-slate-550">
                  {shown ? "Shown" : "Hidden"}
                  <Switch
                    on={shown}
                    label={`Show ${SIDEBAR_ITEM_LABELS[item]} in the sidebar`}
                    disabled={!isAdmin || save.isPending}
                    onChange={(on) => toggle(item, on)}
                  />
                </label>
              </li>
            );
          })}
        </ul>

        {isAdmin ? (
          <div className="flex flex-wrap items-center gap-2.5 border-t border-line-subtle pt-4">
            <button
              type="button"
              className="btn-primary settings-btn"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate(hidden)}
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="btn-ghost settings-btn"
              disabled={save.isPending || (saved.length === 0 && hidden.length === 0)}
              onClick={() => save.mutate([])}
            >
              Reset to default
            </button>
            {message && !dirty && <span className="text-ok">{message}</span>}
          </div>
        ) : (
          <p className="text-xs text-slate-550">Only admins can change which menu items are shown.</p>
        )}

        {save.error && <ErrorNote error={save.error} />}
      </div>
    </section>
  );
}

interface SendConfig {
  emailProvider: "mock" | "smtp";
  emailFrom: string;
  senderAddress: string;
  smtpHost: string | null;
  dailyCap: number;
  ratePerSec: number;
  deliveryFeedback: boolean;
  bulkSend: { minDelaySec: number; maxDelaySec: number };
}

const code = "code-chip";

/** A code chip with a small copy button (clipboard only — a visual helper). */
function CopyChip({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="code-chip gap-1.5 pr-1">
      {text}
      <button
        type="button"
        className="rounded px-1 font-sans text-[11px] font-medium text-accent-ink transition-colors hover:bg-tint"
        aria-label={`Copy ${text}`}
        onClick={async () => {
          await navigator.clipboard?.writeText(text);
          setCopied(true);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

/** The credentials editor is hidden; WhatsApp is configured via .env only. */
const SHOW_WHATSAPP_CREDENTIALS_FORM = false;

function WhatsAppSection({ isAdmin }: { isAdmin: boolean }) {
  const { data, isLoading } = useQuery({
    queryKey: ["whatsapp-config"],
    queryFn: () =>
      api<{ configured: boolean; provider: string; phoneNumberId: string | null }>("/api/whatsapp/config"),
  });

  return (
    <section className="settings-section">
      <h2 className="settings-heading">WhatsApp</h2>
      <div className="settings-card space-y-4">
        {isLoading || !data ? (
          <Spinner />
        ) : data.configured ? (
          <div className="settings-banner-ok">
            <Icon name="check" size={18} className="mt-0.5 shrink-0" />
            <p>
              Connected — sending WhatsApp messages through the Meta WhatsApp Cloud API from phone
              number ID <code className={code}>{data.phoneNumberId}</code>.
            </p>
          </div>
        ) : (
          <div className="settings-banner-warn">
            <Icon name="info" size={18} className="mt-0.5 shrink-0" />
            <p>
              Not configured — set the Meta access token and phone number ID in .env to enable the
              “Send message” buttons. This is fully separate from email — leaving it blank has no
              effect on email sending.
            </p>
          </div>
        )}
        <p className="text-slate-550">
          Delivery receipts and replies arrive on the webhook{" "}
          <CopyChip text="/api/webhooks/whatsapp" /> — set{" "}
          <code className={code}>https://&lt;your public API host&gt;/api/webhooks/whatsapp</code> as
          the callback URL in your Meta app (WhatsApp → Configuration), with the verify token
          from .env, and subscribe to the <code className={code}>messages</code> field.
        </p>
        <p className="text-slate-550">
          WhatsApp contacts, templates and sends are stored separately from email and never touch
          Contacts, Templates or Campaigns.
        </p>
      </div>

      {SHOW_WHATSAPP_CREDENTIALS_FORM &&
        (isAdmin ? (
          <WhatsAppCredentialsForm />
        ) : (
          <p className="mt-2 text-xs text-slate-550">Only admins can manage WhatsApp credentials.</p>
        ))}
    </section>
  );
}

interface WhatsAppCredentialsView {
  provider: string;
  graphApiVersion: string;
  phoneNumberId: string | null;
  wabaId: string | null;
  hasAccessToken: boolean;
  hasAppSecret: boolean;
  hasWebhookVerifyToken: boolean;
  configured: boolean;
  webhookConfigured: boolean;
  source: "database" | "environment";
}

type ConnectionCheck =
  | {
      ok: true;
      phoneNumber: { id: string; displayPhoneNumber?: string; verifiedName?: string; qualityRating?: string };
    }
  | { ok: false; error: string };

type SecretField = "accessToken" | "appSecret" | "webhookVerifyToken";

const SECRET_FIELDS: { key: SecretField; label: string; has: "hasAccessToken" | "hasAppSecret" | "hasWebhookVerifyToken" }[] = [
  { key: "accessToken", label: "Access token (system user, permanent)", has: "hasAccessToken" },
  { key: "appSecret", label: "App secret (verifies webhook signatures)", has: "hasAppSecret" },
  { key: "webhookVerifyToken", label: "Webhook verify token", has: "hasWebhookVerifyToken" },
];

const BLANK_SECRETS: Record<SecretField, string> = { accessToken: "", appSecret: "", webhookVerifyToken: "" };

/**
 * Meta WhatsApp Cloud API credentials, editable here instead of via .env +
 * restart. Saved to the DB (Setting table) as an override on top of .env — the
 * secrets are write-only, they're never sent back to the browser once saved.
 */
function WhatsAppCredentialsForm() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["whatsapp-credentials"],
    queryFn: () => api<WhatsAppCredentialsView>("/api/whatsapp/credentials"),
  });

  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [secrets, setSecrets] = useState(BLANK_SECRETS);
  const [dirty, setDirty] = useState(false);

  // Seed the visible fields from the server once (or when it changes from
  // elsewhere) — secret fields always start blank since they're write-only.
  useEffect(() => {
    if (data) {
      setPhoneNumberId(data.phoneNumberId ?? "");
      setWabaId(data.wabaId ?? "");
      setSecrets(BLANK_SECRETS);
      setDirty(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.phoneNumberId, data?.wabaId]);

  const check = useMutation({
    mutationFn: () => api<ConnectionCheck>("/api/whatsapp/credentials/check"),
  });

  const onSaved = (v: WhatsAppCredentialsView) => {
    qc.setQueryData(["whatsapp-credentials"], v);
    qc.invalidateQueries({ queryKey: ["whatsapp-config"] });
    setSecrets(BLANK_SECRETS);
    setDirty(false);
    check.reset();
  };

  const save = useMutation({
    mutationFn: () => {
      // Only send a secret if the admin actually typed a new one — an
      // untouched, still-blank field must not wipe out a saved value.
      const typed = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v));
      return api<WhatsAppCredentialsView>("/api/whatsapp/credentials", {
        method: "PUT",
        json: { phoneNumberId, wabaId, ...typed },
      });
    },
    onSuccess: onSaved,
  });

  const reset = useMutation({
    mutationFn: () => api<WhatsAppCredentialsView>("/api/whatsapp/credentials", { method: "DELETE" }),
    onSuccess: onSaved,
  });

  if (isLoading || !data) return <div className="card mt-3"><Spinner /></div>;
  const busy = save.isPending || reset.isPending;

  return (
    <form
      className="card mt-3 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <p className="text-xs text-slate-550">
        {data.source === "database"
          ? "Using credentials saved here — they take priority over .env."
          : "Using credentials from .env — save below to override them without a restart."}{" "}
        Graph API {data.graphApiVersion}.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Phone number ID</label>
          <input
            className="input font-mono text-xs"
            value={phoneNumberId}
            inputMode="numeric"
            placeholder="e.g. 106540352242922"
            disabled={busy}
            onChange={(e) => {
              setPhoneNumberId(e.target.value);
              setDirty(true);
            }}
          />
        </div>
        <div>
          <label className="label">WhatsApp Business Account ID</label>
          <input
            className="input font-mono text-xs"
            value={wabaId}
            inputMode="numeric"
            placeholder="e.g. 102290129340398"
            disabled={busy}
            onChange={(e) => {
              setWabaId(e.target.value);
              setDirty(true);
            }}
          />
        </div>
      </div>

      {SECRET_FIELDS.map((f) => (
        <div key={f.key}>
          <label className="label">{f.label}</label>
          <input
            className="input font-mono text-xs"
            type="password"
            autoComplete="off"
            value={secrets[f.key]}
            placeholder={data[f.has] ? "•••••••••••••••• (unchanged — type to replace)" : "Not set"}
            disabled={busy}
            onChange={(e) => {
              setSecrets({ ...secrets, [f.key]: e.target.value });
              setDirty(true);
            }}
          />
        </div>
      ))}

      {!data.webhookConfigured && (
        <p className="text-xs text-warn">
          Set the app secret and webhook verify token to receive delivery receipts and replies —
          the webhook rejects every request until both are set.
        </p>
      )}

      {save.error && <ErrorNote error={save.error} />}
      {reset.error && <ErrorNote error={reset.error} />}
      {check.error && <ErrorNote error={check.error} />}
      {check.data &&
        (check.data.ok ? (
          <p className="rounded-lg bg-ok-soft p-3 text-xs text-ok">
            Connection OK — {check.data.phoneNumber.displayPhoneNumber ?? check.data.phoneNumber.id}
            {check.data.phoneNumber.verifiedName ? ` (${check.data.phoneNumber.verifiedName})` : ""}
            {check.data.phoneNumber.qualityRating ? `, quality ${check.data.phoneNumber.qualityRating}` : ""}.
          </p>
        ) : (
          <p className="rounded-lg bg-warn-soft p-3 text-xs text-warn">
            Connection failed — {check.data.error}
          </p>
        ))}

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-primary" disabled={!dirty || busy}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={dirty || busy || check.isPending || !data.configured}
          title={dirty ? "Save first" : undefined}
          onClick={() => check.mutate()}
        >
          {check.isPending ? "Checking…" : "Test connection"}
        </button>
        {data.source === "database" && (
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => reset.mutate()}>
            {reset.isPending ? "Resetting…" : "Reset to .env values"}
          </button>
        )}
        {save.isSuccess && !dirty && <span className="text-ok">Saved.</span>}
      </div>
    </form>
  );
}

function BulkSendPacingSection({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["send-config"],
    queryFn: () => api<SendConfig>("/api/settings/config"),
  });

  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [dirty, setDirty] = useState(false);

  // Seed the inputs from the server value once it arrives / changes.
  const serverMin = data?.bulkSend.minDelaySec;
  const serverMax = data?.bulkSend.maxDelaySec;
  useEffect(() => {
    if (serverMin !== undefined && serverMax !== undefined) {
      setMin(String(serverMin));
      setMax(String(serverMax));
      setDirty(false);
    }
  }, [serverMin, serverMax]);

  const save = useMutation({
    mutationFn: () =>
      api<{ minDelaySec: number; maxDelaySec: number }>("/api/settings/bulk-send", {
        method: "PUT",
        json: { minDelaySec: Number(min), maxDelaySec: Number(max) },
      }),
    onSuccess: (v) => {
      qc.setQueryData<SendConfig>(["send-config"], (c) => (c ? { ...c, bulkSend: v } : c));
      qc.invalidateQueries({ queryKey: ["send-config"] });
      setDirty(false);
    },
  });

  return (
    <section className="settings-section">
      <h2 className="settings-heading">
        Bulk send pacing
      </h2>
      <div className="settings-card space-y-4">
        <p className="text-slate-550">
          When you send a template to several contacts at once from the Contacts page, they go out one
          at a time with a random gap in this range between each — never all at once — to avoid
          provider spam blocks. A change here applies to the next batch; batches already running keep
          the delay they started with.
        </p>

        {isLoading || !data ? (
          <Spinner />
        ) : (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (isAdmin) save.mutate();
            }}
          >
            <div>
              <label className="label">Min gap (seconds)</label>
              <div className="input-suffix">
                <input
                  className="input w-32 pr-11"
                  type="number"
                  min={1}
                  max={3600}
                  value={min}
                  disabled={!isAdmin || save.isPending}
                  onChange={(e) => {
                    setMin(e.target.value);
                    setDirty(true);
                  }}
                />
                <span>sec</span>
              </div>
            </div>
            <div>
              <label className="label">Max gap (seconds)</label>
              <div className="input-suffix">
                <input
                  className="input w-32 pr-11"
                  type="number"
                  min={1}
                  max={3600}
                  value={max}
                  disabled={!isAdmin || save.isPending}
                  onChange={(e) => {
                    setMax(e.target.value);
                    setDirty(true);
                  }}
                />
                <span>sec</span>
              </div>
            </div>
            {isAdmin && (
              <button className="btn-primary settings-btn" disabled={!dirty || save.isPending}>
                {save.isPending ? "Saving…" : "Save"}
              </button>
            )}
            {save.isSuccess && !dirty && <span className="text-ok">Saved.</span>}
          </form>
        )}

        {save.error && <ErrorNote error={save.error} />}

        {!isAdmin && (
          <p className="text-xs text-slate-550">Only admins can change the pacing.</p>
        )}
      </div>
    </section>
  );
}

interface AllowedDomain {
  id: string;
  domain: string;
  createdAt: string;
}

function AllowedDomainsSection({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [domain, setDomain] = useState("");

  const list = useQuery({
    queryKey: ["allowed-domains"],
    queryFn: () => api<{ items: AllowedDomain[] }>("/api/settings/allowed-domains"),
  });
  const add = useMutation({
    mutationFn: () =>
      api("/api/settings/allowed-domains", { method: "POST", json: { domain } }),
    onSuccess: () => {
      setDomain("");
      qc.invalidateQueries({ queryKey: ["allowed-domains"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/settings/allowed-domains/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allowed-domains"] }),
  });

  const items = list.data?.items ?? [];

  return (
    <section className="settings-section">
      <h2 className="settings-heading">
        Approved sending domains
      </h2>
      <div className="settings-card space-y-4">
        <p className="text-slate-550">
          {items.length === 0
            ? "No restriction — email can be sent to any address. Add a domain to restrict sending."
            : "Contacts are only emailed when their address domain is on this list. Others are skipped at import and never sent to."}
        </p>

        {isAdmin && (
          <form
            className="settings-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (domain.trim()) add.mutate();
            }}
          >
            <input
              className="input"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="gmail.com"
            />
            <button className="btn-primary settings-btn" disabled={!domain.trim() || add.isPending}>
              Add domain
            </button>
          </form>
        )}
        {add.error ? <ErrorNote error={add.error} /> : null}

        {list.isLoading ? (
          <Spinner />
        ) : items.length > 0 ? (
          <ul className="divide-y divide-line-subtle">
            {items.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="domain-chip">@{d.domain}</span>
                {isAdmin && (
                  <button
                    className="text-action-danger"
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Remove @${d.domain} from the approved list?`,
                        body: "New imports and sends to this domain will be blocked.",
                        confirmText: "Remove",
                        tone: "danger",
                      });
                      if (ok) remove.mutate(d.id);
                    }}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
