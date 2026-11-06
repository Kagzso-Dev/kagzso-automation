import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AI_AGENT_CUSTOM_NAME_MAX,
  AI_AGENT_DEFAULT_VOICE,
  AI_AGENT_DEFAULTS,
  AI_AGENT_DURATION_LIMITS,
  AI_AGENT_GENDER_LABELS,
  AI_AGENT_GENDERS,
  AI_AGENT_INSTRUCTIONS_MAX,
  AI_AGENT_OBJECTIVE_MAX,
  AI_AGENT_PERSONALITIES,
  AI_AGENT_PERSONALITY_LABELS,
  AI_CALL_LANGUAGE_NAMES,
  aiAgentInput,
  aiAgentLanguageSupported,
  matchLibraryName,
  type AiAgentInput,
  type AiAgentView,
  type AiCallLanguage,
} from "@dispatch/shared";
import { api } from "../lib/api";
import { useAiCallLanguage } from "../lib/aiCallLanguage";
import { AGENT_QUERY_KEYS, useAiLibrary } from "../lib/aiAgents";
import { useCallFlows } from "../lib/callFlows";
import { AiAgentVoice } from "./AiAgentVoice";
import { PhoneInput, phoneInputOk } from "./PhoneInput";
import { useConfirm } from "./confirm";
import { useToast } from "./toast";
import { ErrorNote } from "./ui";

/** The "Other – Enter manually" choice of the Category / Industry lists (never sent: the typed name is). */
const OTHER = "__other__";
const OTHER_LABEL = "Other – Enter manually";

type Form = Required<
  Omit<AiAgentInput, "categoryId" | "customCategory" | "industryId" | "customIndustry" | "contactName" | "contactPhone" | "callbackNumber" | "guidedFlowId" | "voiceId">
> & {
  /** "" = no voice picked (the voice backend's default voice). */
  voiceId: string;
  /** A library id, OTHER (typed by hand, in customCategory / customIndustry) or "" (none). */
  categoryId: string;
  customCategory: string;
  industryId: string;
  customIndustry: string;
  contactName: string;
  contactPhone: string;
  callbackNumber: string;
  guidedFlowId: string;
};

function initial(a: AiAgentView | null, autonomousOk: boolean, language: AiCallLanguage): Form {
  return {
    name: a?.name ?? "",
    mode: a?.mode ?? (autonomousOk ? "autonomous" : "guided"),
    // A name typed for this agent comes back as "Other – Enter manually" with the name filled in.
    categoryId: a?.categoryId ?? (a?.customCategory ? OTHER : ""),
    customCategory: a?.customCategory ?? "",
    industryId: a?.industryId ?? (a?.customIndustry ? OTHER : ""),
    customIndustry: a?.customIndustry ?? "",
    businessName: a?.businessName ?? "",
    objective: a?.objective ?? "",
    contactName: a?.contactName ?? "",
    contactGender: a?.contactGender ?? AI_AGENT_DEFAULTS.contactGender,
    contactPhone: a?.contactPhone ?? "",
    executiveName: a?.executiveName ?? AI_AGENT_DEFAULTS.executiveName,
    companyName: a?.companyName ?? AI_AGENT_DEFAULTS.companyName,
    callbackNumber: a?.callbackNumber ?? "",
    personality: a?.personality ?? AI_AGENT_DEFAULTS.personality,
    instructions: a?.instructions ?? "",
    targetDurationSec: a?.targetDurationSec ?? AI_AGENT_DEFAULTS.targetDurationSec,
    maxDurationSec: a?.maxDurationSec ?? AI_AGENT_DEFAULTS.maxDurationSec,
    guidedFlowId: a?.guidedFlowId ?? "",
    // An existing agent keeps its own voice (none = as before); a new one starts with the language's default voice.
    voiceId: a ? (a.voiceId ?? "") : (AI_AGENT_DEFAULT_VOICE[language] ?? ""),
    voiceSpeed: a?.voiceSpeed ?? AI_AGENT_DEFAULTS.voiceSpeed,
  };
}

const fmt = (sec: number) => (sec % 60 ? `${Math.floor(sec / 60)} min ${sec % 60} s` : `${sec / 60} min`);

/** The agent's settings (create or edit). Saving never publishes: an autonomous agent is published from its own tab. */
export function AiAgentForm({ agent, onCreated }: { agent: AiAgentView | null; onCreated: (id: string) => void }) {
  const language = useAiCallLanguage();
  const autonomousOk = aiAgentLanguageSupported(language);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const library = useAiLibrary();
  const flows = useCallFlows(true, language);
  const [f, setF] = useState<Form>(() => initial(agent, autonomousOk, language));
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));

  const categories = library.data ?? [];
  const typedCategory = f.categoryId === OTHER;
  const typedIndustry = f.industryId === OTHER;
  // The selected category's industries (all of them while no category is picked; none for a typed category:
  // library industries belong to library categories).
  const industries = useMemo(
    () =>
      typedCategory
        ? []
        : categories.flatMap((c) => c.industries.map((i) => ({ ...i, categoryName: c.name }))).filter((i) => !f.categoryId || i.categoryId === f.categoryId),
    [categories, f.categoryId, typedCategory],
  );
  // A typed name that is already in the list: offered as the list entry (the API saves it as that entry anyway).
  const categoryMatch = typedCategory ? matchLibraryName(f.customCategory, categories) : undefined;
  const industryMatch = typedIndustry && f.categoryId && !typedCategory ? matchLibraryName(f.customIndustry, industries) : undefined;
  const published = (flows.data?.items ?? []).filter((x) => x.published);

  const body: AiAgentInput = {
    ...f,
    categoryId: typedCategory ? null : f.categoryId || null,
    customCategory: typedCategory ? f.customCategory : null,
    industryId: typedIndustry ? null : f.industryId || null,
    customIndustry: typedIndustry ? f.customIndustry : null,
    contactName: f.contactName.trim() || null,
    contactPhone: f.contactPhone || null,
    callbackNumber: f.callbackNumber || null,
    guidedFlowId: f.mode === "guided" ? f.guidedFlowId || null : null,
    // Guided agents call with their Call Flow's own voice: their saved voice (if any) is left as it is.
    voiceId: f.mode === "autonomous" ? f.voiceId || null : undefined,
    // Likewise the speed; a guided agent doesn't show it, so a speed typed before switching can't block saving.
    voiceSpeed: f.mode === "autonomous" ? f.voiceSpeed : (agent?.voiceSpeed ?? AI_AGENT_DEFAULTS.voiceSpeed),
  };
  const check = aiAgentInput.safeParse(body);
  const fieldError = (k: string) => (!check.success ? check.error.issues.find((i) => i.path[0] === k)?.message : undefined);
  const phonesOk = phoneInputOk(f.contactPhone) && phoneInputOk(f.callbackNumber);

  const save = useMutation({
    mutationFn: () =>
      agent
        ? api<AiAgentView>(`/api/ai-agents/${agent.id}`, { method: "PUT", json: { agent: body } })
        : api<AiAgentView>("/api/ai-agents", { method: "POST", json: { language, agent: body } }),
    onSuccess: (saved) => {
      AGENT_QUERY_KEYS.forEach((k) => void qc.invalidateQueries({ queryKey: [...k] }));
      toast.success(agent ? "AI agent saved" : "AI agent created", [
        saved.mode === "autonomous" ? "Add knowledge, then preview and publish it." : "It calls with its Call Flow.",
      ]);
      if (!agent) onCreated(saved.id);
    },
  });

  const archive = useMutation({
    mutationFn: () => api(`/api/ai-agents/${agent!.id}`, { method: "DELETE" }),
    onSuccess: () => AGENT_QUERY_KEYS.forEach((k) => void qc.invalidateQueries({ queryKey: [...k] })),
  });

  return (
    <div className="max-w-4xl space-y-5 text-sm">
      <Section title="Conversation mode">
        <div className="flex flex-wrap gap-2">
          {(["autonomous", "guided"] as const).map((m) => (
            <button
              key={m}
              type="button"
              disabled={m === "autonomous" && !autonomousOk}
              onClick={() => set("mode", m)}
              className={`rounded-lg border px-3 py-2 text-left ${f.mode === m ? "border-accent bg-tint font-semibold" : "border-line"} disabled:opacity-50`}
            >
              {m === "autonomous" ? "Autonomous AI conversation" : "Guided (existing Call Flow)"}
              <span className="block text-xs font-normal text-slate-550">
                {m === "autonomous"
                  ? "The AI leads the conversation from the business context and the customer's answers."
                  : "Calls with a published Call Flow exactly as it is (Nila, Follow-up, Executive or a copy)."}
              </span>
            </button>
          ))}
        </div>
        {!autonomousOk && (
          <p className="mt-2 text-xs text-warn">Autonomous agents have no reviewed opening lines in {AI_CALL_LANGUAGE_NAMES[language]} yet.</p>
        )}
      </Section>

      <Section title="Agent">
        <Field label="Agent name (for your list)" error={fieldError("name")}>
          <input className="input" maxLength={100} value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. ABC Hospital — Thaara" />
        </Field>
      </Section>

      {f.mode === "guided" ? (
        <Section title="Call Flow">
          <Field label="Published Call Flow of this language" error={fieldError("guidedFlowId")}>
            <select className="input" value={f.guidedFlowId} onChange={(e) => set("guidedFlowId", e.target.value)}>
              <option value="">Pick a Call Flow…</option>
              {published.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} · live v{x.published!.version}
                </option>
              ))}
            </select>
          </Field>
          <ContactFields f={f} set={set} />
        </Section>
      ) : (
        <>
          <Section title="Business">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Category" error={fieldError("categoryId")}>
                <select
                  className="input"
                  value={f.categoryId}
                  onChange={(e) => {
                    const v = e.target.value;
                    // Typed category → the industry is typed too; another category → pick its industry again.
                    setF((p) => ({ ...p, categoryId: v, industryId: v === OTHER ? OTHER : p.industryId === OTHER ? OTHER : "" }));
                  }}
                >
                  <option value="">Pick a category…</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                  <option value={OTHER}>{OTHER_LABEL}</option>
                </select>
              </Field>
              <Field label="Industry" error={fieldError("industryId")}>
                <select
                  className="input"
                  value={f.industryId}
                  disabled={typedCategory}
                  onChange={(e) => {
                    const ind = industries.find((i) => i.id === e.target.value);
                    setF((p) => ({ ...p, industryId: e.target.value, categoryId: ind?.categoryId ?? p.categoryId }));
                  }}
                >
                  {!typedCategory && <option value="">Pick an industry…</option>}
                  {industries.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                  <option value={OTHER}>{OTHER_LABEL}</option>
                </select>
              </Field>
              {typedCategory && (
                <Field label="Category name" error={fieldError("customCategory")}>
                  <input
                    className="input"
                    maxLength={AI_AGENT_CUSTOM_NAME_MAX}
                    value={f.customCategory}
                    onChange={(e) => set("customCategory", e.target.value)}
                    placeholder="e.g. Manufacturing"
                  />
                  {categoryMatch && (
                    <MatchNote name={categoryMatch.name} kind="category" onUse={() => setF((p) => ({ ...p, categoryId: categoryMatch.id, industryId: OTHER }))} />
                  )}
                </Field>
              )}
              {typedIndustry && (
                <Field label="Industry name" error={fieldError("customIndustry")}>
                  <input
                    className="input"
                    maxLength={AI_AGENT_CUSTOM_NAME_MAX}
                    value={f.customIndustry}
                    onChange={(e) => set("customIndustry", e.target.value)}
                    placeholder="e.g. Textile mill"
                  />
                  {industryMatch && (
                    <MatchNote name={industryMatch.name} kind="industry" onUse={() => setF((p) => ({ ...p, industryId: industryMatch.id }))} />
                  )}
                </Field>
              )}
              <Field label="Business / company name" error={fieldError("businessName")}>
                <input className="input" maxLength={160} value={f.businessName} onChange={(e) => set("businessName", e.target.value)} placeholder="e.g. ABC Hospital" />
              </Field>
            </div>
            <Field label="Calling objective" error={fieldError("objective")}>
              <textarea
                className="input min-h-[70px]"
                maxLength={AI_AGENT_OBJECTIVE_MAX}
                value={f.objective}
                onChange={(e) => set("objective", e.target.value)}
                placeholder="e.g. Introduce our AI and automation solutions for hospitals and find out whether they'd like a follow-up from our team."
              />
            </Field>
            <p className="text-xs text-slate-550">
              Industries and their discovery topics are managed in Settings → AI agent industries (shared by every language). Not in the list? Pick
              “{OTHER_LABEL}”: the name is saved for this agent only and the shared list doesn't change.
            </p>
          </Section>

          <Section title="Contact">
            <ContactFields f={f} set={set} />
            <p className="text-xs text-slate-550">
              Entered details are never treated as verified: the AI asks for the contact by name and handles a different person politely.
            </p>
          </Section>

          <Section title="AI executive">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="AI executive name" error={fieldError("executiveName")}>
                <input className="input" maxLength={40} value={f.executiveName} onChange={(e) => set("executiveName", e.target.value)} />
              </Field>
              <Field label="Calling on behalf of (company)" error={fieldError("companyName")}>
                <input className="input" maxLength={100} value={f.companyName} onChange={(e) => set("companyName", e.target.value)} />
              </Field>
              <Field label="Company callback number (optional)">
                <PhoneInput value={f.callbackNumber} onChange={(v) => set("callbackNumber", v)} />
              </Field>
              <Field label="Speaking personality">
                <select className="input" value={f.personality} onChange={(e) => set("personality", e.target.value as Form["personality"])}>
                  {AI_AGENT_PERSONALITIES.map((p) => (
                    <option key={p} value={p}>
                      {AI_AGENT_PERSONALITY_LABELS[p]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Language">
                <div className="input bg-surface-muted text-slate-550">{AI_CALL_LANGUAGE_NAMES[language]} (this section's voice backend)</div>
              </Field>
            </div>
            <p className="text-xs text-slate-550">The callback number is only given when the customer asks how to reach the company or wants details the AI doesn't have.</p>
          </Section>

          <Section title="AI Voice">
            <AiAgentVoice
              language={language}
              value={f.voiceId}
              onChange={(v) => set("voiceId", v)}
              speed={f.voiceSpeed}
              onSpeedChange={(v) => set("voiceSpeed", v)}
              speedError={fieldError("voiceSpeed")}
              executiveName={f.executiveName}
            />
          </Section>

          <Section title="Call settings">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={`Target duration (${fmt(f.targetDurationSec)})`} error={fieldError("targetDurationSec")}>
                <input
                  type="range"
                  className="w-full"
                  min={AI_AGENT_DURATION_LIMITS.minTarget}
                  max={AI_AGENT_DURATION_LIMITS.maxTarget}
                  step={5}
                  value={f.targetDurationSec}
                  onChange={(e) => set("targetDurationSec", Number(e.target.value))}
                />
              </Field>
              <Field label={`Maximum duration (${fmt(f.maxDurationSec)}, hard stop)`}>
                <input
                  type="range"
                  className="w-full"
                  min={AI_AGENT_DURATION_LIMITS.minMax}
                  max={AI_AGENT_DURATION_LIMITS.maxMax}
                  step={5}
                  value={f.maxDurationSec}
                  onChange={(e) => set("maxDurationSec", Number(e.target.value))}
                />
              </Field>
            </div>
            <p className="text-xs text-slate-550">
              After the target the AI moves to a polite close (never cutting the customer off); the phone system ends the call at the maximum. A
              customer who is busy, refuses or asks not to be called again ends the call at once, and do-not-call is always enforced by the system.
            </p>
          </Section>

          <Section title="AI Conversation Instructions">
            <textarea
              className="input min-h-[160px] font-mono text-xs"
              maxLength={AI_AGENT_INSTRUCTIONS_MAX}
              value={f.instructions}
              onChange={(e) => set("instructions", e.target.value)}
              placeholder={
                "Additional business information, specific objectives, questions to explore, restrictions, topics to avoid, approved statements, follow-up instructions.\n" +
                "e.g.\nAsk which department spends the most time on manual work.\nDo not discuss pricing.\nAvoid talking about competitors."
              }
            />
            <p className="text-xs text-slate-550">
              Applied on every reply of every call. When they conflict with anything, this order decides: 1. safety, do-not-call and refusal ·
              2. legal and mandatory disclosures · 3. approved company and product facts · 4. these restrictions · 5. the objective and preferences.
              {` ${f.instructions.length}/${AI_AGENT_INSTRUCTIONS_MAX}`}
            </p>
          </Section>
        </>
      )}

      {save.error && <ErrorNote error={save.error} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {agent ? (
          <button
            type="button"
            className="btn btn-danger"
            onClick={async () => {
              const ok = await confirm({
                title: `Remove "${agent.name}"?`,
                body: "It disappears from this list. Its published Call Flow stays (as an ordinary flow), and so does every call's history.",
                confirmText: "Remove",
              });
              if (ok) archive.mutate();
            }}
          >
            Remove agent
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="btn-primary" disabled={!check.success || !phonesOk || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : agent ? "Save settings" : "Create AI agent"}
        </button>
      </div>
    </div>
  );
}

function ContactFields({ f, set }: { f: Form; set: <K extends keyof Form>(k: K, v: Form[K]) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="Contact person's name">
        <input className="input" maxLength={100} value={f.contactName} onChange={(e) => set("contactName", e.target.value)} placeholder="e.g. Ragul" />
      </Field>
      <Field label="Gender (for sir / madam)">
        <select className="input" value={f.contactGender} onChange={(e) => set("contactGender", e.target.value as Form["contactGender"])}>
          {AI_AGENT_GENDERS.map((g) => (
            <option key={g} value={g}>
              {AI_AGENT_GENDER_LABELS[g]}
              {g === "unspecified" ? " (neutral greeting)" : ""}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Contact mobile number">
        <PhoneInput value={f.contactPhone} onChange={(v) => set("contactPhone", v)} />
      </Field>
    </div>
  );
}

/** A typed category / industry that is already in the shared list. */
function MatchNote({ name, kind, onUse }: { name: string; kind: "category" | "industry"; onUse: () => void }) {
  return (
    <p className="mt-1 text-xs text-slate-550">
      “{name}” is already in the list, so it will be saved as that {kind}.{" "}
      <button type="button" className="font-semibold text-accent underline" onClick={onUse}>
        Select it
      </button>
    </p>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold text-ink">{title}</h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {error && <p className="mt-1 text-xs text-crit">{error}</p>}
    </div>
  );
}
