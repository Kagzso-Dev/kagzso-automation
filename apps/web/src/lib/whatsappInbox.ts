import type { ButtonReplyIntent } from "@dispatch/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { MediaView } from "./whatsappMedia";

/** How often the Inbox refreshes while the browser tab is visible (paused when hidden). */
export const INBOX_POLL_MS = 8000;

export interface Conversation {
  phone: string;
  name: string | null;
  lastMessageAt: string;
  lastPreview: string | null;
  lastType: string;
  inboundCount: number;
  windowOpen: boolean;
  unread: number;
}

export interface ConversationPage {
  items: Conversation[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ThreadMessage {
  id: string;
  direction: "in" | "out";
  at: string;
  type: string;
  text: string | null;
  media: MediaView | null;
  status: string | null;
  error: string | null;
  template: string | null;
  location?: { latitude: number; longitude: number; name: string | null; address: string | null } | null;
  /** Inbound quick-reply taps: which button it was (display only); null when unclear. */
  replyIntent?: ButtonReplyIntent | null;
}

export interface Thread {
  phone: string;
  name: string | null;
  windowOpen: boolean;
  windowEndsAt: string | null;
  messages: ThreadMessage[];
  hasMore: boolean;
  nextBefore: string | null;
}

/** Unread customer messages — the badge on the "WhatsApp Inbox" sidebar item (admins only). */
export function useInboxUnread(enabled: boolean) {
  return useQuery({
    queryKey: ["whatsapp-inbox-unread"],
    queryFn: () => api<{ messages: number; conversations: number }>("/api/whatsapp/inbox/unread-count"),
    enabled,
    refetchInterval: INBOX_POLL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
}
