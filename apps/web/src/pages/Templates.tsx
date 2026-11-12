import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader } from "../components/Layout";
import { EmptyState, ErrorNote, Spinner } from "../components/ui";
import { useConfirm } from "../components/confirm";
import { Icon } from "../components/icons";

type TemplateKind = "LETTER" | "MEETING";

interface TemplateLink {
  label: string;
  url: string;
}

interface TemplateVideo {
  url: string;
  label?: string;
}

interface TemplateMeeting {
  title?: string;
  location?: string;
  joinUrl?: string;
  startAt?: string;
  endAt?: string;
  timezone?: string;
  description?: string;
}

interface Template {
  id: string;
  name: string;
  kind: TemplateKind;
  subject: string;
  bodyText?: string | null;
  signature?: string | null;
  htmlBody: string;
  textBody?: string | null;
  links?: TemplateLink[] | null;
  meeting?: TemplateMeeting | null;
  /** Legacy single fields — migrated into `images` / `videos` on first edit. */
  imageUrl?: string | null;
  videoUrl?: string | null;
  images?: string[] | null;
  videos?: TemplateVideo[] | null;
  variables: string[];
  _count?: { campaigns: number; triggers: number };
}

const BLANK = {
  name: "",
  kind: "LETTER" as TemplateKind,
  subject: "",
  bodyText: "Hi {{first_name}},\n\nYour message here.\n\n",
  signature: "Best regards,\nThe Team",
  textBody: "",
  links: [] as TemplateLink[],
  meeting: {} as TemplateMeeting,
  images: [] as string[],
  videos: [] as TemplateVideo[],
  variables: [] as string[],
};

/** Fallback for legacy templates stored only as HTML — show something editable. */
function htmlToPlain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function TemplatesPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["templates"],
    queryFn: () => api<{ items: Template[] }>("/api/templates"),
  });
  const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
  const isAdmin = useAuth().user?.role === "ADMIN"; // editors: view only

  const selected =
    selectedId === "new"
      ? { ...BLANK }
      : data?.items.find((t) => t.id === selectedId) ?? null;

  return (
    <div>
      <PageHeader
        title="Templates"
        action={
          isAdmin ? (
            <button className="btn-primary" onClick={() => setSelectedId("new")}>
              New template
            </button>
          ) : undefined
        }
      />
      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <div>
          {isLoading ? (
            <Spinner />
          ) : error ? (
            <ErrorNote error={error} />
          ) : data!.items.length === 0 ? (
            <EmptyState>No templates.</EmptyState>
          ) : (
            <ul className="flex flex-col gap-1">
              {data!.items.map((t) => (
                <li key={t.id}>
                  <button
                    className={`w-full rounded-lg px-3 py-2 text-left text-sm ${
                      selectedId === t.id ? "bg-accent-soft text-accent-ink" : "hover:bg-tint"
                    }`}
                    onClick={() => setSelectedId(t.id)}
                  >
                    <div className="flex items-center gap-1.5 font-medium">
                      <span className="truncate">{t.name}</span>
                      {t.kind === "MEETING" && (
                        <span className="shrink-0 rounded bg-accent-soft px-1 py-0.5 text-[10px] font-semibold uppercase text-accent-ink">
                          Meeting
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-slate-550">{t.subject}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {selected ? (
          <TemplateEditor
            key={selectedId}
            initial={selected}
            isNew={selectedId === "new"}
            readOnly={!isAdmin}
            onClose={() => setSelectedId(null)}
            onSaved={(id) => {
              qc.invalidateQueries({ queryKey: ["templates"] });
              setSelectedId(id);
            }}
            onDeleted={() => {
              qc.invalidateQueries({ queryKey: ["templates"] });
              setSelectedId(null);
            }}
          />
        ) : (
          <EmptyState>{isAdmin ? "Select a template or create a new one." : "Select a template to view it."}</EmptyState>
        )}
      </div>
    </div>
  );
}

function TemplateEditor({
  initial,
  isNew,
  readOnly = false,
  onClose,
  onSaved,
  onDeleted,
}: {
  initial: Partial<Template>;
  isNew: boolean;
  /** Editors: fields disabled; Save / Delete / Send test hidden. Preview still works. */
  readOnly?: boolean;
  onClose: () => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const [form, setForm] = useState({
    name: initial.name ?? "",
    kind: (initial.kind ?? "LETTER") as TemplateKind,
    subject: initial.subject ?? "",
    bodyText: initial.bodyText ?? (initial.htmlBody ? htmlToPlain(initial.htmlBody) : ""),
    signature: initial.signature ?? "",
    textBody: initial.textBody ?? "",
    links: (initial.links ?? []) as TemplateLink[],
    meeting: (initial.meeting ?? {}) as TemplateMeeting,
    // Legacy single image / video migrate into the lists on first edit.
    images: (initial.images ?? (initial.imageUrl ? [initial.imageUrl] : [])) as string[],
    videos: (initial.videos ??
      (initial.videoUrl ? [{ url: initial.videoUrl }] : [])) as TemplateVideo[],
    variables: [...(initial.variables ?? [])] as string[],
  });
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [testTo, setTestTo] = useState("");
  const [imageErrors, setImageErrors] = useState<Record<number, string>>({});
  const confirm = useConfirm();

  // De-duplicated, trimmed, non-empty — what actually gets saved / offered as chips.
  const variables = [...new Set(form.variables.map((s) => s.trim()).filter(Boolean))];
  const sampleVars = Object.fromEntries(variables.map((v) => [v, `«${v}»`]));

  const updateMeeting = (patch: Partial<TemplateMeeting>) =>
    setForm((f) => ({ ...f, meeting: { ...f.meeting, ...patch } }));

  const setImageAt = (i: number, url: string) =>
    setForm((f) => ({ ...f, images: f.images.map((x, j) => (j === i ? url : x)) }));
  const setVideoAt = (i: number, patch: Partial<TemplateVideo>) =>
    setForm((f) => ({ ...f, videos: f.videos.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  const clearImageError = (i: number) =>
    setImageErrors((e) => {
      const next = { ...e };
      delete next[i];
      return next;
    });

  const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

  const uploadImage = useMutation({
    mutationFn: async ({ file }: { file: File; index: number }) => {
      if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
        throw new Error("Unsupported image type — use JPG, PNG, WebP or GIF");
      }
      if (file.size > MAX_IMAGE_BYTES) {
        throw new Error("Image is too large — maximum size is 5 MB");
      }
      const fd = new FormData();
      fd.append("file", file);
      return api<{ url: string }>("/api/templates/uploads/image", {
        method: "POST",
        body: fd,
        notify: false,
      });
    },
    onSuccess: (res, { index }) => {
      clearImageError(index);
      setImageAt(index, res.url);
    },
    onError: (err, { index }) =>
      setImageErrors((e) => ({
        ...e,
        [index]: err instanceof Error ? err.message : "Upload failed — please try again",
      })),
  });

  const save = useMutation({
    mutationFn: async () => {
      const links = form.links
        .map((l) => ({ label: l.label.trim(), url: l.url.trim() }))
        .filter((l) => l.label && l.url);
      const meeting = Object.fromEntries(
        Object.entries(form.meeting).filter(([, v]) => v && String(v).trim()),
      );
      const images = form.images.map((u) => u.trim()).filter(Boolean);
      const videos = form.videos
        .map((v) => ({ url: v.url.trim(), label: v.label?.trim() || undefined }))
        .filter((v) => v.url);
      const body = {
        ...form,
        variables,
        links,
        meeting,
        images,
        videos,
        // The lists are canonical now — null out the legacy single fields so a
        // migrated value isn't rendered twice.
        imageUrl: null,
        videoUrl: null,
      };
      if (isNew) return api<Template>("/api/templates", { method: "POST", json: body });
      return api<Template>(`/api/templates/${initial.id}`, { method: "PUT", json: body });
    },
    onSuccess: (t) => onSaved(t.id),
  });

  const del = useMutation({
    mutationFn: () => api(`/api/templates/${initial.id}`, { method: "DELETE" }),
    onSuccess: onDeleted,
  });

  const doPreview = useMutation({
    mutationFn: () =>
      api<{ subject: string; html: string }>(`/api/templates/${initial.id}/preview`, {
        method: "POST",
        json: { variables: sampleVars },
        notify: false,
      }),
    onSuccess: setPreview,
  });

  const sendTest = useMutation({
    mutationFn: () =>
      api(`/api/templates/${initial.id}/send-test`, {
        method: "POST",
        json: { to: testTo, variables: sampleVars },
      }),
  });

  useEffect(() => setPreview(null), [initial.id]);

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="card">
        <div className="mb-3 flex items-center justify-between gap-4">
          <div className="text-sm font-semibold">{isNew ? "New template" : readOnly ? "View template" : "Edit template"}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-1.5 grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-tint hover:text-ink"
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        <fieldset disabled={readOnly} className="m-0 min-w-0 border-0 p-0">
        <label className="label">Name</label>
        <input
          className="input mb-3"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <label className="label">Type</label>
        <div className="mb-3 flex gap-1 rounded-lg bg-surface-muted p-1">
          {(["LETTER", "MEETING"] as TemplateKind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setForm((f) => ({ ...f, kind: k }))}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium ${
                form.kind === k ? "bg-white text-ink shadow-sm" : "text-slate-550 hover:text-ink"
              }`}
            >
              {k === "LETTER" ? "Letter" : "Meeting"}
            </button>
          ))}
        </div>
        <label className="label">Subject</label>
        <input
          className="input mb-3"
          value={form.subject}
          onChange={(e) => setForm({ ...form, subject: e.target.value })}
        />
        <label className="label">Declared variables (optional)</label>
        <p className="mb-2 text-xs text-slate-550">
          One per row. Declaring a variable makes it required at send time — a recipient with no
          value for it is skipped instead of getting a blank. Leave this empty to just use the
          built-in fields below.
        </p>
        <div className="mb-2 flex flex-col gap-2">
          {form.variables.map((name, i) => (
            <div key={i} className="flex gap-2">
              <input
                className="input font-mono text-xs"
                value={name}
                placeholder="order_id"
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    variables: f.variables.map((x, j) => (j === i ? e.target.value : x)),
                  }))
                }
              />
              <button
                type="button"
                aria-label="Remove variable"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-tint hover:text-crit"
                onClick={() =>
                  setForm((f) => ({ ...f, variables: f.variables.filter((_, j) => j !== i) }))
                }
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn-ghost mb-3 text-xs"
          onClick={() => setForm((f) => ({ ...f, variables: [...f.variables, ""] }))}
        >
          + Add variable
        </button>
        <label className="label">Insert a field into the message</label>
        <div className="mb-3 mt-1 flex flex-wrap gap-1">
          {[
            ...new Set([
              "first_name",
              "last_name",
              "email",
              "status",
              "unsubscribe_url",
              ...form.images.flatMap((u, i) =>
                u.trim() ? [i === 0 ? "image" : `image_${i + 1}`] : [],
              ),
              ...form.videos.flatMap((v, i) =>
                v.url.trim() ? [i === 0 ? "video_link" : `video_link_${i + 1}`] : [],
              ),
              ...variables,
            ]),
          ].map((v) => (
            <button
              key={v}
              type="button"
              className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-xs text-accent-ink"
              onClick={() => setForm((f) => ({ ...f, bodyText: f.bodyText + `{{${v}}}` }))}
            >
              {`{{${v}}}`}
            </button>
          ))}
        </div>
        <label className="label">Message</label>
        <p className="mb-1 text-xs text-slate-550">
          Write it as a normal letter. Blank lines start new paragraphs; use {"{{variable}}"} for
          personalised values.
        </p>
        <textarea
          className="input mb-3 h-56 text-sm"
          value={form.bodyText}
          onChange={(e) => setForm({ ...form, bodyText: e.target.value })}
          placeholder={"Hi {{first_name}},\n\nYour message here.\n"}
        />
        <label className="label">Closing / regards (optional)</label>
        <textarea
          className="input mb-3 h-20 text-sm"
          value={form.signature}
          onChange={(e) => setForm({ ...form, signature: e.target.value })}
          placeholder={"Best regards,\nThe Team"}
        />

        <div className="mb-3 border-t border-line pt-3">
          <label className="label">Images (optional)</label>
          <p className="mb-2 text-xs text-slate-550">
            Embedded in the email. Each image is placed at its own placeholder —{" "}
            <span className="font-mono">{"{{image}}"}</span>,{" "}
            <span className="font-mono">{"{{image_2}}"}</span>,{" "}
            <span className="font-mono">{"{{image_3}}"}</span> … — otherwise they come last, after the
            message, links and videos, in order. Paste a URL or upload (JPG, PNG, WebP, GIF · max 5 MB).
          </p>
          <div className="flex flex-col gap-2">
            {form.images.map((url, i) => (
              <div key={i} className="rounded-lg border border-line p-2">
                <div className="flex gap-2">
                  {url.trim() && (
                    <img
                      src={url}
                      alt=""
                      className="h-10 w-10 shrink-0 rounded border border-line object-cover"
                      onError={(e) => (e.currentTarget.style.opacity = "0.3")}
                    />
                  )}
                  <input
                    className="input font-mono text-xs"
                    value={url}
                    placeholder="https://…/photo.jpg"
                    onChange={(e) => setImageAt(i, e.target.value)}
                  />
                  <label className="btn-ghost shrink-0 cursor-pointer whitespace-nowrap text-xs">
                    {uploadImage.isPending ? "Uploading…" : "Upload"}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      className="hidden"
                      disabled={uploadImage.isPending}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          clearImageError(i);
                          uploadImage.mutate({ file, index: i });
                        }
                        e.currentTarget.value = "";
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    aria-label="Remove image"
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-tint hover:text-crit"
                    onClick={() => {
                      clearImageError(i);
                      setForm((f) => ({ ...f, images: f.images.filter((_, j) => j !== i) }));
                    }}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
                {imageErrors[i] && (
                  <div className="mt-1 text-xs text-crit">{imageErrors[i]}</div>
                )}
              </div>
            ))}
          </div>
          <button
            type="button"
            className="btn-ghost mt-2 text-xs"
            onClick={() => setForm((f) => ({ ...f, images: [...f.images, ""] }))}
          >
            + Add image
          </button>
        </div>

        <div className="mb-3 border-t border-line pt-3">
          <label className="label">Videos (optional)</label>
          <p className="mb-2 text-xs text-slate-550">
            A YouTube / Vimeo / any video link, rendered as a{" "}
            <span className="font-mono">▶ Watch video</span> button (email clients can’t embed a
            player). Placed at <span className="font-mono">{"{{video_link}}"}</span>,{" "}
            <span className="font-mono">{"{{video_link_2}}"}</span> … or after the message and links.
          </p>
          <div className="flex flex-col gap-2">
            {form.videos.map((v, i) => (
              <div key={i} className="flex gap-2">
                <input
                  className="input"
                  value={v.label ?? ""}
                  placeholder="Button label (optional)"
                  onChange={(e) => setVideoAt(i, { label: e.target.value })}
                />
                <input
                  className="input font-mono text-xs"
                  value={v.url}
                  placeholder="https://youtu.be/…"
                  onChange={(e) => setVideoAt(i, { url: e.target.value })}
                />
                <button
                  type="button"
                  aria-label="Remove video"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-tint hover:text-crit"
                  onClick={() =>
                    setForm((f) => ({ ...f, videos: f.videos.filter((_, j) => j !== i) }))
                  }
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="btn-ghost mt-2 text-xs"
            onClick={() => setForm((f) => ({ ...f, videos: [...f.videos, { url: "", label: "" }] }))}
          >
            + Add video
          </button>
        </div>

        <label className="label">Plain-text body (optional)</label>
        <p className="mb-1 text-xs text-slate-550">
          Overrides the auto-generated text version. Leave blank to derive it from the message
          above.
        </p>
        <textarea
          className="input mb-3 h-24 text-sm"
          value={form.textBody}
          onChange={(e) => setForm({ ...form, textBody: e.target.value })}
        />

        <div className="mb-3 border-t border-line pt-3">
          <label className="label">Links panel (optional)</label>
          <p className="mb-2 text-xs text-slate-550">
            Buttons shown after the message — a meeting link, an agenda, a booking page. URLs may
            contain {"{{variable}}"}.
          </p>
          <div className="flex flex-col gap-2">
            {form.links.map((lnk, i) => (
              <div key={i} className="flex gap-2">
                <input
                  className="input"
                  value={lnk.label}
                  placeholder="Label (e.g. Join the meeting)"
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      links: f.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                    }))
                  }
                />
                <input
                  className="input font-mono text-xs"
                  value={lnk.url}
                  placeholder="https://…"
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      links: f.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)),
                    }))
                  }
                />
                <button
                  type="button"
                  aria-label="Remove link"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-tint hover:text-crit"
                  onClick={() =>
                    setForm((f) => ({ ...f, links: f.links.filter((_, j) => j !== i) }))
                  }
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="btn-ghost mt-2 text-xs"
            onClick={() => setForm((f) => ({ ...f, links: [...f.links, { label: "", url: "" }] }))}
          >
            + Add link
          </button>
        </div>

        {form.kind === "MEETING" && (
          <div className="mb-3 border-t border-line pt-3">
            <label className="label">Meeting details</label>
            <p className="mb-2 text-xs text-slate-550">
              Rendered as a card with an “Add to Google Calendar” link and an{" "}
              <span className="font-mono">invite.ics</span> attachment. Date fields take an ISO
              date-time (2026-09-15T14:00) or a {"{{variable}}"}.
            </p>
            <input
              className="input mb-2"
              value={form.meeting.title ?? ""}
              placeholder="Title"
              onChange={(e) => updateMeeting({ title: e.target.value })}
            />
            <div className="mb-2 grid gap-2 sm:grid-cols-2">
              <input
                className="input font-mono text-xs"
                value={form.meeting.startAt ?? ""}
                placeholder="Start — 2026-09-15T14:00"
                onChange={(e) => updateMeeting({ startAt: e.target.value })}
              />
              <input
                className="input font-mono text-xs"
                value={form.meeting.endAt ?? ""}
                placeholder="End (optional)"
                onChange={(e) => updateMeeting({ endAt: e.target.value })}
              />
            </div>
            <input
              className="input mb-2"
              value={form.meeting.timezone ?? ""}
              placeholder="Timezone — e.g. America/New_York (optional)"
              onChange={(e) => updateMeeting({ timezone: e.target.value })}
            />
            <input
              className="input mb-2 font-mono text-xs"
              value={form.meeting.joinUrl ?? ""}
              placeholder="Join URL — https://meet.google.com/…"
              onChange={(e) => updateMeeting({ joinUrl: e.target.value })}
            />
            <input
              className="input mb-2"
              value={form.meeting.location ?? ""}
              placeholder="Location (optional)"
              onChange={(e) => updateMeeting({ location: e.target.value })}
            />
            <textarea
              className="input h-16 text-sm"
              value={form.meeting.description ?? ""}
              placeholder="Agenda / notes (optional)"
              onChange={(e) => updateMeeting({ description: e.target.value })}
            />
          </div>
        )}

        </fieldset>

        {save.error ? <ErrorNote error={save.error} /> : null}
        <div className="mt-2 flex flex-wrap gap-2">
          {!readOnly && (
            <button
              className="btn-primary"
              disabled={save.isPending || uploadImage.isPending}
              onClick={() => save.mutate()}
            >
              {uploadImage.isPending ? "Uploading image…" : isNew ? "Create" : "Save"}
            </button>
          )}
          {!isNew && (
            <>
              <button className="btn-ghost" onClick={() => doPreview.mutate()}>
                Preview
              </button>
              {!readOnly && (
              <button
                className="btn-danger"
                onClick={async () => {
                  const ok = await confirm({
                    title: "Delete this template?",
                    confirmText: "Delete",
                    tone: "danger",
                  });
                  if (ok) del.mutate();
                }}
              >
                Delete
              </button>
              )}
            </>
          )}
        </div>
        {del.error ? <div className="mt-2"><ErrorNote error={del.error} /></div> : null}

        {!isNew && !readOnly && (
          <div className="mt-4 border-t border-line pt-3">
            <label className="label">Send test to</label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                className="input"
                type="email"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder="you@example.com"
              />
              <button
                className="btn-ghost whitespace-nowrap"
                disabled={!testTo || sendTest.isPending}
                onClick={() => sendTest.mutate()}
              >
                Send test
              </button>
            </div>
            {sendTest.isSuccess && <div className="mt-1 text-xs text-ok">Test sent.</div>}
            {sendTest.error ? <div className="mt-1"><ErrorNote error={sendTest.error} /></div> : null}
          </div>
        )}
      </div>

      <div className="card">
        <div className="label">Preview</div>
        {doPreview.error ? (
          <ErrorNote error={doPreview.error} />
        ) : preview ? (
          <>
            <div className="mb-2 border-b border-line pb-2 text-sm font-medium">
              {preview.subject}
            </div>
            <iframe
              title="preview"
              className="h-[28rem] w-full rounded border border-line bg-white"
              srcDoc={preview.html}
            />
          </>
        ) : (
          <div className="text-sm text-slate-550">
            Save the template, then click Preview to render it with sample values.
          </div>
        )}
      </div>
    </div>
  );
}
