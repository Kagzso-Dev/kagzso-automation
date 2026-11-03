import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AiIndustryView } from "@dispatch/shared";
import { api } from "../lib/api";
import { useAiLibrary } from "../lib/aiAgents";
import { Badge, ErrorNote, Spinner } from "./ui";

/**
 * Settings → AI agent industries (admins): one category / industry library shared by every language's AI agents.
 * Discovery topics are what the agent may ask a business of that industry about - never claims that a product
 * supports them (only approved knowledge says what the company offers).
 */
export function IndustryLibrarySection() {
  const qc = useQueryClient();
  const lib = useAiLibrary(true);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["ai-agent-library"] });
  const [category, setCategory] = useState("");
  const [industry, setIndustry] = useState({ categoryId: "", name: "", discoveryTopics: "" });
  const [editing, setEditing] = useState<AiIndustryView | null>(null);

  const addCategory = useMutation({
    mutationFn: () => api("/api/ai-agents/library/categories", { method: "POST", json: { name: category.trim() } }),
    onSuccess: () => {
      setCategory("");
      refresh();
    },
  });
  const addIndustry = useMutation({
    mutationFn: () => api("/api/ai-agents/library/industries", { method: "POST", json: { ...industry, name: industry.name.trim() } }),
    onSuccess: () => {
      setIndustry({ categoryId: industry.categoryId, name: "", discoveryTopics: "" });
      refresh();
    },
  });
  const patch = useMutation({
    mutationFn: ({ kind, id, data }: { kind: "categories" | "industries"; id: string; data: Record<string, unknown> }) =>
      api(`/api/ai-agents/library/${kind}/${id}`, { method: "PATCH", json: data }),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
  });

  return (
    <section className="settings-section">
      <h2 className="settings-heading">AI agent industries</h2>
      <div className="settings-card space-y-3 text-sm">
        <p className="text-slate-550">
          One library for every language. Discovery topics (one per line) are things an AI agent may ask a business of that industry about — they
          are not claims about what the company offers.
        </p>
        {lib.isLoading ? (
          <Spinner />
        ) : lib.error ? (
          <ErrorNote error={lib.error} />
        ) : (
          <ul className="divide-y divide-line/70 rounded-lg border border-line/70">
            {lib.data!.map((c) => (
              <li key={c.id} className="px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{c.name}</span>
                  {c.archivedAt && <Badge tone="neutral">archived</Badge>}
                  <button
                    type="button"
                    className="ml-auto text-xs text-accent-ink hover:underline"
                    onClick={() => patch.mutate({ kind: "categories", id: c.id, data: { archived: !c.archivedAt } })}
                  >
                    {c.archivedAt ? "Restore" : "Archive"}
                  </button>
                </div>
                <ul className="mt-1 space-y-1 pl-3">
                  {c.industries.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-baseline gap-2">
                      <span>{i.name}</span>
                      {i.archivedAt && <Badge tone="neutral">archived</Badge>}
                      <span className="truncate text-xs text-slate-550">{i.discoveryTopics.split("\n").filter(Boolean).join(" · ")}</span>
                      <span className="ml-auto flex gap-3 text-xs">
                        <button type="button" className="text-accent-ink hover:underline" onClick={() => setEditing(i)}>
                          Edit topics
                        </button>
                        <button
                          type="button"
                          className="text-accent-ink hover:underline"
                          onClick={() => patch.mutate({ kind: "industries", id: i.id, data: { archived: !i.archivedAt } })}
                        >
                          {i.archivedAt ? "Restore" : "Archive"}
                        </button>
                      </span>
                      {editing?.id === i.id && (
                        <div className="w-full space-y-2">
                          <textarea
                            className="input min-h-[80px]"
                            maxLength={1500}
                            value={editing.discoveryTopics}
                            onChange={(e) => setEditing({ ...editing, discoveryTopics: e.target.value })}
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              className="btn-primary"
                              onClick={() => patch.mutate({ kind: "industries", id: i.id, data: { discoveryTopics: editing.discoveryTopics } })}
                            >
                              Save
                            </button>
                            <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <label className="label">New category</label>
            <div className="flex gap-2">
              <input className="input" maxLength={80} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Retail" />
              <button type="button" className="btn btn-ghost" disabled={!category.trim() || addCategory.isPending} onClick={() => addCategory.mutate()}>
                Add
              </button>
            </div>
          </div>
          <div className="space-y-2">
            <label className="label">New industry</label>
            <select className="input" value={industry.categoryId} onChange={(e) => setIndustry({ ...industry, categoryId: e.target.value })}>
              <option value="">Category…</option>
              {(lib.data ?? []).filter((c) => !c.archivedAt).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input className="input" maxLength={80} value={industry.name} onChange={(e) => setIndustry({ ...industry, name: e.target.value })} placeholder="Industry name" />
            <textarea
              className="input min-h-[60px]"
              maxLength={1500}
              value={industry.discoveryTopics}
              onChange={(e) => setIndustry({ ...industry, discoveryTopics: e.target.value })}
              placeholder="Discovery topics, one per line"
            />
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!industry.categoryId || !industry.name.trim() || addIndustry.isPending}
              onClick={() => addIndustry.mutate()}
            >
              Add industry
            </button>
          </div>
        </div>
        {(addCategory.error || addIndustry.error || patch.error) && <ErrorNote error={addCategory.error ?? addIndustry.error ?? patch.error} />}
      </div>
    </section>
  );
}
