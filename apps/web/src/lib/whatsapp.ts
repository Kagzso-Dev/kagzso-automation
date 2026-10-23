import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export interface WhatsAppConfig {
  configured: boolean;
  provider: string;
  phoneNumberId: string | null;
}

/** Whether the Meta WhatsApp Cloud API credentials are set — gates the send buttons. */
export function useWhatsAppConfig() {
  return useQuery({
    queryKey: ["whatsapp-config"],
    queryFn: () => api<WhatsAppConfig>("/api/whatsapp/config"),
    staleTime: 60_000,
  });
}

export const WHATSAPP_NOT_CONFIGURED_HINT =
  "Set up WhatsApp API in Settings to enable this.";

export type TemplateVerifyStatus = "verified" | "pending" | "failed" | "not_found" | "unchecked";

export interface TemplateVerification {
  id: string;
  status: TemplateVerifyStatus;
  metaStatus: string | null;
  reason: string;
  /** Meta header that a send would have to fill in (e.g. "IMAGE"); null when none is needed. */
  headerNeedsParameter: string | null;
}

export interface TemplateVerificationResult {
  checkedAt: string;
  error: string | null;
  items: TemplateVerification[];
}

const VERIFY_KEY = ["whatsapp-template-verify"];

/**
 * Meta verification of the registered templates (display only — it never blocks a
 * send). Loads once per page visit; the API caches Meta's list for ~5 minutes.
 * `refresh()` forces a re-read from Meta ("Verify with Meta") and also refreshes
 * the Sync from Meta lists, so one click updates both. `autoCheckMs` re-reads
 * while the page is open (read-only; 0 = off).
 */
export function useTemplateVerification(autoCheckMs = 0) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: VERIFY_KEY,
    queryFn: () => api<TemplateVerificationResult>("/api/whatsapp/templates/verify"),
    staleTime: 5 * 60_000,
    refetchInterval: autoCheckMs > 0 ? autoCheckMs : false,
  });
  const refresh = useMutation({
    mutationFn: () => api<TemplateVerificationResult>("/api/whatsapp/templates/verify?refresh=1"),
    onSuccess: (data) => {
      qc.setQueryData(VERIFY_KEY, data);
      void qc.invalidateQueries({ queryKey: ["whatsapp-meta-sync"] });
      void qc.invalidateQueries({ queryKey: ["whatsapp-meta-sync-updates"] });
    },
  });
  const byId = new Map((query.data?.items ?? []).map((v) => [v.id, v]));
  return { query, refresh, byId };
}

/* ------------------------------------------------------------ automatic Meta check */

export const AUTO_CHECK_OPTIONS = [0, 15, 30, 60] as const;
export const AUTO_CHECK_DEFAULT_MIN = 15;
const AUTO_CHECK_KEY = "whatsapp-templates-auto-check-min";

/**
 * How often the templates page re-reads Meta while it is open (minutes, 0 = off).
 * Read-only: it updates the "not in Kagzso yet" banner and the Meta badges, never
 * imports. Kept in this browser only.
 */
export function useAutoCheckMinutes(): [number, (min: number) => void] {
  const [min, setMin] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(AUTO_CHECK_KEY));
      return localStorage.getItem(AUTO_CHECK_KEY) !== null && (AUTO_CHECK_OPTIONS as readonly number[]).includes(v) ? v : AUTO_CHECK_DEFAULT_MIN;
    } catch {
      return AUTO_CHECK_DEFAULT_MIN;
    }
  });
  const set = (next: number) => {
    setMin(next);
    try {
      localStorage.setItem(AUTO_CHECK_KEY, String(next));
    } catch {
      /* private window — the choice lasts for this visit */
    }
  };
  return [min, set];
}

/* ------------------------------------------------------------ "Status changed" badge */

export interface SeenMetaStatus {
  /** Meta status ("APPROVED", "PAUSED" …) or "NOT_FOUND". */
  status: string;
  /** The status before the last change, when there was one. */
  prev?: string;
  changedAt?: string;
}

const SEEN_KEY = "whatsapp-template-meta-status";
/** A change stays flagged this long after it was seen. */
export const STATUS_CHANGE_SHOW_MS = 7 * 24 * 3600_000;

/** What a verification says about Meta, for change tracking; null = says nothing (couldn't check). */
export function seenStatusOf(v: TemplateVerification): string | null {
  if (v.status === "unchecked") return null;
  if (v.status === "not_found" || (v.status === "failed" && !v.metaStatus)) return "NOT_FOUND";
  return v.metaStatus || null;
}

/**
 * Pure: the next per-template snapshot. A template whose Meta status differs from
 * the one last seen keeps `prev` + `changedAt`; one seen for the first time is
 * just recorded (never flagged).
 */
export function trackMetaStatuses(
  seen: Record<string, SeenMetaStatus>,
  items: TemplateVerification[],
  now: Date,
): Record<string, SeenMetaStatus> {
  const next = { ...seen };
  for (const v of items) {
    const status = seenStatusOf(v);
    if (!status) continue;
    const before = seen[v.id];
    if (!before) next[v.id] = { status };
    else if (before.status !== status) next[v.id] = { status, prev: before.status, changedAt: now.toISOString() };
  }
  return next;
}

/** The recent change for a template, if any ("APPROVED" → "PAUSED"). */
export function recentStatusChange(s: SeenMetaStatus | undefined, now: Date): { from: string; to: string } | null {
  if (!s?.prev || !s.changedAt) return null;
  return now.getTime() - new Date(s.changedAt).getTime() <= STATUS_CHANGE_SHOW_MS ? { from: s.prev, to: s.status } : null;
}

/** Remembers (in this browser) the Meta status each template had, to flag changes. Display only. */
export function useMetaStatusChanges(result: TemplateVerificationResult | undefined) {
  const [seen, setSeen] = useState<Record<string, SeenMetaStatus>>(() => {
    try {
      return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, SeenMetaStatus>;
    } catch {
      return {};
    }
  });
  const checkedAt = result?.checkedAt;
  useEffect(() => {
    if (!result || result.error) return;
    setSeen((prev) => {
      const next = trackMetaStatuses(prev, result.items, new Date());
      try {
        localStorage.setItem(SEEN_KEY, JSON.stringify(next));
      } catch {
        /* not saved — still shown for this visit */
      }
      return next;
    });
  }, [checkedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  return (id: string) => recentStatusChange(seen[id], new Date());
}
