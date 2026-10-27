import type { ReactNode } from "react";
import { AI_CALL_LANGUAGE_NAMES } from "@dispatch/shared";
import { isEnglish, useLanguageReady } from "../lib/aiCallLanguage";

/**
 * On Tamil / Hindi / Kannada pages whose voice backend isn't set up yet: say so, and what turns it on.
 * Customers can already be added there; flows, voices and calls start working once the backend is up.
 * Nothing on English pages (English keeps its own messages, as before).
 */
export function AiCallLanguageNotice({ children }: { children?: ReactNode }) {
  const { language, ready } = useLanguageReady();
  if (ready || isEnglish(language)) return null;
  const name = AI_CALL_LANGUAGE_NAMES[language];
  return (
    <div className="mb-4 rounded-[14px] border border-warn-bright/30 bg-warn-soft p-3.5 text-sm">
      <div className="font-medium text-warn">The {name} voice backend isn't set up yet</div>
      <p className="mt-1 text-ink">
        {children ?? `${name} calls, voices and new flows start working once it is.`} Set it up on the server with{" "}
        <code className="font-mono text-xs">npm run voice:lang:init -- {language}</code> (it adds{" "}
        <code className="font-mono text-xs">VOICE_BACKEND_URL_{language.toUpperCase()}</code> to Dispatch's .env), then
        redeploy — see the README, "AI calls in more languages".
      </p>
    </div>
  );
}
