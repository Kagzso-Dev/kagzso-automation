import { useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AI_KNOWLEDGE_FORMATS,
  AI_KNOWLEDGE_MAX_APPROVED,
  AI_KNOWLEDGE_MAX_FILES_PER_UPLOAD,
  AI_KNOWLEDGE_TEXT_MAX,
  knowledgeTextIssues,
  type AiAgentView,
  type AiKnowledgeItemView,
  type AiKnowledgeStatus,
} from "@dispatch/shared";
import { api } from "../lib/api";
import { AGENT_QUERY_KEYS, useAgentKnowledge } from "../lib/aiAgents";
import { useConfirm } from "./confirm";
import { useToast } from "./toast";
import { Badge, EmptyState, ErrorNote, Modal, Spinner } from "./ui";

const ACCEPT = AI_KNOWLEDGE_FORMATS.map((f) => `.${f}`).join(",");
const STATUS_TONE = { draft: "neutral", approved: "ok", rejected: "crit" } as const;

/**
 * An agent's knowledge: upload files (CSV, XLSX, PDF, DOCX, TXT), review what was extracted, fix or reject, and
 * approve. Only approved items reach calls, and only after the agent is published again.
 */
export function AiAgentKnowledge({ agent }: { agent: AiAgentView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const k = useAgentKnowledge(agent.id);
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [filter, setFilter] = useState<AiKnowledgeStatus | "all" | "issues">("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<AiKnowledgeItemView | "new" | null>(null);
  const refresh = () => AGENT_QUERY_KEYS.forEach((key) => void qc.invalidateQueries({ queryKey: [...key] }));

  const uploadFiles = useMutation({
    mutationFn: async ({ files, replacesFileId }: { files: File[]; replacesFileId?: string }) => {
      const form = new FormData();
      files.forEach((f) => form.append("files", f));
      if (replacesFileId) form.append("replacesFileId", replacesFileId);
      return api<{ files: { fileName: string; itemCount?: number; error?: string | null; status?: string }[] }>(
        `/api/ai-agents/${agent.id}/knowledge/files`,
        { method: "POST", body: form, notify: false },
      );
    },
    onSuccess: (res) => {
      refresh();
      const lines = res.files.map((f) =>
        f.status === "failed" || (f.error && f.itemCount === undefined) ? `${f.fileName}: ${f.error}` : `${f.fileName}: ${f.itemCount ?? 0} item(s) to review`,
      );
      toast.success("Knowledge uploaded", lines);
    },
  });

  const decide = useMutation({
    mutationFn: (status: AiKnowledgeStatus) =>
      api<{ updated: number; refused: { id: string; reason: string }[] }>(`/api/ai-agents/${agent.id}/knowledge/decide`, {
        method: "POST",
        json: { ids: [...picked], status },
        notify: false,
      }),
    onSuccess: (res, status) => {
      refresh();
      setPicked(new Set());
      const head = `${res.updated} item(s) ${status === "draft" ? "back to draft" : status}`;
      if (res.refused.length) toast.error(head, res.refused.slice(0, 5).map((r) => r.reason));
      else toast.success(head, status === "approved" ? ["Publish the agent again to use them in calls."] : []);
    },
  });

  const removeFile = useMutation({
    mutationFn: (fileId: string) => api(`/api/ai-agents/${agent.id}/knowledge/files/${fileId}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  const items = k.data?.items ?? [];
  const shown = useMemo(
    () => items.filter((i) => (filter === "all" ? true : filter === "issues" ? i.issues.length > 0 : i.status === filter)),
    [items, filter],
  );
  const fileName = new Map((k.data?.files ?? []).map((f) => [f.id, f.fileName]));
  const approved = items.filter((i) => i.status === "approved").length;

  if (k.isLoading) return <Spinner />;
  if (k.error) return <ErrorNote error={k.error} />;

  return (
    <div className="max-w-5xl space-y-4 text-sm">
      <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">Business knowledge files</h3>
          <span className="text-xs text-slate-550">CSV, XLSX, PDF, DOCX or TXT · up to {AI_KNOWLEDGE_MAX_FILES_PER_UPLOAD} at a time</span>
          <button type="button" className="btn-primary ml-auto" disabled={uploadFiles.isPending} onClick={() => fileInput.current?.click()}>
            {uploadFiles.isPending ? "Reading…" : "Upload files"}
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length) uploadFiles.mutate({ files });
          }}
        />
        <input
          ref={replaceInput}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file && replacing) uploadFiles.mutate({ files: [file], replacesFileId: replacing });
            setReplacing(null);
          }}
        />
        <p className="mb-3 text-xs text-slate-550">
          Spreadsheets: one row per fact or Q&amp;A, with columns such as Topic / Product, Description / Answer, Question and Industry. Documents:
          headings become topics, paragraphs become facts. Everything starts as Draft; nothing reaches a call until it is approved and the agent
          is published. This agent's knowledge is only ever used in this agent's calls.
        </p>
        {uploadFiles.error && <ErrorNote error={uploadFiles.error} />}
        {(k.data?.files ?? []).length === 0 ? (
          <p className="text-slate-550">No files yet.</p>
        ) : (
          <ul className="divide-y divide-line/70 rounded-lg border border-line/70">
            {k.data!.files.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="font-medium">{f.fileName}</span>
                <Badge tone={f.status === "failed" ? "crit" : f.status === "replaced" ? "neutral" : "ok"}>{f.status}</Badge>
                <span className="text-xs text-slate-550">{f.itemCount} item(s)</span>
                {f.error && <span className={`text-xs ${f.status === "failed" ? "text-crit" : "text-slate-550"}`}>{f.error}</span>}
                {f.status !== "replaced" && (
                  <span className="ml-auto flex gap-2">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setReplacing(f.id);
                        replaceInput.current?.click();
                      }}
                    >
                      Replace
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={async () => {
                        if (await confirm({ title: `Remove ${f.fileName}?`, body: "Its items are removed too (approved ones included).", confirmText: "Remove" }))
                          removeFile.mutate(f.id);
                      }}
                    >
                      Remove
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">Extracted knowledge</h3>
          <span className="text-xs text-slate-550">
            {approved}/{AI_KNOWLEDGE_MAX_APPROVED} approved
          </span>
          <select className="input ml-auto w-auto" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="all">All ({items.length})</option>
            <option value="draft">To review ({items.filter((i) => i.status === "draft").length})</option>
            <option value="issues">With issues ({items.filter((i) => i.issues.length).length})</option>
            <option value="approved">Approved ({approved})</option>
            <option value="rejected">Rejected ({items.filter((i) => i.status === "rejected").length})</option>
          </select>
          <button type="button" className="btn btn-ghost" onClick={() => setEditing("new")}>
            Add item
          </button>
        </div>
        {picked.size > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-tint px-3 py-2">
            <span>{picked.size} selected</span>
            <button type="button" className="btn-primary" disabled={decide.isPending} onClick={() => decide.mutate("approved")}>
              Approve
            </button>
            <button type="button" className="btn btn-ghost" disabled={decide.isPending} onClick={() => decide.mutate("rejected")}>
              Reject
            </button>
            <button type="button" className="btn btn-ghost" disabled={decide.isPending} onClick={() => decide.mutate("draft")}>
              Back to draft
            </button>
          </div>
        )}
        {shown.length === 0 ? (
          <EmptyState title="Nothing here">Upload a file or add an item by hand.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-550">
                <tr>
                  <th className="w-8 py-2">
                    <input
                      type="checkbox"
                      aria-label="Select all shown"
                      checked={shown.every((i) => picked.has(i.id))}
                      onChange={(e) => setPicked(e.target.checked ? new Set(shown.map((i) => i.id)) : new Set())}
                    />
                  </th>
                  <th className="py-2">Topic</th>
                  <th className="py-2">Knowledge</th>
                  <th className="py-2">Source</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70">
                {shown.map((i) => (
                  <tr key={i.id} className="align-top">
                    <td className="py-2">
                      <input
                        type="checkbox"
                        aria-label={`Select ${i.topic}`}
                        checked={picked.has(i.id)}
                        onChange={(e) =>
                          setPicked((p) => {
                            const n = new Set(p);
                            if (e.target.checked) n.add(i.id);
                            else n.delete(i.id);
                            return n;
                          })
                        }
                      />
                    </td>
                    <td className="py-2 pr-3 font-medium">
                      {i.topic}
                      <div className="text-xs font-normal text-slate-550">{i.kind === "qa" ? "Q&A" : i.always ? "fact · every reply" : "fact"}</div>
                    </td>
                    <td className="py-2 pr-3">
                      {i.questions.length > 0 && <div className="text-xs text-slate-550">Q: {i.questions.join(" · ")}</div>}
                      <button type="button" className="text-left hover:underline" onClick={() => setEditing(i)}>
                        {i.text}
                      </button>
                      {i.industryHint && <div className="text-xs text-slate-550">Industry in the file: {i.industryHint}</div>}
                      {i.issues.map((x) => (
                        <div key={x} className="text-xs text-crit">
                          {x}
                        </div>
                      ))}
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-550">
                      {i.fileId ? fileName.get(i.fileId) : null}
                      {i.source && <div>{i.source}</div>}
                    </td>
                    <td className="py-2">
                      <Badge tone={STATUS_TONE[i.status]}>{i.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <ItemEditor agentId={agent.id} item={editing} onClose={() => setEditing(null)} onSaved={refresh} />
    </div>
  );
}

function ItemEditor({
  agentId,
  item,
  onClose,
  onSaved,
}: {
  agentId: string;
  item: AiKnowledgeItemView | "new" | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = item && item !== "new" ? item : null;
  const [kind, setKind] = useState<"fact" | "qa">(existing?.kind ?? "fact");
  const [topic, setTopic] = useState(existing?.topic ?? "");
  const [text, setText] = useState(existing?.text ?? "");
  const [questions, setQuestions] = useState((existing?.questions ?? []).join("\n"));
  const [always, setAlways] = useState(existing?.always ?? false);
  const [lastKey, setLastKey] = useState<string | null>(null);
  const key = existing ? existing.id : item === "new" ? "new" : null;
  if (key !== lastKey) {
    // A different item was opened: start from its values.
    setLastKey(key);
    setKind(existing?.kind ?? "fact");
    setTopic(existing?.topic ?? "");
    setText(existing?.text ?? "");
    setQuestions((existing?.questions ?? []).join("\n"));
    setAlways(existing?.always ?? false);
  }
  const qs = questions.split("\n").map((q) => q.trim()).filter(Boolean);
  const issues = [...knowledgeTextIssues(text), ...qs.flatMap((q) => knowledgeTextIssues(q, { policy: false }).map((x) => `question ${x}`))];
  const save = useMutation({
    mutationFn: () => {
      const json = { kind, topic: topic.trim(), text: text.trim(), questions: kind === "qa" ? qs : [], always: kind === "fact" && always };
      return existing
        ? api(`/api/ai-agents/${agentId}/knowledge/items/${existing.id}`, { method: "PATCH", json })
        : api(`/api/ai-agents/${agentId}/knowledge/items`, { method: "POST", json });
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/ai-agents/${agentId}/knowledge/items/${existing!.id}`, { method: "DELETE" }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  const ok = topic.trim() && text.trim() && (kind === "fact" || qs.length > 0);
  return (
    <Modal open={!!item} onClose={onClose} title={existing ? "Edit knowledge" : "Add knowledge"}>
      <div className="space-y-3 text-sm">
        <div className="flex gap-2">
          {(["fact", "qa"] as const).map((k) => (
            <button key={k} type="button" className={`btn ${kind === k ? "btn-primary" : "btn-ghost"}`} onClick={() => setKind(k)}>
              {k === "fact" ? "Fact" : "Question & answer"}
            </button>
          ))}
        </div>
        <div>
          <label className="label">Topic</label>
          <input className="input" maxLength={40} value={topic} onChange={(e) => setTopic(e.target.value)} />
        </div>
        {kind === "qa" && (
          <div>
            <label className="label">Ways a customer asks it (one per line)</label>
            <textarea className="input min-h-[60px]" value={questions} onChange={(e) => setQuestions(e.target.value)} />
          </div>
        )}
        <div>
          <label className="label">{kind === "qa" ? "Approved answer" : "Fact"} ({text.length}/{AI_KNOWLEDGE_TEXT_MAX})</label>
          <textarea className="input min-h-[90px]" maxLength={AI_KNOWLEDGE_TEXT_MAX} value={text} onChange={(e) => setText(e.target.value.replace(/\n/g, " "))} />
        </div>
        {kind === "fact" && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
            Include in every reply (for the main service introduction; keep these few)
          </label>
        )}
        {issues.map((x) => (
          <p key={x} className="text-xs text-crit">
            {x}
          </p>
        ))}
        {existing?.status === "approved" && <p className="text-xs text-warn">Saving a change puts it back to Draft: approve it again.</p>}
        {(save.error || remove.error) && <ErrorNote error={save.error ?? remove.error} />}
        <div className="flex justify-between gap-2">
          {existing ? (
            <button type="button" className="btn btn-danger" onClick={() => remove.mutate()}>
              Delete
            </button>
          ) : (
            <span />
          )}
          <button type="button" className="btn-primary" disabled={!ok || save.isPending} onClick={() => save.mutate()}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
