import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AI_CALL_LANGUAGE_NAMES,
  TRAINING_AVOID,
  trainingDefaultTokenCap,
  TRAINING_MAX_TOKEN_CAP,
  TRAINING_MIN_TOKEN_CAP,
  TRAINING_PRIVACY_NOTICE,
  TRAINING_PROFILE_FIELDS,
  TRAINING_SITUATION_LABELS,
  TRAINING_SITUATIONS,
  TRAINING_STATUSES,
  isLockedBlock,
  languageStyleOf,
  newTrainingId,
  type CallFlowDefinition,
  type CallFlowTraining as Training,
  type TrainingExample,
  type TrainingKnowledge,
  type TrainingPersona,
  type TrainingPhrase,
  type TrainingSituation,
  type TrainingStatus,
  type TrainingTestMode,
  type TrainingTestResult,
  type TrainingTestReply,
} from "@dispatch/shared";
import { api } from "../lib/api";
import { useAiProviderSettings } from "../lib/aiProviders";
import type { CallFlowPreview } from "../lib/callFlows";
import { Badge, ErrorNote, Spinner } from "./ui";
import { Switch } from "./Switch";
import { useConfirm } from "./confirm";

/**
 * Training tab of the Call Flows editor: the flow agent's tone and knowledge as structured entries
 * (persona, approved phrases, facts and Q&A, example replies). The voice backend compiles the Active
 * entries into one compact block below every rule of the prompt; nothing is fine-tuned. Edits go into
 * the editor's form and are saved with "Save draft" like any other change (published versions never change).
 */

type Section = "persona" | "phrases" | "knowledge" | "examples" | "test";
const SECTIONS: { key: Section; label: string }[] = [
  { key: "persona", label: "Agent & tone" },
  { key: "phrases", label: "Expressions" },
  { key: "knowledge", label: "Knowledge" },
  { key: "examples", label: "Examples & corrections" },
  { key: "test", label: "Test" },
];
const SCALES: { key: "formality" | "warmth" | "energy" | "politeness"; label: string; low: string; high: string }[] = [
  { key: "formality", label: "Formality", low: "casual", high: "formal" },
  { key: "warmth", label: "Warmth", low: "neutral", high: "very warm" },
  { key: "energy", label: "Energy", low: "very calm", high: "energetic" },
  { key: "politeness", label: "Politeness", low: "plain", high: "very respectful" },
];
const STATUS_TONE: Record<TrainingStatus, "ok" | "neutral" | "warn"> = { active: "ok", draft: "warn", archived: "neutral" };

/** Persona defaults read from the flow's own script (shown, never saved until "Save draft"). */
export function suggestPersona(def: CallFlowDefinition): TrainingPersona {
  const text = def.blocks.map((b) => (isLockedBlock(b) ? "" : b.text)).join("\n");
  // A bolded name after "you are" (any case: the executive script says "...you are **Thaara**"), else the
  // older unbolded "You are Thaara" form.
  const name =
    /\b[Yy]ou are\s+\*\*(\p{Lu}[\p{L}'-]+)\*\*/u.exec(text)?.[1] ?? /You are\s+\**(\p{Lu}[\p{L}'-]+)\**/u.exec(text)?.[1];
  const company = /on behalf of\s+\**([^*\n.]{2,100})\**/i.exec(text)?.[1]?.trim();
  const mixed = def.language !== "en" && languageStyleOf(def) === "mixed";
  const executive = def.base === "executive";
  return {
    status: "draft",
    agent_name: name ?? "",
    company: company ?? "",
    business_type: "",
    objective: executive ? "Introduce our AI automation services and find out whether the customer is interested" : "",
    call_purpose: "",
    target_customer: "",
    intro: "",
    desired_outcome: "",
    role: executive
      ? "Professional business development executive"
      : name
        ? `${name}, a friendly and professional AI calling assistant`
        : "",
    formality: 3,
    warmth: 4,
    energy: /\bcalm\b/i.test(text) ? 2 : 3,
    politeness: 4,
    pace: /\bslow(ly)?\b/i.test(text) ? "slow" : "steady",
    sentence_length: /\bshort\b/i.test(text) ? "short" : "medium",
    title_use: /\{\{\s*title_to_use\s*\}\}/.test(text) ? "sometimes" : "never",
    english_mix: mixed ? "medium" : null,
    avoid: ["slang", "exaggeration", "pushiness"],
    notes: "",
  };
}

export function emptyTraining(def: CallFlowDefinition): Training {
  // Non-English flows start with a larger cap (Indic scripts cost more tokens per word).
  return { enabled: false, token_cap: trainingDefaultTokenCap(def.language), persona: suggestPersona(def), phrases: [], knowledge: [], examples: [] };
}

/** Validation messages from the voice backend for one entry, e.g. "training.phrases.3…". */
function flagsFor(errors: string[], path: string): string[] {
  return errors.filter((e) => e === path || e.startsWith(`${path}.`) || e.startsWith(`${path}:`)).map((e) => e.replace(/^[^:]*:\s*/, "").replace(/^Value error, /, ""));
}

export function CallFlowTraining({
  form,
  update,
  flowId,
}: {
  form: CallFlowDefinition;
  update: (fn: (f: CallFlowDefinition) => void) => void;
  flowId: string;
}) {
  const [section, setSection] = useState<Section>("persona");
  const [message, setMessage] = useState("");
  const training = form.training;

  // Live: the compiled block, its size and the voice backend's flags (debounced like the Live preview).
  const [debounced, setDebounced] = useState({ definition: form, message });
  useEffect(() => {
    const t = setTimeout(() => setDebounced({ definition: form, message }), 600);
    return () => clearTimeout(t);
  }, [form, message]);
  const preview = useQuery({
    queryKey: ["call-flow-training-preview", debounced],
    queryFn: () =>
      api<CallFlowPreview>("/api/call-flows/preview", {
        method: "POST",
        json: { definition: debounced.definition, ...(debounced.message.trim() ? { trainingMessage: debounced.message.trim() } : {}) },
        notify: false,
      }),
    enabled: !!debounced.definition.training,
    placeholderData: (prev) => prev,
  });
  const p = preview.data;
  const errors = p && !p.valid ? p.errors.filter((e) => e.startsWith("training")) : [];
  const otherErrors = p && !p.valid ? p.errors.length - errors.length : 0;

  if (!training) {
    return (
      <div className="rounded-lg border border-line p-4 text-sm">
        <p className="mb-2 font-medium">This flow has no training.</p>
        <p className="mb-3 text-slate-550">
          Training teaches this flow's agent its tone and knowledge through the prompt (no model is fine-tuned). Without
          training, calls use the prompt exactly as today.
        </p>
        <PrivacyNotice />
        <button type="button" className="btn-primary mt-3" onClick={() => update((f) => void (f.training = emptyTraining(f)))}>
          Start training (persona filled in from this script)
        </button>
      </div>
    );
  }

  const set = (fn: (t: Training) => void) => update((f) => fn(f.training!));
  const count = (items: { status: TrainingStatus }[]) => items.filter((i) => i.status === "active").length;
  const cap = training.token_cap;
  const max = p?.training_max_tokens ?? 0;
  const over = max > cap;
  const near = !over && max > cap * 0.85;
  const indic = form.language !== "en";
  const suggested = trainingDefaultTokenCap(form.language);

  return (
    <div className="text-sm">
      <PrivacyNotice />
      <div className="my-3 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-line px-3 py-2">
        <label className="flex items-center gap-2">
          <Switch on={training.enabled} label="Use training in calls" onChange={(on) => set((t) => void (t.enabled = on))} />
          <span className="font-medium">Use training in calls</span>
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-550">
          Token cap
          <input
            type="number"
            className="input w-24 py-1 text-xs"
            min={TRAINING_MIN_TOKEN_CAP}
            max={TRAINING_MAX_TOKEN_CAP}
            step={50}
            value={cap}
            onChange={(e) => set((t) => void (t.token_cap = Number(e.target.value) || suggested))}
          />
        </label>
        <TokenMeter preview={p} cap={cap} loading={preview.isFetching} />
      </div>
      <p className="mb-3 text-xs text-slate-550">
        {training.enabled
          ? "On: after you save and publish, calls of this flow get the Active entries below."
          : "Off: calls use the prompt exactly as without training. You can still prepare entries and test them."}{" "}
        Only <b>Active</b> entries are used. The block sits after the script and every safety rule and can never override
        them (do-not-call, AI disclosure, outcomes, locked blocks and lines the system speaks word for word stay as they are).
      </p>
      {over && (
        <p className="mb-3 rounded-lg border border-crit-line bg-crit-soft px-3 py-2 text-xs text-crit">
          The Active entries can reach ~{max} tokens per reply, over the cap of {cap}. Saving is blocked until you shorten
          or archive entries, or raise the cap (at most {TRAINING_MAX_TOKEN_CAP}).
          {indic && cap < suggested && ` ${AI_CALL_LANGUAGE_NAMES[form.language]} script uses more tokens per word: ${suggested} is the suggested cap for this language.`}
        </p>
      )}
      {near && (
        <p className="mb-3 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
          Close to the cap: the Active entries can reach ~{max} of {cap} tokens per reply. Lines that don't fit are left
          out of a reply (never cut off), and the Test tab lists them.
        </p>
      )}
      {indic && !over && !near && (
        <p className="mb-3 text-xs text-slate-550">
          {AI_CALL_LANGUAGE_NAMES[form.language]} script uses more tokens per word than English (counted at about 1.5
          characters per token), so the same training costs more here. Suggested cap: {suggested}.
        </p>
      )}
      {errors.length > 0 && (
        <div className="mb-3 rounded-lg border border-crit-line bg-crit-soft px-3 py-2 text-xs text-crit">
          <div className="mb-1 font-semibold">Fix these before saving:</div>
          {errors.slice(0, 12).map((e, i) => (
            <div key={i}>{e.replace("Value error, ", "")}</div>
          ))}
        </div>
      )}
      {otherErrors > 0 && errors.length === 0 && (
        <p className="mb-3 text-xs text-warn">The rest of the flow has problems (see the other tabs); the training preview waits for them.</p>
      )}

      <div className="mb-4 flex flex-wrap gap-1 border-b border-line/70">
        {SECTIONS.map((s) => {
          const n =
            s.key === "phrases" ? count(training.phrases) : s.key === "knowledge" ? count(training.knowledge) : s.key === "examples" ? count(training.examples) : null;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setSection(s.key)}
              className={`-mb-px border-b-2 px-2.5 py-1.5 text-xs font-medium ${section === s.key ? "border-accent text-ink" : "border-transparent text-slate-550 hover:text-ink"}`}
            >
              {s.label}
              {n !== null && <span className="ml-1 text-slate-400">{n}</span>}
            </button>
          );
        })}
      </div>

      {section === "persona" && <PersonaEditor form={form} training={training} set={set} errors={errors} />}
      {section === "phrases" && <PhrasesEditor form={form} training={training} set={set} errors={errors} />}
      {section === "knowledge" && <KnowledgeEditor training={training} set={set} errors={errors} />}
      {section === "examples" && <ExamplesEditor training={training} set={set} errors={errors} />}
      {section === "test" && <TestPanel form={form} flowId={flowId} message={message} setMessage={setMessage} preview={p} />}

      {section !== "test" && (
        <details className="mt-4 rounded-lg border border-line">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium">Compiled block (plain text, as the AI receives it)</summary>
          <div className="border-t border-line/70 p-3">
            <input
              className="input mb-2 py-1 text-xs"
              placeholder="Optional: a customer message, to see which phrases, Q&A and examples get picked for it"
              maxLength={300}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <CompiledBlock preview={p} />
          </div>
        </details>
      )}
    </div>
  );
}

function PrivacyNotice() {
  return (
    <p className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
      {TRAINING_PRIVACY_NOTICE} Nothing here trains or fine-tunes a model.
    </p>
  );
}

function TokenMeter({ preview, cap, loading }: { preview: CallFlowPreview | undefined; cap: number; loading: boolean }) {
  const now = preview?.training_tokens ?? 0;
  const max = preview?.training_max_tokens ?? 0;
  const pct = Math.min(100, Math.round((max / cap) * 100));
  return (
    <div className={`flex min-w-48 flex-1 items-center gap-2 text-xs ${loading ? "opacity-60" : ""}`}>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-muted" title="Largest block one reply can get, against the cap">
        <div className={`h-full ${max > cap ? "bg-crit" : pct > 85 ? "bg-warn" : "bg-ok"}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="whitespace-nowrap text-slate-550">
        ~{max} / {cap} tokens max per reply{now ? ` · ~${now} now` : ""}
      </span>
    </div>
  );
}

function CompiledBlock({ preview }: { preview: CallFlowPreview | undefined }) {
  if (!preview) return <Spinner />;
  if (!preview.valid) return <p className="text-xs text-slate-550">Shown once the flow and its training pass validation.</p>;
  if (!preview.training_block) return <p className="text-xs text-slate-550">Nothing Active yet: calls would get no training block.</p>;
  return (
    <pre className="scroll-thin max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-muted p-3 text-[11px] leading-relaxed">
      {preview.training_block.trim()}
    </pre>
  );
}

function StatusSelect({ value, onChange }: { value: TrainingStatus; onChange: (s: TrainingStatus) => void }) {
  return (
    <select className="input w-28 py-1 text-xs" value={value} onChange={(e) => onChange(e.target.value as TrainingStatus)} aria-label="Status">
      {TRAINING_STATUSES.map((s) => (
        <option key={s} value={s}>
          {s[0]!.toUpperCase() + s.slice(1)}
        </option>
      ))}
    </select>
  );
}

function Flags({ errors }: { errors: string[] }) {
  if (!errors.length) return null;
  return (
    <div className="mt-1 text-xs text-crit">
      {errors.map((e, i) => (
        <div key={i}>⚠ {e}</div>
      ))}
    </div>
  );
}

function EntryCard({ status, onStatus, onRemove, badges, children }: { status: TrainingStatus; onStatus: (s: TrainingStatus) => void; onRemove: () => void; badges?: ReactNode; children: ReactNode }) {
  return (
    <div className={`mb-2 rounded-lg border border-line p-3 ${status === "archived" ? "opacity-60" : ""}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <StatusSelect value={status} onChange={onStatus} />
        <Badge tone={STATUS_TONE[status]}>{status}</Badge>
        {badges}
        <button type="button" className="ml-auto text-xs text-crit hover:underline" onClick={onRemove}>
          Remove
        </button>
      </div>
      {children}
    </div>
  );
}

type EditorProps = { training: Training; set: (fn: (t: Training) => void) => void; errors: string[] };

function PersonaEditor({ form, training, set, errors }: EditorProps & { form: CallFlowDefinition }) {
  const persona = training.persona;
  if (!persona) {
    return (
      <button type="button" className="btn-ghost" onClick={() => set((t) => void (t.persona = suggestPersona(form)))}>
        Add persona (filled in from this script)
      </button>
    );
  }
  const put = <K extends keyof TrainingPersona>(k: K, v: TrainingPersona[K]) => set((t) => void (t.persona![k] = v));
  const mixed = form.language !== "en" && languageStyleOf(form) === "mixed";
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <StatusSelect value={persona.status} onChange={(s) => put("status", s)} />
        <span className="text-xs text-slate-550">Active = used in every reply. Defaults were read from this flow's script.</span>
        <button type="button" className="btn-ghost ml-auto py-1 text-xs" onClick={() => set((t) => void (t.persona = { ...suggestPersona(form), status: t.persona!.status }))}>
          Reset to suggested
        </button>
      </div>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-[0.06em] text-slate-550">Agent profile</h4>
      <p className="mb-2 text-xs text-slate-550">
        Who calls, for which company, and why. The <i>Business executive</i> script takes its identity and objective from
        here; other scripts keep what their own text says (on a conflict, the script wins). Facts only: no prices, savings,
        demos or meetings.
      </p>
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        {TRAINING_PROFILE_FIELDS.map((f) => (
          <div key={f.key} className={f.max > 120 ? "sm:col-span-2" : ""}>
            <label className="label">{f.label}</label>
            <input className="input py-1" maxLength={f.max} placeholder={f.placeholder} value={persona[f.key] ?? ""} onChange={(e) => put(f.key, e.target.value)} />
            <Flags errors={flagsFor(errors, `training.persona.${f.key}`)} />
          </div>
        ))}
      </div>
      <label className="label">Role and manner</label>
      <input className="input mb-1" maxLength={300} value={persona.role} placeholder="e.g. Professional business development executive" onChange={(e) => put("role", e.target.value)} />
      <Flags errors={flagsFor(errors, "training.persona.role")} />
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {SCALES.map((s) => (
          <div key={s.key}>
            <label className="label">
              {s.label}: {persona[s.key]}
            </label>
            <input type="range" min={1} max={5} className="w-full" value={persona[s.key]} onChange={(e) => put(s.key, Number(e.target.value))} />
            <div className="flex justify-between text-[11px] text-slate-550">
              <span>{s.low}</span>
              <span>{s.high}</span>
            </div>
          </div>
        ))}
        <div>
          <label className="label">Pace</label>
          <select className="input" value={persona.pace} onChange={(e) => put("pace", e.target.value as TrainingPersona["pace"])}>
            <option value="steady">Steady</option>
            <option value="slow">Slow</option>
          </select>
        </div>
        <div>
          <label className="label">Sentence length</label>
          <select className="input" value={persona.sentence_length} onChange={(e) => put("sentence_length", e.target.value as TrainingPersona["sentence_length"])}>
            <option value="short">Short</option>
            <option value="medium">Short to medium</option>
          </select>
        </div>
        <div>
          <label className="label">“Sir” / “madam”</label>
          <select className="input" value={persona.title_use} onChange={(e) => put("title_use", e.target.value as TrainingPersona["title_use"])}>
            <option value="never">Never add</option>
            <option value="rarely">Rarely</option>
            <option value="sometimes">Now and then</option>
            <option value="often">In most replies</option>
          </select>
          <span className="mt-1 block text-[11px] text-slate-550">Always only as given by the customer's gender (never guessed).</span>
        </div>
        {mixed && (
          <div>
            <label className="label">English mix ({AI_CALL_LANGUAGE_NAMES[form.language]} mixed style)</label>
            <select className="input" value={persona.english_mix ?? ""} onChange={(e) => put("english_mix", (e.target.value || null) as TrainingPersona["english_mix"])}>
              <option value="">Not said</option>
              <option value="light">Light (very common words only)</option>
              <option value="medium">Medium (everyday English words)</option>
              <option value="heavy">Heavy (most business words)</option>
            </select>
          </div>
        )}
      </div>
      <label className="label mt-3">Avoid</label>
      <div className="mb-3 flex flex-wrap gap-3">
        {TRAINING_AVOID.map((a) => (
          <label key={a} className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={persona.avoid.includes(a)}
              onChange={(e) => put("avoid", e.target.checked ? [...persona.avoid, a] : persona.avoid.filter((x) => x !== a))}
            />
            {a}
          </label>
        ))}
      </div>
      <label className="label">Extra note (optional)</label>
      <input className="input" maxLength={300} value={persona.notes} onChange={(e) => put("notes", e.target.value)} />
      <Flags errors={flagsFor(errors, "training.persona.notes")} />
    </div>
  );
}

function PhrasesEditor({ form, training, set, errors }: EditorProps & { form: CallFlowDefinition }) {
  const english = form.language === "en";
  const pure = !english && languageStyleOf(form) === "pure";
  const add = () =>
    set((t) =>
      t.phrases.push({ id: newTrainingId("ph"), status: "draft", situation: "acknowledge", style: english ? "english" : pure ? "pure" : "mixed", text: "", when: "", reviewed: false }),
    );
  const put = <K extends keyof TrainingPhrase>(i: number, k: K, v: TrainingPhrase[K]) => set((t) => void (t.phrases[i]![k] = v));
  return (
    <div>
      <p className="mb-3 text-xs text-slate-550">
        Short approved phrases per situation. Each reply is offered the phrases that fit what the customer just said; the
        phrase used in the previous reply is never offered again, so it isn't repeated twice in a row. Use{" "}
        {"{{title_to_use}}"} for sir / madam. If “thinking” acknowledgements (THINKING_ACK) are on, avoid telling the agent
        to <i>start</i> every reply with one, or it may be said twice.
        {!english && " Phrases need a native speaker's review before you make them Active."}
      </p>
      {training.phrases.map((ph, i) => (
        <EntryCard
          key={ph.id}
          status={ph.status}
          onStatus={(s) => put(i, "status", s)}
          onRemove={() => set((t) => void t.phrases.splice(i, 1))}
          badges={<Badge tone={ph.reviewed ? "ok" : "neutral"}>{ph.reviewed ? "reviewed" : "not reviewed"}</Badge>}
        >
          <div className="grid gap-2 sm:grid-cols-[180px_1fr]">
            <select className="input py-1 text-xs" value={ph.situation} onChange={(e) => put(i, "situation", e.target.value as TrainingPhrase["situation"])}>
              {TRAINING_SITUATIONS.map((s) => (
                <option key={s} value={s}>
                  {TRAINING_SITUATION_LABELS[s]}
                </option>
              ))}
            </select>
            <input className="input py-1" maxLength={120} placeholder={english ? "Okay {{title_to_use}}." : "சரிங்க {{title_to_use}}."} value={ph.text} onChange={(e) => put(i, "text", e.target.value)} />
            {!english && (
              <select className="input py-1 text-xs" value={ph.style} onChange={(e) => put(i, "style", e.target.value as TrainingPhrase["style"])}>
                <option value="english">English words</option>
                <option value="mixed">Mixed (e.g. Tanglish)</option>
                <option value="pure">Pure {AI_CALL_LANGUAGE_NAMES[form.language]}</option>
              </select>
            )}
            <input className={`input py-1 text-xs ${english ? "sm:col-span-2" : ""}`} maxLength={160} placeholder="When to use it (optional), e.g. after a short yes" value={ph.when} onChange={(e) => put(i, "when", e.target.value)} />
          </div>
          <label className="mt-2 flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={ph.reviewed} onChange={(e) => put(i, "reviewed", e.target.checked)} /> Reviewed by a native speaker
          </label>
          <Flags errors={flagsFor(errors, `training.phrases.${i}`)} />
        </EntryCard>
      ))}
      <button type="button" className="btn-ghost text-xs" onClick={add}>
        + Add phrase
      </button>
    </div>
  );
}

function KnowledgeEditor({ training, set, errors }: EditorProps) {
  const add = (kind: TrainingKnowledge["kind"]) =>
    set((t) => t.knowledge.push({ id: newTrainingId(kind), status: "draft", kind, topic: "", always: false, questions: kind === "qa" ? [""] : [], text: "" }));
  const put = <K extends keyof TrainingKnowledge>(i: number, k: K, v: TrainingKnowledge[K]) => set((t) => void (t.knowledge[i]![k] = v));
  return (
    <div>
      <p className="mb-3 text-xs text-slate-550">
        Facts (always on, or picked when the topic comes up) and approved Q&A: the ways customers ask, and the exact answer.
        Write question variants the way the customer's words are transcribed. Never prices, savings, demos or meetings.
      </p>
      {training.knowledge.map((k, i) => (
        <EntryCard key={k.id} status={k.status} onStatus={(s) => put(i, "status", s)} onRemove={() => set((t) => void t.knowledge.splice(i, 1))} badges={<Badge tone="accent">{k.kind === "qa" ? "Q&A" : "fact"}</Badge>}>
          <div className="grid gap-2 sm:grid-cols-[180px_1fr]">
            <input className="input py-1 text-xs" maxLength={40} placeholder="Topic, e.g. website" value={k.topic} onChange={(e) => put(i, "topic", e.target.value)} />
            {k.kind === "fact" ? (
              <label className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={k.always} onChange={(e) => put(i, "always", e.target.checked)} /> In every reply (else only when relevant)
              </label>
            ) : (
              <textarea
                className="input h-16 py-1 text-xs"
                placeholder="Ways customers ask it, one per line"
                value={k.questions.join("\n")}
                onChange={(e) => put(i, "questions", e.target.value.split("\n").slice(0, 8))}
              />
            )}
          </div>
          <textarea className="input mt-2 h-16 py-1" maxLength={500} placeholder={k.kind === "qa" ? "The exact approved answer" : "The fact"} value={k.text} onChange={(e) => put(i, "text", e.target.value)} />
          <Flags errors={flagsFor(errors, `training.knowledge.${i}`)} />
        </EntryCard>
      ))}
      <div className="flex gap-2">
        <button type="button" className="btn-ghost text-xs" onClick={() => add("fact")}>
          + Add fact
        </button>
        <button type="button" className="btn-ghost text-xs" onClick={() => add("qa")}>
          + Add Q&A
        </button>
      </div>
    </div>
  );
}

function ExamplesEditor({ training, set, errors }: EditorProps) {
  const add = (kind: TrainingExample["kind"]) =>
    set((t) => t.examples.push({ id: newTrainingId("ex"), status: "draft", kind, source: "manual", customer: "", agent: "", reason: "", better: "" }));
  const put = <K extends keyof TrainingExample>(i: number, k: K, v: TrainingExample[K]) => set((t) => void (t.examples[i]![k] = v));
  return (
    <div>
      <p className="mb-3 text-xs text-slate-550">
        Short customer → agent exchanges. A bad example needs the reason and the better reply. Corrections made from a call
        (Call detail → transcript → “Create training from this turn”) arrive here as Drafts with personal details removed —
        check them, then make them Active.
      </p>
      {training.examples.map((ex, i) => (
        <EntryCard
          key={ex.id}
          status={ex.status}
          onStatus={(s) => put(i, "status", s)}
          onRemove={() => set((t) => void t.examples.splice(i, 1))}
          badges={
            <>
              <Badge tone={ex.kind === "good" ? "ok" : "crit"}>{ex.kind}</Badge>
              {ex.source === "call" && <Badge tone="accent">from a call</Badge>}
            </>
          }
        >
          <div className="grid gap-2">
            <div className="grid gap-2 sm:grid-cols-3">
              <select className="input py-1 text-xs" aria-label="Situation" value={ex.situation ?? ""} onChange={(e) => put(i, "situation", (e.target.value || null) as TrainingSituation | null)}>
                <option value="">Any situation</option>
                {TRAINING_SITUATIONS.map((s) => (
                  <option key={s} value={s}>
                    {TRAINING_SITUATION_LABELS[s]}
                  </option>
                ))}
              </select>
              <input className="input py-1 text-xs" aria-label="Topic" maxLength={40} placeholder="Topic (optional), e.g. price" value={ex.topic ?? ""} onChange={(e) => put(i, "topic", e.target.value || undefined)} />
              <select className="input py-1 text-xs" aria-label="Language style" value={ex.style ?? ""} onChange={(e) => put(i, "style", (e.target.value || null) as TrainingExample["style"])}>
                <option value="">Any language style</option>
                <option value="english">English</option>
                <option value="mixed">Mixed (e.g. Tanglish)</option>
                <option value="pure">Pure (call language only)</option>
              </select>
            </div>
            <input className="input py-1" maxLength={300} placeholder="Customer says…" value={ex.customer} onChange={(e) => put(i, "customer", e.target.value)} />
            <input className="input py-1" maxLength={300} placeholder={ex.kind === "good" ? "Good agent reply" : "The agent's bad reply"} value={ex.agent} onChange={(e) => put(i, "agent", e.target.value)} />
            {ex.kind === "bad" && (
              <>
                <input className="input py-1 text-xs" maxLength={200} placeholder="Why it is bad" value={ex.reason} onChange={(e) => put(i, "reason", e.target.value)} />
                <input className="input py-1" maxLength={300} placeholder="The better reply" value={ex.better} onChange={(e) => put(i, "better", e.target.value)} />
              </>
            )}
          </div>
          <Flags errors={flagsFor(errors, `training.examples.${i}`)} />
        </EntryCard>
      ))}
      <div className="flex gap-2">
        <button type="button" className="btn-ghost text-xs" onClick={() => add("good")}>
          + Good example
        </button>
        <button type="button" className="btn-ghost text-xs" onClick={() => add("bad")}>
          + Bad example
        </button>
      </div>
    </div>
  );
}

function TestPanel({
  form,
  flowId,
  message,
  setMessage,
  preview,
}: {
  form: CallFlowDefinition;
  flowId: string;
  message: string;
  setMessage: (m: string) => void;
  preview: CallFlowPreview | undefined;
}) {
  const confirm = useConfirm();
  // Mock by default: nothing is sent to a provider. Real needs the checkbox and a confirm.
  const [mode, setMode] = useState<TrainingTestMode>("mock");
  const providers = useAiProviderSettings(form.language, mode === "real");
  const usable = providers.data?.usable_llm ?? [];
  const [providerId, setProviderId] = useState("");
  const [understood, setUnderstood] = useState(false);
  const chosen = providerId || usable[0] || "";
  const label = (id: string) => providers.data?.providers.find((p) => p.id === id)?.label ?? id;
  const test = useMutation({
    mutationFn: async () => {
      if (mode === "real") {
        const ok = await confirm({
          title: "Run a real provider test?",
          body: `${label(chosen)} answers twice (without and with the training). This uses tokens of your account. No phone number or customer data is sent and no call is placed.`,
          confirmText: "Use the provider",
        });
        if (!ok) return null;
      }
      return api<TrainingTestResult>(`/api/call-flows/${flowId}/training/test`, {
        method: "POST",
        json: { definition: form, mode, message, ...(mode === "real" ? { providerId: chosen, confirmCost: true } : {}) },
        notify: false,
      });
    },
  });
  const realBlocked = mode === "real" && (!chosen || !understood);
  const modes: [TrainingTestMode, string][] = [
    ["mock", "Mock (free)"],
    ["real", "Real provider"],
  ];
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex gap-1 rounded-lg bg-surface-muted p-1" role="tablist">
          {modes.map(([key, text]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={mode === key}
              onClick={() => {
                setMode(key);
                test.reset();
              }}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${mode === key ? "bg-surface text-ink shadow-sm" : "text-slate-550 hover:text-ink"}`}
            >
              {text}
            </button>
          ))}
        </div>
        <span className="text-xs text-slate-550">
          Language: {AI_CALL_LANGUAGE_NAMES[form.language]}
          {form.language !== "en" ? ` (${languageStyleOf(form)} style)` : ""} · never places a call
        </span>
      </div>
      {mode === "mock" ? (
        <p className="mb-3 rounded-lg border border-line px-3 py-2 text-xs text-slate-550">
          Mock: no provider is asked and nothing is spent. The “reply” is simulated from the training entries picked for the
          message (an approved answer, else a phrase), so you can check what gets selected and how big the prompt is.
        </p>
      ) : (
        <div className="mb-3 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
          <p className="mb-1">
            A real test: the provider answers twice (without and with the Active training) and{" "}
            <b>uses tokens of your account</b>. The sample customer is “Ragul”, with no phone number. Unsaved edits are tested
            as they are.
          </p>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> I understand this
            uses provider tokens
          </label>
        </div>
      )}
      <div className={`mb-2 grid gap-2 ${mode === "real" ? "sm:grid-cols-[1fr_200px]" : ""}`}>
        <input className="input" maxLength={300} placeholder="What the customer says, e.g. How much does it cost?" value={message} onChange={(e) => setMessage(e.target.value)} />
        {mode === "real" && (
          <select className="input" value={chosen} onChange={(e) => setProviderId(e.target.value)} disabled={!usable.length}>
            {usable.length === 0 && <option value="">No enabled LLM provider</option>}
            {usable.map((id) => (
              <option key={id} value={id}>
                {label(id)}
              </option>
            ))}
          </select>
        )}
      </div>
      {mode === "real" && providers.error && <ErrorNote error={providers.error} />}
      <button type="button" className="btn-primary mb-3" disabled={!message.trim() || realBlocked || test.isPending} onClick={() => test.mutate()}>
        {test.isPending
          ? mode === "real"
            ? "Asking the provider…"
            : "Simulating…"
          : mode === "real"
            ? "Compare replies (uses the provider)"
            : "Compare replies (mock)"}
      </button>
      {test.error && <ErrorNote error={test.error} />}
      {test.data && (
        <>
          {test.data.mode === "mock" ? (
            <p className="mb-2 rounded-lg border border-line bg-surface-muted px-3 py-2 text-xs text-slate-550">
              <b>Simulated — these are not AI replies.</b> Mock mode asks no AI: the right card shows the approved answer or
              phrase the training would offer for this message, the left card only explains what happens without training.
              The prompt sizes are real. To see what the AI actually says, use a Real provider test.
            </p>
          ) : (
            <p className="mb-2 text-[11px] text-slate-550">{`${label(test.data.provider_id)} · ${test.data.model}`}</p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <ReplyCard title={test.data.mode === "mock" ? "Without training (simulated)" : "Without training"} r={test.data.without} simulated={test.data.mode === "mock"} />
            <ReplyCard title={test.data.mode === "mock" ? "With training (simulated from picked entries)" : "With training"} r={test.data.with} simulated={test.data.mode === "mock"} />
          </div>
          <div className="mt-3 rounded-lg border border-line p-3 text-xs">
            <div className="mb-1 font-semibold">Training entries picked for this message ({test.data.selected.length})</div>
            {test.data.selected.length ? (
              test.data.selected.map((l, i) => <div key={i}>{l}</div>)
            ) : (
              <div className="text-slate-550">None: only the always-on part (agent profile, tone, facts) is sent.</div>
            )}
            {test.data.dropped.length > 0 && (
              <>
                <div className="mb-1 mt-2 font-semibold text-warn">Left out because the token cap was reached ({test.data.dropped.length})</div>
                {test.data.dropped.map((l, i) => (
                  <div key={i} className="text-slate-550">
                    {l}
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}
      <details className="mt-3 rounded-lg border border-line">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium">Training block picked for this message</summary>
        <div className="border-t border-line/70 p-3">
          <CompiledBlock preview={preview} />
        </div>
      </details>
    </div>
  );
}

function ReplyCard({ title, r, simulated = false }: { title: string; r: TrainingTestReply; simulated?: boolean }) {
  // A simulated note (no entry matched, or the "without" side) is shown as a note, not as a quoted reply.
  const note = simulated && !!r.reply && r.reply.startsWith("(simulated");
  return (
    <div className={`rounded-lg border p-3 ${simulated ? "border-dashed border-line" : "border-line"}`}>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs font-semibold">
        {title}
        {simulated && <Badge tone="neutral">simulated</Badge>}
      </div>
      {r.error ? (
        <p className="text-xs text-crit">{r.error}</p>
      ) : note ? (
        <p className="mb-2 text-xs italic text-slate-550">{r.reply!.replace(/^\(simulated[^)]*\)\s*/, "")}</p>
      ) : (
        <p className="mb-2">“{r.reply}”{r.ends_call ? " (ends the call)" : ""}</p>
      )}
      <p className="text-[11px] text-slate-550">
        Prompt ~{r.prompt_tokens.toLocaleString()} tokens
        {r.first_token_ms != null ? ` · first token ${r.first_token_ms} ms` : ""}
        {r.total_ms != null ? ` · total ${r.total_ms} ms` : ""}
      </p>
    </div>
  );
}
