import { PageHeader } from "../components/Layout";
import { AiCallCustomersPanel } from "../components/AiCallCustomersPanel";
import { EmptyState, Spinner } from "../components/ui";
import { useAiCallsConfig } from "../lib/aiCalls";
import { titleFor, useAiCallLanguage } from "../lib/aiCallLanguage";

/**
 * "AI Call Customers" (/ai-call-customers): its own page, separate from the
 * email Contacts and WhatsApp Contacts pages. Admins only, while ENABLE_AI_CALLS is on.
 * Another language has its own list on its own page (/ta/ai-call-customers, …).
 */
export function AiCallCustomersPage() {
  const config = useAiCallsConfig();
  const language = useAiCallLanguage();
  if (config.isLoading) return <Spinner />;
  if (!config.data?.enabled || !config.data.canStart) {
    return (
      <div>
        <PageHeader title={titleFor("Voicecall Contact", language)} />
        <EmptyState icon="phone" title="Not available">
          {!config.data?.enabled
            ? "AI calls are turned off. An admin can enable them with ENABLE_AI_CALLS."
            : "Only admins can manage AI call customers."}
        </EmptyState>
      </div>
    );
  }
  return <AiCallCustomersPanel config={config.data} />;
}
