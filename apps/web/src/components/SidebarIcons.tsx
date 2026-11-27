import type { ReactNode } from "react";
import {
  LayoutDashboard,
  ShieldCheck,
  FileText,
  MessageSquareText,
  Inbox,
  Phone,
  Workflow,
  Bot,
  Send,
  History,
  Cpu,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";

// Sidebar menu icons: a 22x22 coloured rounded square with a white 14px mark inside (same look as the
// LinkedIn / Instagram Automation marks). Looked up by the menu item's label in Layout; any label not listed
// here keeps its icon from components/icons.tsx.

const Badge = ({ color, children }: { color: string; children: ReactNode }) => (
  <span
    aria-hidden="true"
    style={{ background: color, width: 22, height: 22, borderRadius: 6, display: "inline-grid", placeItems: "center", flexShrink: 0 }}
  >
    {children}
  </span>
);

const L = (Icon: LucideIcon, color: string) => () => (
  <Badge color={color}>
    <Icon size={14} color="#fff" strokeWidth={2} />
  </Badge>
);

const Gmail = () => (
  <Badge color="#EA4335">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff">
      <path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z" />
    </svg>
  </Badge>
);

const WhatsApp = () => (
  <Badge color="#25D366">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
    </svg>
  </Badge>
);

export const sidebarIcons: Record<string, () => JSX.Element> = {
  "Dashboard": L(LayoutDashboard, "#4F46E5"),
  "Data Quality": L(ShieldCheck, "#059669"),
  "Email Contacts": Gmail,
  "Email Templates": L(FileText, "#F97316"),
  "WhatsApp Contacts": WhatsApp,
  "WhatsApp Templates": L(MessageSquareText, "#128C7E"),
  "WhatsApp Inbox": L(Inbox, "#075E54"),
  "Voicecall Contact": L(Phone, "#0891B2"),
  "Voice Call Flows": L(Workflow, "#0284C7"),
  "AI Agents": L(Bot, "#7C3AED"),
  "Send Queue": L(Send, "#0EA5E9"),
  "Upload History": L(History, "#9333EA"),
  "AI Providers": L(Cpu, "#DB2777"),
  "Settings": L(SlidersHorizontal, "#475569"),
};
