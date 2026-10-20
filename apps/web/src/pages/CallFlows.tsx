import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CALL_FLOW_BASES,
  CALL_FLOW_SAFETY_BLOCK_IDS,
  CALL_FLOW_VARIABLES,
  callFlowDefinition,
  isLockedBlock,
  lacksDoNotCallHandling,
  materializeUnlockedBlocks,
  type CallFlowBase,
  type CallFlowDefinition,
  type CallFlowGroup,
  type CallFlowTextBlock,
  type TestCallNumber,
  type TestCallNumberList,
} from "@dispatch/shared";
import { api } from "../lib/api";
import { useAiCallsConfig, type AiCallRun } from "../lib/aiCalls";
import {
  BASE_LABELS,
  useCallFlowCatalog,
  useCallFlows,
  type CallFlowCatalog,
  type CallFlowDetail,
  type CallFlowListItem,
  type CallFlowPreview,
  type CallFlowVersion,
} from "../lib/callFlows";
import { PageHeader } from "../components/Layout";
import { Badge, EmptyState, ErrorNote, Modal, Spinner } from "../components/ui";
import { useConfirm } from "../components/confirm";
import { useToast } from "../components/toast";
import { Icon } from "../components/icons";
import { VoicePicker } from "../components/VoicePicker";
import { PhoneInput, phoneError } from "../components/PhoneInput";
import { ImportPromptModal } from "../components/ImportPromptModal";

/**
 * "Call Flows": edit what the AI voice agent says. A flow is a copy of a built-in
 * script (Nila screening / Follow-up) split into blocks. Safety blocks (do-not-call,
 * wrong person, data rules, …) are locked: shown here, never editable. Saving makes
 * a draft; publishing freezes it as a new version that AI call runs can pick.
 */

const TABS: { key: CallFlowGroup | "locked"; label: string }[] = [
  { key: "greeting", label: "Greeting" },
  { key: "main_script", label: "Main script" },
  { key: "questions", label: "Questions" },
  { key: "objections", label: "Objection handling" },
  { key: "closing", label: "Closing" },
  { key: "tone", label: "Tone & style" },
  { key: "rules", label: "Rules" },
  { key: "locked", label: "Safety (locked)" },
];

const SAMPLES = [
  { label: "Male, with name", customer_name: "Ragul", gender: "male", follow_up_detail: "" },
  { label: "Female, follow-up detail", customer_name: "Priya", gender: "female", follow_up_detail: "the quotation for 20 laptops" },
  { label: "Unknown gender, no name", customer_name: "", gender: "unknown", follow_up_detail: "" },
];
type Sample = Omit<(typeof SAMPLES)[number], "label">;

const blockTitle = (text: string) => text.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") ?? "Untitled";
const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");
/** Names for blocks whose text starts without a heading. */
const BLOCK_LABELS: Record<string, string> = { rules_safety: "Safety rules 21–31", rules_style: "Rules 32 onward" };
const SAFETY_IDS = new Set<string>(CALL_FLOW_SAFETY_BLOCK_IDS);

export function CallFlowsPage() {
  const config = useAiCallsConfig();
  const enabled = !!config.data?.flowEditor && !!config.data.canStart; // admins and editors
  const flows = useCallFlows(enabled);
  const catalog = useCallFlowCatalog();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<CallFlowListItem | null>(null);

  if (config.isLoading) return <Spinner />;
  if (!enabled) {
    return (
      <div>
        <PageHeader title="Call Flows" />
        <EmptyState>
          Call flows are turned off. An admin can enable them with ENABLE_AI_CALLS and ENABLE_CALL_FLOW_EDITOR.
        </EmptyState>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Call Flows"
        action={
          <button className="btn-primary" onClick={() => setCreating(true)} disabled={!catalog.data}>
            New call flow
          </button>
        }
      />
      <p className="-mt-2 mb-4 max-w-3xl text-sm text-slate-550">
        What the AI voice agent says on calls. Calls use the server's default flow unless you pick a published flow
        in the AI Call window. Safety rules (AI disclosure, do-not-call, no false claims) always apply and can't be edited.
      </p>
      {catalog.error && <ErrorNote error={catalog.error} />}
      {catalog.data && <BuiltinScripts catalog={catalog.data} onCustomized={setSelectedId} />}
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-[0.06em] text-slate-550">Your call flows</h2>
      <div className={selectedId ? "grid gap-6 min-[1600px]:grid-cols-[280px_minmax(0,1fr)]" : "flex flex-col gap-4"}>
        <div className="min-w-0">
          {flows.isLoading ? (
            <Spinner />
          ) : flows.error ? (
            <ErrorNote error={flows.error} />
          ) : flows.data!.items.length === 0 ? (
            <EmptyState>
              No custom flows yet. Press <b>Customize</b> on a built-in script above to make an editable copy.
            </EmptyState>
          ) : (
            <ul
              className={
                selectedId
                  ? // A flow is open: a strip above the editor, a sticky column beside it from 1600px.
                    "scroll-thin flex gap-2 overflow-x-auto pb-1 min-[1600px]:sticky min-[1600px]:top-4 min-[1600px]:flex-col min-[1600px]:overflow-visible min-[1600px]:pb-0"
                  : "grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              }
            >
              {flows.data!.items.map((f) => (
                <li
                  key={f.id}
                  className={`flex items-center gap-1 rounded-lg border transition-colors ${
                    selectedId ? "w-60 shrink-0 min-[1600px]:w-auto" : "bg-surface shadow-sm"
                  } ${selectedId === f.id ? "border-accent/40 bg-accent-soft text-accent-ink" : "border-line/70 hover:bg-tint"}`}
                >
                  <button className="min-w-0 flex-1 px-3 py-2.5 text-left text-sm" onClick={() => setSelectedId(f.id)}>
                    <div className="truncate font-medium" title={f.name}>{f.name}</div>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {f.published ? <Badge tone="ok">v{f.published.version} live</Badge> : <Badge>not published</Badge>}
                      {f.draft && <Badge tone="warn">draft v{f.draft.version}</Badge>}
                    </div>
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${f.name}`}
                    title={f.published ? `Remove (live v${f.published.version})` : "Remove"}
                    className="mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-tint hover:text-crit"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRemoving(f);
                    }}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {selectedId && catalog.data ? (
          <CallFlowEditor
            key={selectedId}
            flowId={selectedId}
            catalog={catalog.data}
            onClose={() => setSelectedId(null)}
          />
        ) : (
          <EmptyState>Select a call flow or create a new one.</EmptyState>
        )}
      </div>
      <NewFlowModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          setSelectedId(id);
        }}
      />
      <RemoveFlowDialog
        flow={removing}
        onClose={() => setRemoving(null)}
        onRemoved={(id) => {
          if (selectedId === id) setSelectedId(null);
          setRemoving(null);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ remove a flow */

const REMOVE_CONFIRM_WORD = "DELETE";

/**
 * Remove a custom flow. A live (published) one needs DELETE typed exactly (case-sensitive);
 * a draft only needs the button. The server's reason is shown here when it refuses.
 */
function RemoveFlowDialog({
  flow,
  onClose,
  onRemoved,
}: {
  flow: CallFlowListItem | null;
  onClose: () => void;
  onRemoved: (id: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const live = flow?.published ?? null;
  const remove = useMutation({
    mutationFn: (f: CallFlowListItem) =>
      api<{ ok: true; result: "deleted" | "archived" }>(`/api/call-flows/${f.id}`, {
        method: "DELETE",
        json: f.published ? { confirm: typed } : {},
        notify: false,
      }),
    onSuccess: (_res, f) => {
      void qc.invalidateQueries({ queryKey: ["call-flows"] }); // the list here and the AI Call window's picker
      qc.removeQueries({ queryKey: ["call-flow", f.id] });
      toast.success(`Removed “${f.name}”`);
      onRemoved(f.id);
    },
  });
  useEffect(() => {
    setTyped("");
    remove.reset();
  }, [flow?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    if (!remove.isPending) onClose();
  };
  return (
    <Modal open={!!flow} onClose={close} title={flow ? `Remove “${flow.name}”?` : "Remove flow"}>
      {flow && (
        <div className="space-y-3 text-sm">
          {live ? (
            <>
              <p>
                Remove “{flow.name}”? It is <b>LIVE (v{live.version})</b>, so it will stop being available in the AI Call
                window. Past call logs and transcripts are kept. This can't be undone.
              </p>
              <div>
                <label className="label" htmlFor="remove-flow-confirm">
                  Type {REMOVE_CONFIRM_WORD} to confirm
                </label>
                <input
                  id="remove-flow-confirm"
                  className="input font-mono"
                  autoComplete="off"
                  autoFocus
                  value={typed}
                  disabled={remove.isPending}
                  onChange={(e) => setTyped(e.target.value)}
                />
              </div>
            </>
          ) : (
            <p>This draft flow will be removed. Past call logs and transcripts are kept. This can't be undone.</p>
          )}
          {remove.error && <ErrorNote error={remove.error} />}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn-ghost" disabled={remove.isPending} onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger"
              disabled={remove.isPending || (!!live && typed !== REMOVE_CONFIRM_WORD)}
              onClick={() => remove.mutate(flow)}
            >
              {remove.isPending ? "Removing…" : "Remove"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ built-in scripts */

const groupLabel = (g: string) => TABS.find((t) => t.key === g)?.label ?? g;

/** The read-only built-in scripts, always listed so they can be read before copying. */
function BuiltinScripts({ catalog, onCustomized }: { catalog: CallFlowCatalog; onCustomized: (id: string) => void }) {
  const qc = useQueryClient();
  const [viewing, setViewing] = useState<CallFlowBase | null>(null);
  const customize = useMutation({
    mutationFn: (base: CallFlowBase) => {
      const builtin = catalog.flows[base];
      const name = `${builtin.name.replace(/\s*\(default\)\s*$/i, "")} — my copy`.slice(0, 100);
      return api<{ id: string }>("/api/call-flows", { method: "POST", json: { name, base }, notify: "Editable copy created" });
    },
    onSuccess: (f) => {
      void qc.invalidateQueries({ queryKey: ["call-flows"] });
      setViewing(null);
      onCustomized(f.id);
    },
  });

  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-[0.06em] text-slate-550">Built-in scripts</h2>
      <div className="grid gap-3 md:grid-cols-2">
        {CALL_FLOW_BASES.map((base) => {
          const def = catalog.flows[base];
          if (!def) return null;
          const locked = def.blocks.filter((b) => isLockedBlock(b)).length;
          return (
            <div key={base} className="card flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{def.name}</span>
                <Badge tone="accent">built-in</Badge>
                {base === "nila" && <Badge tone="ok">used by AI calls by default</Badge>}
              </div>
              <p className="text-xs text-slate-550">{BASE_LABELS[base]}</p>
              <p className="text-sm">
                Opens with: <i>“{def.greeting.text}”</i>
              </p>
              <p className="text-xs text-slate-550">
                {def.blocks.length - locked} editable blocks · {locked} locked safety blocks
              </p>
              <div className="mt-auto flex gap-2 pt-1">
                <button className="btn-ghost" onClick={() => setViewing(base)}>
                  View script
                </button>
                <button
                  className="btn-primary"
                  disabled={customize.isPending}
                  onClick={() => customize.mutate(base)}
                >
                  {customize.isPending && customize.variables === base ? "Copying…" : "Customize"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {customize.error && (
        <div className="mt-2">
          <ErrorNote error={customize.error} />
        </div>
      )}
      <Modal open={!!viewing} onClose={() => setViewing(null)} title={viewing ? catalog.flows[viewing].name : ""} wide>
        {viewing && (
          <BuiltinView
            def={catalog.flows[viewing]}
            catalog={catalog}
            busy={customize.isPending}
            onCustomize={() => customize.mutate(viewing)}
          />
        )}
      </Modal>
    </section>
  );
}

function BuiltinView({
  def,
  catalog,
  busy,
  onCustomize,
}: {
  def: CallFlowDefinition;
  catalog: CallFlowCatalog;
  busy: boolean;
  onCustomize: () => void;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("greeting");
  const blocks = def.blocks.filter((b) =>
    tab === "locked" ? isLockedBlock(b) : !isLockedBlock(b) && (b as CallFlowTextBlock).group === tab,
  );
  return (
    <div>
      <p className="mb-3 text-sm text-slate-550">
        Read-only. Press <b>Customize</b> to make an editable copy; the built-in script itself never changes.
      </p>
      <div className="mb-3 rounded-lg bg-surface-muted px-3 py-2 text-sm">
        <div>
          <b>First sentence:</b> “{def.greeting.text}”
        </div>
        {def.silence && (
          <div className="mt-1 text-xs text-slate-550">
            Silence: “{def.silence.reprompt}” → “{def.silence.closing}”
          </div>
        )}
      </div>
      <div className="mb-3 flex flex-wrap gap-1">
        {TABS.map((t) => {
          const n = def.blocks.filter((b) =>
            t.key === "locked" ? isLockedBlock(b) : !isLockedBlock(b) && (b as CallFlowTextBlock).group === t.key,
          ).length;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`rounded-full px-3 py-1 text-xs ${tab === t.key ? "bg-gradient-accent font-semibold text-ink shadow-sm" : "bg-surface-muted text-ink"}`}
            >
              {t.label} ({n})
            </button>
          );
        })}
      </div>
      <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
        {blocks.length === 0 && <p className="text-sm text-slate-550">No blocks in {groupLabel(tab)}.</p>}
        {blocks.map((b) => {
          const text = isLockedBlock(b) ? catalog.locked_blocks[b.locked] ?? "" : (b as CallFlowTextBlock).text;
          return (
            <div key={b.id} className="rounded-lg border border-line p-3">
              <div className="mb-1 flex items-center gap-2 text-sm font-medium">
                {blockTitle(text)}
                {isLockedBlock(b) && <Badge tone="neutral">locked</Badge>}
              </div>
              <pre className="whitespace-pre-wrap font-sans text-xs text-slate-550">{text}</pre>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex justify-end">
        <button className="btn-primary" disabled={busy} onClick={onCustomize}>
          {busy ? "Copying…" : "Customize this script"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ new flow */

function NewFlowModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [base, setBase] = useState<CallFlowBase>("nila");
  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>("/api/call-flows", { method: "POST", json: { name: name.trim(), base }, notify: "Call flow created" }),
    onSuccess: (f) => {
      void qc.invalidateQueries({ queryKey: ["call-flows"] });
      setName("");
      onCreated(f.id);
    },
  });
  return (
    <Modal open={open} onClose={onClose} title="New call flow">
      <label className="label">Name</label>
      <input className="input mb-3" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      <label className="label">Start from</label>
      <div className="mb-4 flex flex-col gap-1.5">
        {CALL_FLOW_BASES.map((b) => (
          <label key={b} className="flex items-center gap-2 text-sm">
            <input type="radio" name="flow-base" checked={base === b} onChange={() => setBase(b)} />
            {BASE_LABELS[b]}
          </label>
        ))}
      </div>
      <p className="mb-3 text-xs text-slate-550">The copy starts identical to the built-in script, as a draft.</p>
      {create.error && <ErrorNote error={create.error} />}
      <div className="mt-3 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Creating…" : "Create draft"}
        </button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ editor */

type FieldKey = "greeting" | "silence.reprompt" | "silence.closing" | `block:${string}`;

function CallFlowEditor({
  flowId,
  catalog,
  onClose,
}: {
  flowId: string;
  catalog: CallFlowCatalog;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const detail = useQuery({
    queryKey: ["call-flow", flowId],
    queryFn: () => api<CallFlowDetail>(`/api/call-flows/${flowId}`),
  });
  const versions = detail.data?.versions ?? [];
  const draft = versions.find((v) => v.status === "DRAFT") ?? null;
  const published = versions.find((v) => v.status === "PUBLISHED") ?? null;
  const working = draft ?? published;

  const [form, setForm] = useState<CallFlowDefinition | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("greeting");
  const [testing, setTesting] = useState(false);
  const active = useRef<{ key: FieldKey; el: HTMLInputElement | HTMLTextAreaElement } | null>(null);

  // (Re)load the form whenever the version being edited changes (after save / publish / restore).
  const workingKey = working ? `${working.id}:${working.definitionHash}` : "";
  // Older versions carry do-not-call, wrong person, outcome rules, callback and safety rules 21-31 as
  // locked references: shown (and saved) as editable text with the same words, so nothing changes until edited.
  const baseDefinition = useMemo(
    () => (working ? materializeUnlockedBlocks(working.definition, catalog.locked_blocks) : null),
    [workingKey], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    if (baseDefinition) setForm(structuredClone(baseDefinition));
  }, [workingKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["call-flow", flowId] });
    void qc.invalidateQueries({ queryKey: ["call-flows"] });
  };
  const save = useMutation({
    mutationFn: (definition: CallFlowDefinition) =>
      api(`/api/call-flows/${flowId}/draft`, { method: "PUT", json: { definition }, notify: "Draft saved" }),
    onSuccess: invalidate,
  });
  const publish = useMutation({
    mutationFn: () => api<CallFlowVersion>(`/api/call-flows/${flowId}/publish`, { method: "POST", notify: "Published" }),
    onSuccess: invalidate,
  });
  const discard = useMutation({
    mutationFn: () => api(`/api/call-flows/${flowId}/draft`, { method: "DELETE", notify: "Draft discarded" }),
    onSuccess: invalidate,
  });
  const restore = useMutation({
    mutationFn: (version: number) =>
      api(`/api/call-flows/${flowId}/versions/${version}/restore`, { method: "POST", notify: "Copied into the draft" }),
    onSuccess: invalidate,
  });
  const removeVersion = useMutation({
    mutationFn: (version: number) =>
      api(`/api/call-flows/${flowId}/versions/${version}`, { method: "DELETE", notify: `v${version} deleted` }),
    onSuccess: invalidate,
  });
  const archive = useMutation({
    mutationFn: () => api(`/api/call-flows/${flowId}/archive`, { method: "POST", notify: "Call flow archived" }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  const check = useMemo(() => (form ? callFlowDefinition.safeParse(form) : null), [form]);
  const dirty = !!form && !!baseDefinition && JSON.stringify(form) !== JSON.stringify(baseDefinition);
  const textOf = (d: CallFlowDefinition | null, id: string) => {
    const b = d?.blocks.find((x) => x.id === id);
    return b && !isLockedBlock(b) ? b.text : null;
  };
  /** Save, after a confirm when the edited do-not-call block no longer ends the call on a do-not-call request. */
  const saveChecked = async (definition: CallFlowDefinition) => {
    const dnc = textOf(definition, "do_not_call");
    if (dnc !== null && dnc !== textOf(baseDefinition, "do_not_call") && lacksDoNotCallHandling(dnc)) {
      const ok = await confirm({
        title: "Save without do-not-call handling?",
        body: "The DO NOT CALL block no longer says to end the call when the customer asks not to be called. The system's own rules still apply, but this script would no longer say it. Save anyway?",
        confirmText: "Save anyway",
        tone: "danger",
      });
      if (!ok) return;
    }
    save.mutate(definition);
  };

  if (detail.isLoading || !form) return detail.error ? <ErrorNote error={detail.error} /> : <Spinner />;

  const update = (fn: (f: CallFlowDefinition) => void) =>
    setForm((f) => {
      const next = structuredClone(f!);
      fn(next);
      return next;
    });
  const getField = (key: FieldKey): string => {
    if (key === "greeting") return form.greeting.text;
    if (key === "silence.reprompt") return form.silence.reprompt;
    if (key === "silence.closing") return form.silence.closing;
    const b = form.blocks.find((x) => x.id === key.slice(6));
    return b && !isLockedBlock(b) ? b.text : "";
  };
  const setField = (key: FieldKey, value: string) =>
    update((f) => {
      if (key === "greeting") f.greeting.text = value;
      else if (key === "silence.reprompt") f.silence.reprompt = value;
      else if (key === "silence.closing") f.silence.closing = value;
      else {
        const b = f.blocks.find((x) => x.id === key.slice(6));
        if (b && !isLockedBlock(b)) b.text = value;
      }
    });
  const bind = (key: FieldKey) => ({
    value: getField(key),
    onChange: (e: { target: { value: string } }) => setField(key, e.target.value),
    onFocus: (e: { target: HTMLInputElement | HTMLTextAreaElement }) => (active.current = { key, el: e.target }),
  });
  const insertVariable = (v: string) => {
    const a = active.current;
    if (!a) return;
    const text = getField(a.key);
    const start = a.el.selectionStart ?? text.length;
    const end = a.el.selectionEnd ?? start;
    const token = `{{${v}}}`;
    setField(a.key, text.slice(0, start) + token + text.slice(end));
    requestAnimationFrame(() => {
      a.el.focus();
      a.el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const tabBlocks =
    tab === "locked"
      ? form.blocks.filter(isLockedBlock)
      : form.blocks.filter((b): b is CallFlowTextBlock => !isLockedBlock(b) && b.group === tab);

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="card min-w-0">
        <div className="-mx-5 -mt-5 mb-5 flex items-start justify-between gap-4 border-b border-line/70 px-5 py-4">
          <div className="min-w-0">
            <div className="truncate text-base font-semibold" title={form.name}>{form.name}</div>
            <div className="mt-0.5 text-xs text-slate-550">
              {BASE_LABELS[form.base]} ·{" "}
              {draft ? `editing draft v${draft.version}` : published ? `editing v${published.version} (saving makes a new draft)` : ""}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              className="btn-ghost h-8 whitespace-nowrap px-3 py-0 text-xs"
              disabled={dirty}
              title={dirty ? "Save or undo your changes first" : "Paste a whole prompt and split it into these blocks"}
              onClick={() => setImporting(true)}
            >
              Import full prompt
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-m-1.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-tint hover:text-ink"
            >
              <Icon name="close" size={18} />
            </button>
          </div>
        </div>

        <div className="mb-6 grid gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <label className="label">Name</label>
            <input className="input" maxLength={100} value={form.name} onChange={(e) => update((f) => void (f.name = e.target.value))} />
          </div>
          <div className="min-w-0">
            <label className="label">Language</label>
            <select className="input truncate" value={form.language} disabled title="English (the only language this voice backend supports)">
              <option value="en">English (the only language this voice backend supports)</option>
            </select>
          </div>
          <div className="min-w-0 sm:col-span-2">
            <label className="label">Voice</label>
            {catalog.voices?.length ? (
              <VoicePicker
                voices={catalog.voices}
                defaultVoice={catalog.default_voice ?? catalog.voices[0]!.id}
                value={form.voice_id}
                onChange={(id) => update((f) => void (f.voice_id = id))}
              />
            ) : (
              <input
                className="input font-mono text-xs"
                placeholder="Default voice"
                value={form.voice_id ?? ""}
                onChange={(e) => update((f) => void (f.voice_id = e.target.value.trim() || null))}
              />
            )}
            <span className="mt-1 block text-xs text-slate-550">Ignored while SARVAM_TTS_VOICE_ROTATION is set on the server.</span>
          </div>
          <div className="min-w-0">
            <label className="label">Max call duration (seconds)</label>
            <input
              type="number"
              className="input"
              min={30}
              max={catalog.limits.max_duration_sec}
              value={form.limits.max_duration_sec}
              onChange={(e) => update((f) => void (f.limits.max_duration_sec = Number(e.target.value) || 0))}
            />
            <span className="mt-1 block text-xs text-slate-550">Server maximum {catalog.limits.max_duration_sec}s.</span>
          </div>
        </div>

        <label className="label border-t border-line/70 pt-5">Insert a variable (into the field you last clicked)</label>
        <div className="mb-4 mt-1 flex flex-wrap gap-1">
          {CALL_FLOW_VARIABLES.map((v) => (
            <button
              key={v}
              type="button"
              className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-xs text-accent-ink"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertVariable(v)}
            >
              {`{{${v}}}`}
            </button>
          ))}
        </div>

        <label className="label">Greeting (spoken word for word, before the AI takes over)</label>
        <input className="input mb-1" maxLength={300} {...bind("greeting")} />
        <p className="mb-5 text-xs text-slate-550">
          If it uses {"{{name}}"} or {"{{customer_name}}"}, customers without a name are not called. Keep the
          “Greeting” blocks below consistent with this line.
        </p>

        <div className="mb-4 flex flex-wrap gap-1 rounded-lg bg-surface-muted p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                tab === t.key ? "bg-white text-ink shadow-sm" : "text-slate-550 hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tabBlocks.length === 0 && <p className="mb-3 text-sm text-slate-550">Nothing in this section for this script.</p>}
        {tabBlocks.map((b) =>
          isLockedBlock(b) ? (
            <div key={b.id} className="mb-3 rounded-lg border border-line bg-surface-muted p-3">
              <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-slate-550">
                <Icon name="info" size={14} /> {blockTitle(catalog.locked_blocks[b.locked] ?? b.locked)} — locked
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs text-ink">{catalog.locked_blocks[b.locked]}</pre>
            </div>
          ) : (
            <div key={b.id} className="mb-3">
              <label className="label">{BLOCK_LABELS[b.id] ?? blockTitle(b.text)}</label>
              <textarea
                className="input h-40 font-mono text-xs"
                maxLength={catalog.limits.max_block_chars}
                {...bind(`block:${b.id}`)}
              />
              {SAFETY_IDS.has(b.id) && (
                <p className="mt-1 text-xs text-slate-550">The system's own safety rules are always added after this prompt and can't be edited.</p>
              )}
              {b.id === "do_not_call" && lacksDoNotCallHandling(b.text) && (
                <p className="mt-1 rounded-lg border border-crit-line bg-crit-soft px-3 py-2 text-xs text-crit">
                  Warning: this block no longer says to end the call when the customer asks not to be called.
                </p>
              )}
            </div>
          ),
        )}

        <div className="mb-4 grid gap-4 border-t border-line/70 pt-5 sm:grid-cols-2">
          <div className="min-w-0">
            <label className="label">No response: first re-prompt</label>
            <input className="input" maxLength={200} {...bind("silence.reprompt")} />
          </div>
          <div className="min-w-0">
            <label className="label">No response: closing line</label>
            <input className="input" maxLength={200} {...bind("silence.closing")} />
          </div>
        </div>
        <div className="mb-4 rounded-lg bg-surface-muted px-3 py-2 text-xs text-slate-550">
          <b>Not answered, busy or voicemail:</b> the call is hung up and the outcome recorded (no retry, no voicemail
          message). This is fixed in the voice backend.
        </div>
        <div className="mb-4">
          <label className="label">Transfer number (saved, not used yet)</label>
          <PhoneInput
            value={form.transfer.number ?? ""}
            onChange={(v) => update((f) => void (f.transfer.number = v || null))}
          />
          <span className="mt-1 block text-xs text-slate-550">Live call transfer isn't implemented yet; the number is stored with the flow.</span>
        </div>

        {check && !check.success && (
          <div className="mb-3 rounded-lg border border-crit-line bg-crit-soft px-3 py-2 text-xs text-crit">
            {check.error.issues.slice(0, 8).map((i, n) => (
              <div key={n}>
                {i.path.join(".") || "flow"}: {i.message}
              </div>
            ))}
          </div>
        )}
        {[save.error, publish.error, discard.error, restore.error, removeVersion.error, archive.error].map(
          (e, i) => e && <ErrorNote key={i} error={e} />,
        )}
        {/* Sticky action bar: stays at the bottom of the screen while the editor scrolls. */}
        <div className="sticky bottom-0 z-10 -mx-5 mt-4 flex flex-wrap justify-end gap-2 border-t border-line/70 bg-surface/95 px-5 py-3 backdrop-blur">
          <button
            className="btn-ghost text-crit"
            disabled={archive.isPending}
            onClick={async () => {
              if (await confirm({ title: `Archive “${form.name}”?`, body: "It disappears from the list and the AI Call picker. Runs already using it are not affected.", confirmText: "Archive", tone: "danger" }))
                archive.mutate();
            }}
          >
            Archive
          </button>
          {draft && published && (
            <button
              className="btn-ghost"
              disabled={discard.isPending}
              onClick={async () => {
                if (await confirm({ title: "Discard the draft?", body: `Back to the published v${published.version}.`, confirmText: "Discard", tone: "danger" }))
                  discard.mutate();
              }}
            >
              Discard draft
            </button>
          )}
          {working && !dirty && (
            <button className="btn-ghost" onClick={() => setTesting(true)}>
              <Icon name="phone" size={16} /> Test call to my number
            </button>
          )}
          <button className="btn-ghost" disabled={!dirty} onClick={() => baseDefinition && setForm(structuredClone(baseDefinition))}>
            Undo changes
          </button>
          <button
            className="btn-primary"
            disabled={!dirty || !check?.success || save.isPending}
            onClick={() => check?.success && void saveChecked(check.data)}
          >
            {save.isPending ? "Saving…" : "Save draft"}
          </button>
          {draft && !dirty && (
            <button
              className="btn-danger"
              disabled={publish.isPending}
              onClick={async () => {
                if (
                  await confirm({
                    title: `Publish v${draft.version}?`,
                    body: "AI call runs that pick this flow will use it. Published versions can't be edited. Make a test call first.",
                    confirmText: "Publish",
                  })
                )
                  publish.mutate();
              }}
            >
              {publish.isPending ? "Publishing…" : `Publish v${draft.version}`}
            </button>
          )}
        </div>

        <div className="mt-6 border-t border-line pt-4">
          <div className="mb-2 text-sm font-semibold">Versions</div>
          <ul className="divide-y divide-line/70 rounded-lg border border-line/70 px-3 text-sm">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                <span className="flex min-w-0 flex-1 basis-60 items-center gap-3">
                  <span className="w-9 shrink-0 font-mono">v{v.version}</span>
                  <span className="w-20 shrink-0">
                    <Badge tone={v.status === "PUBLISHED" ? "ok" : "warn"}>{v.status.toLowerCase()}</Badge>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-ink">
                      {v.status === "PUBLISHED" ? `published ${fmtDate(v.publishedAt)}` : `saved ${fmtDate(v.updatedAt)}`}
                    </span>
                    {v.createdByEmail && (
                      <span className="block truncate text-[11px] text-slate-550" title={v.createdByEmail}>
                        {v.createdByEmail}
                      </span>
                    )}
                  </span>
                </span>
                <span className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
                  {v.status === "PUBLISHED" && v.id !== published?.id && (
                    <button className="btn-ghost h-8 whitespace-nowrap px-3 py-0 text-xs" disabled={restore.isPending} onClick={() => restore.mutate(v.version)}>
                      Restore into draft
                    </button>
                  )}
                  {/* Never the live version or the only one (the API refuses both, and a version a run used). */}
                  {v.id !== published?.id && versions.length > 1 && (
                    <button
                      className="btn h-8 whitespace-nowrap border-crit-line bg-transparent px-3 py-0 text-xs text-crit hover:border-crit/40 hover:bg-crit-soft"
                      disabled={removeVersion.isPending}
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Delete v${v.version} permanently?`,
                            body: "This cannot be undone.",
                            confirmText: "Delete",
                            tone: "danger",
                          })
                        )
                          removeVersion.mutate(v.version);
                      }}
                    >
                      Delete
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <PreviewPanel definition={form} valid={!!check?.success} />

      <ImportPromptModal open={importing} onClose={() => setImporting(false)} flowId={flowId} onChanged={invalidate} />


      {working && (
        <TestCallModal
          open={testing}
          onClose={() => setTesting(false)}
          flowId={flowId}
          versions={versions}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ preview */

function PreviewPanel({ definition, valid }: { definition: CallFlowDefinition; valid: boolean }) {
  const [sample, setSample] = useState<Sample>(() => {
    const { label: _label, ...first } = SAMPLES[0]!;
    return first;
  });
  const [debounced, setDebounced] = useState({ definition, sample });
  const [showPrompt, setShowPrompt] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced({ definition, sample }), 600);
    return () => clearTimeout(t);
  }, [definition, sample]);

  const preview = useQuery({
    queryKey: ["call-flow-preview", debounced],
    queryFn: () =>
      api<CallFlowPreview>("/api/call-flows/preview", {
        method: "POST",
        json: {
          definition: debounced.definition,
          sample: Object.fromEntries(Object.entries(debounced.sample).filter(([, v]) => v)),
        },
        notify: false,
      }),
    enabled: valid,
    placeholderData: (prev) => prev,
  });
  const p = preview.data;

  return (
    // Fold-open below xl (it sits under the editor there); always open beside the editor from xl.
    <details open className="card h-fit xl:sticky xl:top-4">
      <summary className="mb-2 cursor-pointer text-sm font-semibold xl:pointer-events-none xl:cursor-default xl:list-none xl:[&::-webkit-details-marker]:hidden">
        Live preview
      </summary>
      <div className="mb-2 flex flex-wrap gap-1">
        {SAMPLES.map(({ label, ...s }) => (
          <button
            key={label}
            type="button"
            className={`rounded px-1.5 py-0.5 text-xs ${JSON.stringify(s) === JSON.stringify(sample) ? "bg-accent-soft text-accent-ink" : "bg-surface-muted text-slate-550"}`}
            onClick={() => setSample(s)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="mb-3 grid grid-cols-2 gap-2">
        <input className="input py-1 text-xs" placeholder="Customer name" value={sample.customer_name} onChange={(e) => setSample({ ...sample, customer_name: e.target.value })} />
        <select className="input py-1 text-xs" value={sample.gender} onChange={(e) => setSample({ ...sample, gender: e.target.value })}>
          <option value="male">male</option>
          <option value="female">female</option>
          <option value="unknown">unknown</option>
        </select>
        <input
          className="input col-span-2 py-1 text-xs"
          placeholder="Follow-up detail"
          value={sample.follow_up_detail}
          onChange={(e) => setSample({ ...sample, follow_up_detail: e.target.value })}
        />
      </div>
      {!valid ? (
        <p className="text-sm text-warn">Fix the problems in the editor to see the preview.</p>
      ) : preview.error ? (
        <ErrorNote error={preview.error} />
      ) : !p ? (
        <Spinner />
      ) : !p.valid ? (
        <div className="text-xs text-crit">
          {p.errors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      ) : (
        <div className={`text-sm ${preview.isFetching ? "opacity-60" : ""}`}>
          <div className="label">Greeting</div>
          <p className="mb-2 rounded-lg bg-surface-muted px-3 py-2">“{p.greeting}”</p>
          <div className="label">If the customer is silent</div>
          <p className="mb-1 rounded-lg bg-surface-muted px-3 py-2">“{p.silence_reprompt}”</p>
          <p className="mb-2 rounded-lg bg-surface-muted px-3 py-2">“{p.silence_closing}”</p>
          <p className="mb-2 text-xs text-slate-550">
            Max duration {p.max_duration_sec}s · script {p.script_chars?.toLocaleString()} characters
          </p>
          <button type="button" className="btn-ghost py-1 text-xs" onClick={() => setShowPrompt((s) => !s)}>
            {showPrompt ? "Hide" : "Show"} the full prompt sent to the AI
          </button>
          {showPrompt && (
            <div className="mt-2 overflow-hidden rounded-lg border border-line bg-surface-muted">
              <div className="flex justify-end border-b border-line/70 px-2 py-1.5">
                <CopyPromptButton text={p.system_prompt ?? ""} />
              </div>
              <pre className="scroll-thin max-h-[50vh] overflow-auto whitespace-pre-wrap break-words p-3 text-[11px] leading-relaxed">
                {p.system_prompt}
              </pre>
            </div>
          )}
        </div>
      )}
    </details>
  );
}

/** Copies the full prompt exactly as shown; "Copied ✓" for 1.5 s. Own state, so the preview doesn't re-render. */
function CopyPromptButton({ text }: { text: string }) {
  const [label, setLabel] = useState<"Copy" | "Copied ✓" | "Copy failed">("Copy");
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // No Clipboard API (e.g. plain http): fall back to a hidden textarea.
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      area.remove();
    }
    setLabel(ok ? "Copied ✓" : "Copy failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setLabel("Copy"), 1500);
  };

  return (
    <button
      type="button"
      className="btn-ghost h-7 whitespace-nowrap px-2.5 py-0 text-[11px] text-accent-ink"
      aria-label="Copy the full prompt"
      onClick={copy}
    >
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------ test call */

function TestCallModal({
  open,
  onClose,
  flowId,
  versions,
}: {
  open: boolean;
  onClose: () => void;
  flowId: string;
  versions: CallFlowVersion[];
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [version, setVersion] = useState(versions[0]?.version ?? 1);
  const [numberId, setNumberId] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [gender, setGender] = useState("unknown");
  const [followUpDetail, setFollowUpDetail] = useState("");
  const [runId, setRunId] = useState<string | null>(null);

  const numbers = useQuery({
    queryKey: ["call-flow-test-numbers"],
    queryFn: () => api<TestCallNumberList>("/api/call-flows/test-numbers"),
    enabled: open,
  });
  const items = numbers.data?.items ?? [];
  const savedCount = items.filter((n) => n.source === "saved").length;
  const max = numbers.data?.max ?? 5;
  const tableMissing = !!numbers.data?.tableMissing;
  const selectedId = items.some((n) => n.id === numberId) ? numberId : (items[0]?.id ?? "");
  const refreshNumbers = () => qc.invalidateQueries({ queryKey: ["call-flow-test-numbers"] });

  const add = useMutation({
    mutationFn: () =>
      api<TestCallNumber>("/api/call-flows/test-numbers", {
        method: "POST",
        json: { phone: newPhone, label: newLabel.trim() || null },
        notify: false,
      }),
    onSuccess: (n) => {
      setNewPhone("");
      setNewLabel("");
      setNumberId(n.id);
      toast.success("Trial number added", [n.masked]);
      void refreshNumbers();
    },
  });
  const remove = useMutation({
    mutationFn: (n: TestCallNumber) =>
      api(`/api/call-flows/test-numbers/${encodeURIComponent(n.id)}`, { method: "DELETE", notify: false }),
    onSuccess: (_r, n) => {
      toast.success("Trial number removed", [n.masked]);
      void refreshNumbers();
    },
  });
  const askRemove = async (n: TestCallNumber) => {
    if (await confirm({ title: `Remove ${n.masked}?`, body: "Test calls can no longer go to this number.", confirmText: "Remove", tone: "danger" })) {
      remove.mutate(n);
    }
  };

  const start = useMutation({
    mutationFn: () =>
      api<{ runId: string }>(`/api/call-flows/${flowId}/test-call`, {
        method: "POST",
        json: { version, numberId: selectedId, customerName: customerName || null, gender, followUpDetail: followUpDetail || null },
        notify: false,
      }),
    onSuccess: (r) => {
      setRunId(r.runId);
      toast.success("Test call started", ["Your phone should ring within a few seconds."]);
    },
  });
  // "Another AI call run is still in progress": offer to stop that run (same cancel as the AI Call modal).
  const blockedByRun = start.error instanceof Error && /still in progress/i.test(start.error.message);
  const stopRunning = useMutation({
    mutationFn: async () => {
      const { items } = await api<{ items: Pick<AiCallRun, "id" | "status">[] }>("/api/ai-calls/runs");
      const running = items.filter((r) => r.status === "RUNNING");
      for (const r of running) await api(`/api/ai-calls/runs/${r.id}/cancel`, { method: "POST", notify: false });
      return running.length;
    },
    onSuccess: (n) => {
      start.reset();
      toast.success(n ? "Running AI call run stopped" : "No AI call run is running now", ["You can place the test call now."]);
    },
  });
  const askStopRunning = async () => {
    if (
      await confirm({
        title: "Stop the AI call run in progress?",
        body: "Calls still waiting in that run are cancelled. A call already ringing finishes on its own.",
        confirmText: "Stop run",
        tone: "danger",
      })
    )
      stopRunning.mutate();
  };
  const run = useQuery({
    queryKey: ["ai-call-run", runId],
    queryFn: () => api<AiCallRun>(`/api/ai-calls/runs/${runId}`),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data?.status === "RUNNING" ? 3000 : false),
  });
  const log = run.data?.logs[0];
  const newPhoneError = newPhone ? phoneError(newPhone) : null;

  return (
    <Modal open={open} onClose={onClose} title="Test call to my number">
      {runId ? (
        <div className="text-sm">
          {!log ? (
            <Spinner />
          ) : (
            <>
              <p className="mb-2">
                Status: <Badge tone={log.status === "COMPLETED" ? "ok" : log.status === "FAILED" ? "crit" : "accent"}>{log.status}</Badge>
                {log.outcome && <> · outcome <Badge>{log.outcome}</Badge></>}
              </p>
              {log.error && <p className="mb-2 text-crit">{log.error}</p>}
              {log.summary && <p className="mb-2 text-slate-550">{log.summary}</p>}
            </>
          )}
          <div className="mt-3 flex justify-end">
            <button className="btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      ) : numbers.isLoading ? (
        <Spinner />
      ) : numbers.error ? (
        <>
          <ErrorNote error={numbers.error} />
          <div className="mt-3 flex justify-end">
            <button className="btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          {tableMissing && (
            <p className="mb-3 text-sm text-warn">
              Saving trial numbers needs a database update: run <code>npm run prisma:deploy</code>. Numbers in
              AI_CALL_FLOW_TEST_NUMBERS still work.
            </p>
          )}

          {items.length > 0 ? (
            <>
              <label className="label">Version</label>
              <select className="input mb-3" value={version} onChange={(e) => setVersion(Number(e.target.value))}>
                {versions.map((v) => (
                  <option key={v.id} value={v.version}>
                    v{v.version} ({v.status.toLowerCase()})
                  </option>
                ))}
              </select>
              <label className="label">Number to call</label>
              <select className="input mb-3" value={selectedId} onChange={(e) => setNumberId(e.target.value)}>
                {items.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.masked}
                    {n.label ? ` · ${n.label}` : ""}
                  </option>
                ))}
              </select>
              <div className="mb-3 grid grid-cols-2 gap-2">
                <input className="input" placeholder="Name to greet" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
                <select className="input" value={gender} onChange={(e) => setGender(e.target.value)}>
                  <option value="male">male</option>
                  <option value="female">female</option>
                  <option value="unknown">unknown</option>
                </select>
                <input
                  className="input col-span-2"
                  placeholder="Follow-up detail (optional)"
                  value={followUpDetail}
                  onChange={(e) => setFollowUpDetail(e.target.value)}
                />
              </div>
              <p className="mb-3 text-xs text-slate-550">
                A real call is placed and counts toward the daily limit. It is refused while another AI call run is in progress.
                Up to 3 test calls per hour.
              </p>
              {start.error && <ErrorNote error={start.error} />}
              {blockedByRun && (
                <div className="mt-2 flex justify-end">
                  <button className="btn-danger" disabled={stopRunning.isPending} onClick={() => void askStopRunning()}>
                    {stopRunning.isPending ? "Stopping…" : "Stop running call"}
                  </button>
                </div>
              )}
              {stopRunning.error && (
                <div className="mt-2">
                  <ErrorNote error={stopRunning.error} />
                </div>
              )}
              <div className="mt-3 flex justify-end gap-2">
                <button className="btn-ghost" onClick={onClose}>
                  Cancel
                </button>
                <button className="btn-danger" disabled={!selectedId || start.isPending} onClick={() => start.mutate()}>
                  {start.isPending ? "Calling…" : "Call this number"}
                </button>
              </div>
            </>
          ) : (
            <p className="mb-3 text-sm text-slate-550">No trial numbers yet. Add your own number below to place a test call.</p>
          )}

          <div className="mt-4 border-t border-line/70 pt-3">
            <p className="label">
              Trial numbers ({savedCount}/{max})
            </p>
            {items.length > 0 && (
              <ul className="mb-3 divide-y divide-line/60 rounded-lg border border-line/70 text-sm">
                {items.map((n) => (
                  <li key={n.id} className="flex items-center gap-2 px-3 py-1.5">
                    <span className="font-mono">{n.masked}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-550">{n.label ?? ""}</span>
                    {n.source === "env" ? (
                      <span className="text-xs text-slate-550" title="Set in AI_CALL_FLOW_TEST_NUMBERS in the API's .env">
                        from .env
                      </span>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Remove ${n.masked}`}
                        title="Remove"
                        disabled={remove.isPending}
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-tint hover:text-crit disabled:cursor-not-allowed disabled:opacity-40"
                        onClick={() => void askRemove(n)}
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {remove.error && (
              <div className="mb-2">
                <ErrorNote error={remove.error} />
              </div>
            )}
            <label className="label">Add trial number</label>
            <PhoneInput className="mb-2" value={newPhone} onChange={setNewPhone} disabled={tableMissing} />
            <div className="flex gap-2">
              <input
                className="input min-w-0 flex-1"
                placeholder="Label (optional), e.g. My phone"
                maxLength={60}
                value={newLabel}
                disabled={tableMissing}
                onChange={(e) => setNewLabel(e.target.value)}
              />
              <button
                className="btn-ghost shrink-0"
                disabled={tableMissing || !newPhone || !!newPhoneError || savedCount >= max || add.isPending}
                onClick={() => add.mutate()}
              >
                {add.isPending ? "Adding…" : "Add trial number"}
              </button>
            </div>
            {savedCount >= max && !tableMissing && (
              <p className="mt-1 text-xs text-warn">You can save up to {max} trial numbers. Remove one to add another.</p>
            )}
            {add.error && (
              <div className="mt-2">
                <ErrorNote error={add.error} />
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
