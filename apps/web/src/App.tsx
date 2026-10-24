import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/Login";
import { DashboardPage } from "./pages/Dashboard";
import { InsightsPage } from "./pages/Insights";
import { ContactsPage } from "./pages/Contacts";
import { WhatsAppContactsPage } from "./pages/WhatsAppContacts";
import { WhatsAppTemplatesPage } from "./pages/WhatsAppTemplates";
import { WhatsAppInboxPage } from "./pages/WhatsAppInbox";
import { ListsPage } from "./pages/Lists";
import { ListDetailPage } from "./pages/ListDetail";
import { TemplatesPage } from "./pages/Templates";
import { CallFlowsPage } from "./pages/CallFlows";
import { AiCallCustomersPage } from "./pages/AiCallCustomers";
import { CampaignsPage } from "./pages/Campaigns";
import { CampaignDetailPage } from "./pages/CampaignDetail";
import { SendQueuePage } from "./pages/SendQueue";
import { TriggersPage } from "./pages/Triggers";
import { SettingsPage } from "./pages/Settings";
import { DataQualityPage } from "./pages/DataQuality";
import { canSeePath } from "./lib/navAccess";
import type { ReactNode } from "react";

/** A page this role doesn't get (lib/navAccess): a typed-in URL goes to the Dashboard instead. */
function RoleRoute({ path, children }: { path: string; children: ReactNode }) {
  const { user } = useAuth();
  return canSeePath(path, user?.role) ? <>{children}</> : <Navigate to="/" replace />;
}

export function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="grid min-h-screen place-items-center text-sm text-slate-550">Loading…</div>;
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/data-quality" element={<RoleRoute path="/data-quality"><DataQualityPage /></RoleRoute>} />
        <Route path="/insights" element={<InsightsPage />} />
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/whatsapp-contacts" element={<WhatsAppContactsPage />} />
        <Route path="/whatsapp-templates" element={<RoleRoute path="/whatsapp-templates"><WhatsAppTemplatesPage /></RoleRoute>} />
        <Route path="/whatsapp-inbox" element={<WhatsAppInboxPage />} />
        <Route path="/lists" element={<ListsPage />} />
        <Route path="/lists/:id" element={<ListDetailPage />} />
        <Route path="/templates" element={<RoleRoute path="/templates"><TemplatesPage /></RoleRoute>} />
        <Route path="/ai-call-customers" element={<AiCallCustomersPage />} />
        <Route path="/call-flows" element={<RoleRoute path="/call-flows"><CallFlowsPage /></RoleRoute>} />
        <Route path="/campaigns" element={<CampaignsPage />} />
        <Route path="/campaigns/:id" element={<CampaignDetailPage />} />
        <Route path="/send-queue" element={<SendQueuePage />} />
        <Route path="/triggers" element={<TriggersPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
