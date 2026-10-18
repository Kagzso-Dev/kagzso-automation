import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useTemplateVerification } from "../lib/whatsapp";
import { useToast } from "./toast";
import { ErrorNote, Modal } from "./ui";

/** A recipient for a WhatsApp send. `id` is a whatsapp_contacts id or an email
 * contacts id depending on `source`. */
export interface WhatsAppRecipient {
  id: string;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  businessName?: string | null;
}

interface WhatsAppTemplate {
  id: string;
  name: string;
  /** Null until the Meta template name is set on the WhatsApp Templates page. */
  providerTemplateName: string | null;
  variables: string[];
  buttonLabels: string[];
  /** Archived on the WhatsApp Templates page — never offered here. */
  archived?: boolean;
  /** Header media set on the WhatsApp Templates page (needed when the Meta template has a media header). */
  headerMedia?: { kind: string } | null;
}

/**
 * "Send message" for one or more selected contacts. Confirming creates a
 * server-side paced drip batch (one message at a time with a random gap) and
 * hands off immediately — the modal closes and progress is tracked on the Send
 * Queue page, not here. Used by both the WhatsApp Contacts page and the email
 * Contacts page — the WhatsApp code path is identical for both.
 */
export function SendWhatsApp({
  recipients,
  source,
  onClose,
  onSelectionConsumed,
}: {
  recipients: WhatsAppRecipient[] | null;
  source: "whatsapp" | "contacts";
  onClose: () => void;
  onSelectionConsumed?: () => void;
}) {
  const open = !!recipients && recipients.length > 0;
  const count = recipients?.length ?? 0;

  return (
    <Modal open={open} onClose={onClose} title={`Send message to ${count} contact${count === 1 ? "" : "s"}`}>
      {open ? (
        <SendBody
          key={recipients!.map((r) => r.id).join(",")}
          recipients={recipients!}
          source={source}
          onClose={onClose}
          onSelectionConsumed={onSelectionConsumed}
        />
      ) : null}
    </Modal>
  );
}

function SendBody({
  recipients,
  source,
  onClose,
  onSelectionConsumed,
}: {
  recipients: WhatsAppRecipient[];
  source: "whatsapp" | "contacts";
  onClose: () => void;
  onSelectionConsumed?: () => void;
}) {
  const toast = useToast();
  const [templateId, setTemplateId] = useState("");
  const [purgeAfter, setPurgeAfter] = useState(false);

  const templates = useQuery({
    queryKey: ["whatsapp-templates"],
    queryFn: () => api<{ items: WhatsAppTemplate[] }>("/api/whatsapp/templates"),
  });
  // Only templates Meta reports as approved (badge "Verified") and that Dispatch can
  // actually send are offered here. Every row stays listed on the WhatsApp Templates page.
  const verification = useTemplateVerification().byId;
  const verified = (templates.data?.items ?? []).filter(
    (t) => !t.archived && t.providerTemplateName && verification.get(t.id)?.status === "verified",
  );
  // A media header (image / video / document) is sent from the file set on the WhatsApp
  // Templates page; until it is set — or for header types Dispatch can't fill — the template is blocked.
  const headerKind: Record<string, string> = { IMAGE: "image", VIDEO: "video", DOCUMENT: "document" };
  const headerProblem = (t: WhatsAppTemplate): string | null => {
    const needs = verification.get(t.id)?.headerNeedsParameter;
    if (!needs) return null;
    const kind = headerKind[needs];
    if (!kind) return `${needs.toLowerCase()} header not supported`;
    return t.headerMedia?.kind === kind ? null : `needs a header ${kind} (add it on the WhatsApp Templates page)`;
  };
  const blocked = verified.filter((t) => headerProblem(t));
  const sendable = verified.filter((t) => !headerProblem(t));

  const start = useMutation({
    mutationFn: () =>
      api<{ batchId: string }>("/api/whatsapp/send", {
        method: "POST",
        json: { templateId, contactIds: recipients.map((r) => r.id), source, purgeAfter },
        notify: false,
      }),
    onSuccess: () => {
      toast.success("WhatsApp send started", [
        "Track progress on the Send Queue page (WhatsApp tab).",
        ...(purgeAfter ? ["Contacts are deleted only once Meta confirms the message was delivered. Failed contacts are kept."] : []),
      ]);
      onSelectionConsumed?.();
      onClose();
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate();
      }}
    >
      <p className="mb-3 text-sm text-slate-550">
        Sends the selected template to all <b>{recipients.length}</b> selected contacts, one at a time
        with a random gap between each. Contacts with no valid phone number{" "}
        {source === "whatsapp" ? "or that aren't active " : ""}are skipped. Once you start, this window
        closes — follow the batch on the <b>Send Queue</b> page.
      </p>

      <label className="label">Template</label>
      <select
        className="input mb-3"
        value={templateId}
        onChange={(e) => setTemplateId(e.target.value)}
        disabled={start.isPending}
        required
      >
        <option value="">Select…</option>
        {sendable.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      {blocked.length > 0 && (
        <p className="-mt-2 mb-3 text-xs text-warn">
          Not available: {blocked.map((t) => `${t.name} — ${headerProblem(t)}`).join("; ")}.
        </p>
      )}
      {templates.data && templates.data.items.length === 0 && (
        <p className="mb-3 text-xs text-warn">
          No WhatsApp templates yet — create one on the WhatsApp Templates page first.
        </p>
      )}

      <label className="mb-3 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={purgeAfter}
          disabled={start.isPending}
          onChange={(e) => setPurgeAfter(e.target.checked)}
        />
        <span>
          Remove contacts the message reaches
          <span className="block text-xs text-slate-550">
            For lead-generation blasts — deletes a recipient only once Meta confirms the message was
            delivered. Failed, skipped or unconfirmed recipients are never deleted.
          </span>
        </span>
      </label>

      {start.error && <ErrorNote error={start.error} />}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-whatsapp" disabled={start.isPending || !templateId}>
          {start.isPending ? "Starting…" : `Start sending (${recipients.length})`}
        </button>
      </div>
    </form>
  );
}
