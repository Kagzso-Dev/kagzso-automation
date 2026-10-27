import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { aiCallLanguagePath, type AiCallLanguage, type AiCallLanguageInfo } from "@dispatch/shared";
import { api, ApiError } from "../lib/api";
import { Badge, ErrorNote, Spinner } from "./ui";
import { useConfirm } from "./confirm";
import { useToast } from "./toast";
import { Switch } from "./Switch";

/**
 * Settings > AI call languages (admins): one voice backend per language. English is always on.
 * Tamil, Hindi and Kannada are always listed (their pages exist before their backend is set up),
 * plus any other language whose voice backend is set (VOICE_BACKEND_URL_<CODE> on the API), each
 * with its status and an on/off switch. Off: its pages are hidden for everyone and no new calls
 * start; past calls and recordings stay.
 */

interface LanguageRow extends AiCallLanguageInfo {
  /** Where Dispatch sends this language's calls (from the API's .env). */
  url: string | null;
  status: { reachable: boolean; ready: boolean; reportedLanguage: string | null; problem: string | null } | null;
}

/** How starting a language's voice backend went (switch on / Run). */
interface BackendRun {
  started: boolean;
  running: boolean;
  error: string | null;
}

export function AiCallLanguagesSection() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const list = useQuery({
    queryKey: ["ai-call-languages"],
    queryFn: () => api<{ items: LanguageRow[] }>("/api/ai-calls/languages", { notify: false }),
    retry: false,
  });
  const toast = useToast();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["ai-call-languages"] });
    void qc.invalidateQueries({ queryKey: ["ai-calls-config"] }); // the sidebar and the language pages
  };
  // Switching on also starts the language's voice backend when it is down (the server answers with how that went).
  const toggle = useMutation({
    mutationFn: ({ code, enabled }: { code: AiCallLanguage; enabled: boolean }) =>
      api<{ items: LanguageRow[]; backend: BackendRun | null }>(`/api/ai-calls/languages/${code}`, {
        method: "PUT",
        json: { enabled },
        notify: false,
      }),
    onSuccess: (r, v) => {
      const name = r.items.find((l) => l.code === v.code)?.name ?? v.code;
      if (!v.enabled) toast.success(`${name} switched off`);
      else if (r.backend?.error) toast.error(`${name} is on, but its voice backend didn't start`, [r.backend.error]);
      else toast.success(`${name} switched on`, r.backend?.started ? ["Its voice backend is running."] : undefined);
      refresh();
    },
  });
  // "Run": start a language's voice backend that is down.
  const run = useMutation({
    mutationFn: (code: AiCallLanguage) => api<BackendRun>(`/api/ai-calls/languages/${code}/run`, { method: "POST", notify: false }),
    onSuccess: (r) => {
      toast.success(r.started ? "Voice backend started" : "Voice backend is already running");
      refresh();
    },
    onError: (err) => {
      toast.fromError(err, "The voice backend didn't start");
      refresh();
    },
  });
  const busy = (code: AiCallLanguage) =>
    (toggle.isPending && toggle.variables?.code === code) || (run.isPending && run.variables === code);

  // AI calls off (404): the section isn't shown at all.
  if (list.error instanceof ApiError && list.error.status === 404) return null;

  async function askDisable(l: LanguageRow) {
    const ok = await confirm({
      title: `Switch ${l.name} AI calls off?`,
      body:
        `The ${l.name} pages are hidden for everyone and no new ${l.name} calls start. Calls still waiting in a running ` +
        `${l.name} run are cancelled (a call already in progress finishes). Past calls, transcripts and recordings stay. ` +
        "You can switch it back on here at any time.",
      confirmText: "Switch off",
      tone: "danger",
    });
    if (ok) toggle.mutate({ code: l.code, enabled: false });
  }

  return (
    <section className="settings-section">
      <h2 className="settings-heading">AI call languages</h2>
      <div className="settings-card space-y-3">
        <p className="text-slate-550">
          Each language has its own voice backend, call flows and customer list, and a call stays in one language from start
          to end. All languages share the Sarvam key and the phone number. English is always on. Switching a language on
          also starts its voice backend; if a backend stops later, press Run.
        </p>
        {list.isLoading ? (
          <Spinner />
        ) : list.error ? (
          <ErrorNote error={list.error} />
        ) : (
          <ul className="divide-y divide-line/70 rounded-lg border border-line/70">
            {list.data!.items.map((l) => (
              <li key={l.code} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 text-sm">
                <span className="min-w-24 font-medium">{l.name}</span>
                <StatusBadge row={l} />
                {l.url && <span className="truncate font-mono text-xs text-slate-550" title={l.url}>{l.url}</span>}
                <span className="ml-auto flex items-center gap-3">
                  {l.enabled && (
                    <>
                      <Link className="text-action" to={aiCallLanguagePath(l.code, "/ai-call-customers")}>
                        Customers
                      </Link>
                      <Link className="text-action" to={aiCallLanguagePath(l.code, "/call-flows")}>
                        Call flows
                      </Link>
                    </>
                  )}
                  {/* Its voice backend is set up but not answering: start it here. */}
                  {l.configured && l.enabled && l.status && !l.status.reachable && (
                    <button
                      type="button"
                      className="btn-primary px-3 py-1 text-xs"
                      disabled={busy(l.code) || run.isPending}
                      onClick={() => run.mutate(l.code)}
                      title={`Start the ${l.name} voice backend`}
                    >
                      {run.isPending && run.variables === l.code ? "Starting…" : "▶ Run"}
                    </button>
                  )}
                  {/* On = its pages show, its voice backend runs and it can call; off asks first (it cancels calls still waiting). */}
                  <label className="flex items-center gap-2 text-xs text-slate-550">
                    {l.code === "en"
                      ? "Always on"
                      : toggle.isPending && toggle.variables?.code === l.code && toggle.variables.enabled
                        ? "Starting…"
                        : l.enabled
                          ? "On"
                          : "Off"}
                    <Switch
                      on={l.enabled}
                      label={`${l.name} AI calls`}
                      disabled={l.code === "en" || toggle.isPending || busy(l.code)}
                      onChange={(on) => (on ? toggle.mutate({ code: l.code, enabled: true }) : void askDisable(l))}
                    />
                  </label>
                </span>
                {l.status?.problem && <p className="w-full text-xs text-crit">{l.status.problem}</p>}
              </li>
            ))}
          </ul>
        )}
        {toggle.error && <ErrorNote error={toggle.error} />}
        <p className="text-xs text-slate-550">
          "No voice backend": the language's pages are there, but it can't call yet. Set up its voice backend (its own
          .env with CALL_LANGUAGE, port and database, e.g. npm run voice:lang:init -- ta) so Dispatch's .env gets
          VOICE_BACKEND_URL_&lt;CODE&gt;, then redeploy. See the README, "AI calls in more languages".
        </p>
      </div>
    </section>
  );
}

function StatusBadge({ row }: { row: LanguageRow }) {
  if (!row.configured) return <Badge tone="warn">no voice backend</Badge>;
  if (!row.status) return null;
  if (!row.status.reachable) return <Badge tone="crit">unreachable</Badge>;
  if (row.status.reportedLanguage && row.status.reportedLanguage !== row.code) return <Badge tone="crit">wrong language</Badge>;
  return row.status.ready ? <Badge tone="ok">ready</Badge> : <Badge tone="warn">not ready</Badge>;
}
