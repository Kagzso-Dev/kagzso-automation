import { useEffect, useState } from "react";
import {
  AI_CALL_LANGUAGE_NAMES,
  DEFAULT_AI_CALL_LANGUAGE,
  type AiCallLanguage,
  type AiProviderId,
  type AiProviderSettingsView,
  type AiProviderUpdateInput,
  type AiProviderView,
} from "@dispatch/shared";
import { ApiError } from "../lib/api";
import { useAiCallsConfig } from "../lib/aiCalls";
import {
  disableConsequence,
  usedByLiveCalls,
  useAiProviderSettings,
  useReencryptAiProviderKeys,
  useTestAiProvider,
  useUpdateAiProvider,
  useUpdateAiProviderSelection,
} from "../lib/aiProviders";
import { Badge, ErrorNote, Spinner, Tabs, type BadgeTone } from "../components/ui";
import { Switch } from "../components/Switch";
import { useConfirm } from "../components/confirm";

/**
 * Settings → AI providers (admins only; the API checks the role on every request). One tab per
 * language with a voice backend: each language has its own providers, keys and fallback order.
 */
export function AiProvidersPage() {
  const config = useAiCallsConfig();
  const languages: { value: AiCallLanguage; label: string }[] = [
    ...(config.data?.configured ? [{ value: DEFAULT_AI_CALL_LANGUAGE, label: AI_CALL_LANGUAGE_NAMES[DEFAULT_AI_CALL_LANGUAGE] }] : []),
    ...(config.data?.languages ?? [])
      .filter((l) => l.code !== DEFAULT_AI_CALL_LANGUAGE && l.configured)
      .map((l) => ({ value: l.code, label: l.name })),
  ];
  const [language, setLanguage] = useState<AiCallLanguage | null>(null);
  const current = language ?? languages[0]?.value ?? null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="page-title">AI providers</h1>
        <p className="text-slate-550">
          Which AI answers calls (with its fallback order), which model hears the customer and which voice speaks, set
          separately for each language. Keys are stored encrypted on that language's voice backend and are never shown
          again after saving. Nothing changes for calls until <b>Use for live calls</b> is switched on.
        </p>
      </header>
      {config.isLoading ? (
        <Spinner />
      ) : current === null ? (
        <p className="settings-card text-slate-550">No voice backend is set up yet (VOICE_BACKEND_URL in Dispatch's .env).</p>
      ) : (
        <>
          {languages.length > 1 && <Tabs tabs={languages} value={current} onChange={setLanguage} />}
          <LanguageProviders key={current} language={current} />
        </>
      )}
    </div>
  );
}

const STATUS: Record<AiProviderView["status"], { label: string; tone: BadgeTone }> = {
  configured: { label: "Configured", tone: "ok" },
  missing_key: { label: "Missing key", tone: "warn" },
  disabled: { label: "Disabled", tone: "neutral" },
  error: { label: "Error", tone: "crit" },
};

const KEY_SOURCE: Record<AiProviderView["key_source"], string> = {
  saved: "Key saved (encrypted)",
  environment: "Using the key from the server's .env",
  none: "No key",
  unreadable: "Saved key can't be read on this server",
};

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

function LanguageProviders({ language }: { language: AiCallLanguage }) {
  const settings = useAiProviderSettings(language, true);
  const selection = useUpdateAiProviderSelection(language);
  const reencrypt = useReencryptAiProviderKeys(language);
  const confirm = useConfirm();
  const view = settings.data;

  if (settings.isLoading) return <Spinner />;
  if (settings.error || !view) return <ErrorNote error={settings.error} />;

  const toggleLive = async (on: boolean) => {
    if (on && !(await confirm({
      title: `Use these settings for live ${AI_CALL_LANGUAGE_NAMES[language]} calls?`,
      body: "Calls that start from now on use the enabled providers below. Calls already running keep their settings.",
      confirmText: "Use for live calls",
    }))) return;
    try {
      await selection.mutateAsync({ live: on });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && await confirm({
        title: "No LLM provider is ready",
        body: `${e.message} Calls would keep using the server's .env LLM (${view.env_llm}).`,
        confirmText: "Switch on anyway",
      })) await selection.mutateAsync({ live: on, confirm: true });
    }
  };

  const llm = view.llm_order.map((id) => view.providers.find((p) => p.id === id)!).filter(Boolean);
  const move = (index: number, by: number) => {
    const order = [...view.llm_order];
    const [item] = order.splice(index, 1);
    order.splice(index + by, 0, item!);
    selection.mutate({ llm_order: order });
  };

  return (
    <div className="space-y-6">
      <section className="settings-card space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="font-semibold text-ink">Use for live calls</div>
            <p className="text-sm text-slate-550">
              {view.live
                ? "On: new calls use the enabled providers below."
                : `Off: calls use the server's .env settings (LLM ${view.env_llm}).`}
            </p>
          </div>
          <Switch on={view.live} label="Use for live calls" disabled={selection.isPending} onChange={toggleLive} />
        </div>
        {selection.error && !(selection.error instanceof ApiError && selection.error.status === 409) && (
          <p className="text-sm text-crit">{errorMessage(selection.error)}</p>
        )}
        {view.warnings.map((w) => (
          <p key={w} className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{w}</p>
        ))}
        {view.providers.some((p) => p.needs_reencrypt) && (
          <button className="btn-ghost" disabled={reencrypt.isPending} onClick={() => reencrypt.mutate()}>
            {reencrypt.isPending ? "Re-encrypting…" : "Re-encrypt keys with the current key"}
          </button>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="settings-heading">Language model (in fallback order)</h2>
        <p className="text-sm text-slate-550">
          The first enabled provider with a key answers. If it fails before saying anything (bad key, rate limit, timeout),
          the next one answers the same words — never after it has started speaking.
        </p>
        {llm.map((p, i) => (
          <ProviderCard key={p.id} language={language} provider={p} view={view}
            order={{ index: i, count: llm.length, move, busy: selection.isPending }} />
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="settings-heading">Speech-to-text (hearing)</h2>
        <p className="text-sm text-slate-550">
          Chosen separately from the language model. Off = the server's .env settings. Groq speech-to-text is not
          integrated in this project, so it isn't offered.
        </p>
        {view.providers.filter((p) => p.kind === "stt").map((p) => (
          <ProviderCard key={p.id} language={language} provider={p} view={view} />
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="settings-heading">Text-to-speech (speaking)</h2>
        <p className="text-sm text-slate-550">
          Off = the server's .env voice and each call flow's own voice. A new model that fails before speaking falls back
          to that working voice.
        </p>
        {view.providers.filter((p) => p.kind === "tts").map((p) => (
          <ProviderCard key={p.id} language={language} provider={p} view={view} />
        ))}
      </section>
    </div>
  );
}

function ProviderCard({
  language,
  provider: p,
  view,
  order,
}: {
  language: AiCallLanguage;
  provider: AiProviderView;
  view: AiProviderSettingsView;
  order?: { index: number; count: number; move: (index: number, by: number) => void; busy: boolean };
}) {
  const update = useUpdateAiProvider(language);
  const test = useTestAiProvider(language);
  const confirm = useConfirm();
  const [model, setModel] = useState(p.model ?? "");
  const [option, setOption] = useState(p.options.speaker ?? p.options.mode ?? "");
  const [apiKey, setApiKey] = useState("");
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    setModel(p.model ?? "");
    setOption(p.options.speaker ?? p.options.mode ?? "");
  }, [p.model, p.options.speaker, p.options.mode]);

  const optionName = p.kind === "tts" ? "speaker" : p.kind === "stt" ? "mode" : null;
  const busy = update.isPending || test.isPending;
  const dirty = model !== (p.model ?? "") || (optionName !== null && option !== (p.options[optionName] ?? "")) || apiKey.trim() !== "";

  const send = async (change: AiProviderUpdateInput, ask?: string) => {
    setNote(null);
    try {
      await update.mutateAsync({ id: p.id as AiProviderId, change });
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && await confirm({
        title: ask ?? "Continue?", body: e.message, confirmText: "Continue", tone: "danger",
      })) {
        await update.mutateAsync({ id: p.id as AiProviderId, change: { ...change, confirm: true } });
        return true;
      }
      setNote(errorMessage(e));
      return false;
    }
  };

  const save = async () => {
    const change: AiProviderUpdateInput = { model };
    if (optionName) change.options = { [optionName]: option || null };
    if (apiKey.trim()) change.api_key = apiKey.trim();
    if (await send(change)) {
      setApiKey(""); // the typed key is gone from the page once saved
      setNote("Saved.");
    }
  };

  const removeKey = async () => {
    if (!(await confirm({ title: `Remove the saved ${p.label} key?`, body: "Calls can't use this provider until a new key is saved.", confirmText: "Remove key", tone: "danger" }))) return;
    if (await send({ remove_key: true }, "This leaves no usable LLM provider")) setNote("Key removed.");
  };

  const toggle = async (on: boolean) => {
    if (!on && usedByLiveCalls(p, view) && !(await confirm({
      title: `Disable ${p.label}?`,
      body: `${disableConsequence(p, view)} Calls already running are not affected.`,
      confirmText: "Disable",
      tone: "danger",
    }))) return;
    // The backend still asks once more (409) when this would leave no usable language model.
    await send({ enabled: on }, `Disable ${p.label}?`);
  };

  const runTest = async () => {
    setNote(null);
    try {
      const res = await test.mutateAsync(p.id as AiProviderId);
      setNote(res.test ? `${res.test.status === "ok" ? "Connected" : res.test.message} (${res.test.latency_ms} ms)` : null);
    } catch (e) {
      setNote(errorMessage(e));
    }
  };

  const status = STATUS[p.status];
  return (
    <div className="settings-card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {order && (
            <span className="flex flex-col">
              <button className="text-xs text-slate-550 disabled:opacity-30" aria-label={`Move ${p.label} up`}
                disabled={order.busy || order.index === 0} onClick={() => order.move(order.index, -1)}>▲</button>
              <button className="text-xs text-slate-550 disabled:opacity-30" aria-label={`Move ${p.label} down`}
                disabled={order.busy || order.index === order.count - 1} onClick={() => order.move(order.index, 1)}>▼</button>
            </span>
          )}
          <span className="font-semibold text-ink">{order ? `${order.index + 1}. ` : ""}{p.label}</span>
          <Badge tone={status.tone}>{status.label}</Badge>
          {p.untested_model && <Badge tone="warn">Untested model</Badge>}
          {view.usable_llm[0] === p.id && view.live && <Badge tone="accent">Answering calls</Badge>}
        </div>
        <Switch on={p.enabled} label={`Enable ${p.label}`} disabled={busy} onChange={(on) => void toggle(on)} />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="label">Model</span>
          {p.kind === "llm" ? (
            <>
              <input className="input" list={`${language}-${p.id}-models`} value={model} disabled={busy}
                onChange={(e) => setModel(e.target.value)} placeholder="Model ID" />
              <datalist id={`${language}-${p.id}-models`}>{p.models.map((m) => <option key={m} value={m} />)}</datalist>
            </>
          ) : (
            <select className="input" value={model} disabled={busy} onChange={(e) => setModel(e.target.value)}>
              {p.models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          )}
        </label>
        {optionName === "speaker" && (
          <label className="block">
            <span className="label">{model === "bulbul:v4-flash" ? "Persona voice id" : "Voice (empty = flow / .env voice)"}</span>
            <input className="input" value={option} disabled={busy} onChange={(e) => setOption(e.target.value)}
              placeholder={model === "bulbul:v4-flash" ? "name_language_style" : "e.g. ishita"} />
          </label>
        )}
        {optionName === "mode" && (
          <label className="block">
            <span className="label">Mode (saaras:v3)</span>
            <select className="input" value={option} disabled={busy || model !== "saaras:v3"} onChange={(e) => setOption(e.target.value)}>
              <option value="">.env mode</option>
              {["codemix", "transcribe", "verbatim", "translit"].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        )}
        <label className="block">
          <span className="label">API key</span>
          <input className="input" type="password" autoComplete="new-password" value={apiKey} disabled={busy}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={p.key_configured ? "•••••••• (leave empty to keep)" : "Paste the API key"} />
          <span className="text-xs text-slate-550">{KEY_SOURCE[p.key_source]}</span>
        </label>
      </div>

      {p.untested_model && (
        <p className="text-sm text-warn">
          {p.model} has not been benchmarked here{p.model_allowed ? "" : " and is not allowed for production calls"}. Test it
          before using it for real calls.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary" disabled={busy || !dirty} onClick={() => void save()}>
          {update.isPending ? "Saving…" : "Save"}
        </button>
        <button className="btn-ghost" disabled={busy || !p.key_configured} onClick={() => void runTest()}
          title="Sends one small real request (uses a little API credit)">
          {test.isPending ? "Testing…" : "Test connection"}
        </button>
        {p.key_source === "saved" && (
          <button className="btn-danger" disabled={busy} onClick={() => void removeKey()}>Remove key</button>
        )}
        {note && <span className="text-sm text-slate-550">{note}</span>}
      </div>
      {p.last_test && (
        <p className={`text-xs ${p.last_test.status === "ok" ? "text-ok" : "text-crit"}`}>
          Last test {new Date(p.last_test.at).toLocaleString()}: {p.last_test.message}
        </p>
      )}
    </div>
  );
}
