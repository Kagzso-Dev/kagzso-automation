import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AI_CALL_LANGUAGE_NAMES, aiAgentLanguageSupported, type AiAgentView } from "@dispatch/shared";
import { PageHeader } from "../components/Layout";
import { AiAgentForm } from "../components/AiAgentForm";
import { AiAgentKnowledge } from "../components/AiAgentKnowledge";
import { AiAgentPublish } from "../components/AiAgentPublish";
import { AiAgentCall } from "../components/AiAgentCall";
import { AiCallLanguageNotice } from "../components/AiCallLanguageNotice";
import { useConfirm } from "../components/confirm";
import { Badge, EmptyState, ErrorNote, Spinner, Tabs } from "../components/ui";
import { useAiCallsConfig } from "../lib/aiCalls";
import { titleFor, useAiCallLanguage } from "../lib/aiCallLanguage";
import { api } from "../lib/api";
import { AGENT_QUERY_KEYS, useAiAgent, useAiAgents } from "../lib/aiAgents";

type Tab = "settings" | "knowledge" | "publish" | "call";

/**
 * AI Agents (/ai-agents, /ta/ai-agents, …): an AI business executive per business, in this section's language
 * (its voice backend). Autonomous agents are compiled into an ordinary "executive" Call Flow when published;
 * guided agents call with an existing published Call Flow. Admins only (lib/navAccess).
 */
export function AiAgentsPage() {
  const config = useAiCallsConfig();
  const language = useAiCallLanguage();
  const agents = useAiAgents(language);
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [tab, setTab] = useState<Tab>("settings");
  const title = titleFor("AI Agents", language);

  if (config.isLoading) return <Spinner />;
  if (!config.data?.flowEditor) {
    return (
      <div>
        <PageHeader title={title} />
        <EmptyState icon="phone" title="Not available">
          AI agents need AI calls and call flows switched on (ENABLE_AI_CALLS, ENABLE_CALL_FLOW_EDITOR).
        </EmptyState>
      </div>
    );
  }

  if (selected) {
    return (
      <AgentEditor
        key={selected}
        id={selected === "new" ? null : selected}
        tab={selected === "new" ? "settings" : tab}
        setTab={setTab}
        onBack={() => setSelected(null)}
        onCreated={(id) => {
          setSelected(id);
          setTab("knowledge");
        }}
      />
    );
  }

  return (
    <div>
      <PageHeader
        title={title}
        subtitle={`AI business executives that call in ${AI_CALL_LANGUAGE_NAMES[language]}: business details, knowledge and instructions, then the AI leads the conversation within the fixed safety rules.`}
        action={
          <button type="button" className="btn-primary" onClick={() => setSelected("new")}>
            New AI agent
          </button>
        }
      />
      <AiCallLanguageNotice />
      {!aiAgentLanguageSupported(language) && (
        <p className="mb-3 rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-sm">
          Autonomous agents have no reviewed opening lines in {AI_CALL_LANGUAGE_NAMES[language]} yet: only guided agents (an existing Call Flow) can be used here.
        </p>
      )}
      {agents.isLoading ? (
        <Spinner />
      ) : agents.error ? (
        <ErrorNote error={agents.error} />
      ) : agents.data!.length === 0 ? (
        <EmptyState icon="phone" title="No AI agents yet">
          Create one for each business you call: its industry, the calling objective, approved knowledge and any special instructions.
        </EmptyState>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {agents.data!.map((a) => (
            <li key={a.id}>
              <AgentCard
                agent={a}
                onOpen={(t) => {
                  setTab(t);
                  setSelected(a.id);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AgentCard({ agent: a, onOpen }: { agent: AiAgentView; onOpen: (tab: Tab) => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  // Archives the agent only (hidden from this list): its published Call Flow, knowledge and call history stay.
  const remove = useMutation({
    mutationFn: () => api(`/api/ai-agents/${a.id}`, { method: "DELETE" }),
    onSuccess: () => AGENT_QUERY_KEYS.forEach((key) => void qc.invalidateQueries({ queryKey: [...key] })),
  });
  return (
    <div className="card flex h-full flex-col gap-2 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="text-left font-semibold text-ink hover:underline" onClick={() => onOpen("settings")}>
          {a.name}
        </button>
        <Badge tone={a.mode === "autonomous" ? "accent" : "neutral"}>{a.mode === "autonomous" ? "Autonomous" : "Guided"}</Badge>
        {a.liveVersion ? <Badge tone="ok">live v{a.liveVersion}</Badge> : <Badge tone="warn">not published</Badge>}
        {a.liveVersion && a.mode === "autonomous" && a.unpublishedChanges && <Badge tone="warn">unpublished changes</Badge>}
      </div>
      <div className="text-slate-550">
        {[a.businessName, a.executiveName && `${a.executiveName} · ${a.companyName}`].filter(Boolean).join(" — ")}
      </div>
      {a.mode === "autonomous" && a.voiceDisplayName && (
        <div className="text-xs text-slate-550">
          Voice: {a.voiceDisplayName}
          {a.voiceGender ? ` · ${a.voiceGender}` : ""}
        </div>
      )}
      {a.mode === "autonomous" && (
        <div className="text-xs text-slate-550">
          Knowledge: {a.knowledge.approved} approved · {a.knowledge.draft} to review · {a.knowledge.files} file(s)
        </div>
      )}
      <div className="mt-auto flex flex-wrap gap-2 pt-1">
        {a.mode === "autonomous" && (
          <button type="button" className="btn btn-ghost" onClick={() => onOpen("knowledge")}>
            Knowledge
          </button>
        )}
        {a.mode === "autonomous" && (
          <button type="button" className="btn btn-ghost" onClick={() => onOpen("publish")}>
            Preview &amp; publish
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={() => onOpen("call")}>
          Call
        </button>
        <button
          type="button"
          className="btn btn-ghost ml-auto text-crit"
          disabled={remove.isPending}
          onClick={async () => {
            if (
              await confirm({
                title: `Delete ${a.name}?`,
                body: "It is removed from this list. Its published Call Flow and past calls are kept.",
                confirmText: "Delete",
                tone: "danger",
              })
            )
              remove.mutate();
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function AgentEditor({
  id,
  tab,
  setTab,
  onBack,
  onCreated,
}: {
  id: string | null;
  tab: Tab;
  setTab: (t: Tab) => void;
  onBack: () => void;
  onCreated: (id: string) => void;
}) {
  const language = useAiCallLanguage();
  const agent = useAiAgent(id);
  if (id && agent.isLoading) return <Spinner />;
  if (id && agent.error) return <ErrorNote error={agent.error} />;
  const a = agent.data ?? null;
  const tabs: { value: Tab; label: string }[] = !a
    ? [{ value: "settings", label: "Settings" }]
    : a.mode === "autonomous"
      ? [
          { value: "settings", label: "Settings" },
          { value: "knowledge", label: `Knowledge (${a.knowledge.approved} approved)` },
          { value: "publish", label: "Preview & publish" },
          { value: "call", label: "Call" },
        ]
      : [
          { value: "settings", label: "Settings" },
          { value: "call", label: "Call" },
        ];
  const current = tabs.some((t) => t.value === tab) ? tab : "settings";
  return (
    <div>
      <button type="button" className="mb-3 text-sm text-accent-ink hover:underline" onClick={onBack}>
        ← All AI agents
      </button>
      <PageHeader
        title={a ? a.name : titleFor("New AI agent", language)}
        subtitle={
          a
            ? a.mode === "autonomous"
              ? a.liveVersion
                ? `Live v${a.liveVersion}${a.unpublishedChanges ? " — changes not published yet" : ""}`
                : "Not published yet: calls use the published version only"
              : "Guided: calls with its Call Flow exactly as published"
            : `Language: ${AI_CALL_LANGUAGE_NAMES[language]} (this section's voice backend)`
        }
      />
      <Tabs tabs={tabs} value={current} onChange={setTab} />
      {current === "settings" && <AiAgentForm agent={a} onCreated={onCreated} />}
      {current === "knowledge" && a && <AiAgentKnowledge agent={a} />}
      {current === "publish" && a && <AiAgentPublish agent={a} />}
      {current === "call" && a && <AiAgentCall agent={a} />}
    </div>
  );
}
