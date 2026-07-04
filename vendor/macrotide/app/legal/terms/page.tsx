import { contactEmail, jurisdiction, LEGAL_LAST_UPDATED, operatorName } from "@/lib/legal/config";

export const metadata = { title: "Terms of Service · Macrotide" };

// Render per request so the operator-configurable env values (OPERATOR_NAME,
// CONTACT_EMAIL, LEGAL_JURISDICTION) are read at runtime — a restart applies a
// change, no rebuild needed.
export const dynamic = "force-dynamic";

export default function TermsPage() {
  const email = contactEmail();
  const law = jurisdiction();
  const operator = operatorName() ?? "the operator";

  return (
    <>
      <h1>Terms of Service</h1>
      <p className="mt-prose-updated">Last updated: {LEGAL_LAST_UPDATED}</p>

      <div className="mt-prose-callout">
        <strong>Macrotide is not financial advice.</strong> It is an informational and educational
        companion only. Nothing here — including AI responses, scores, charts, or plan suggestions —
        is financial, investment, tax, or legal advice, and using Macrotide does not create any
        advisory or fiduciary relationship. You alone are responsible for your decisions.
      </div>

      <h2>1. What Macrotide is</h2>
      <p>
        Macrotide is an AI companion for Thai index investors. It helps you track holdings, plan
        allocations, keep a journal, and chat with an AI assistant about your situation. It is meant
        for personal, informational, and educational use.
      </p>
      <p>
        This is a small personal and experimental project run by {operator} on a single server. It
        is provided as a courtesy, with no guarantee of uptime, support, or continued availability.
        It may change, break, or be shut down at any time.
      </p>

      <h2>2. Not financial advice</h2>
      <p>
        Macrotide does not provide financial, investment, tax, or legal advice and is not a licensed
        adviser, broker, or fiduciary. Anything you see — including AI-generated responses, analysis
        scores, allocation plans, and market figures — is for general information only and may be
        delayed, incomplete, estimated, or simply wrong. Market data comes from third-party sources
        and is not guaranteed to be accurate or timely.
      </p>
      <p>
        You are solely responsible for your own investment decisions and their outcomes. Consider
        consulting a licensed professional before acting on anything you read here.
      </p>

      <h2>3. Your account</h2>
      <p>
        To save your data you sign in with a passkey (WebAuthn). Some sign-in providers may be added
        over time. You are responsible for keeping your sign-in methods and devices secure. An
        account is intended for one person — please don&apos;t share access. You can also explore
        the app in demo mode without an account; demo data is temporary and discarded.
      </p>

      <h2>4. Acceptable use</h2>
      <p>
        Please don&apos;t use Macrotide to break the law, upload other people&apos;s data without
        permission, abuse or overload the AI features (for example, trying to bypass rate limits or
        token quotas), attempt to access other users&apos; data, or otherwise disrupt the service.
        Access may be removed at any time, including for abuse.
      </p>

      <h2>5. AI and third-party services</h2>
      <p>
        Chat messages and any statement images you upload for transcription are sent to OpenRouter
        and the third-party language and vision model providers it routes to, in order to generate
        responses. Don&apos;t paste anything you wouldn&apos;t want processed by those providers.
        Availability, models, and limits may change at any time. See the{" "}
        <a href="/legal/privacy">Privacy Policy</a> for how data is handled.
      </p>

      <h2>6. No warranty and limit of liability</h2>
      <p>
        Macrotide is provided &quot;as is&quot; and &quot;as available&quot;, without warranty of
        any kind, express or implied. To the maximum extent permitted by law, the operator is not
        liable for any loss or damage arising from your use of Macrotide — including investment
        losses, lost profits, data loss, or service interruptions.
      </p>

      <h2>7. Changes</h2>
      <p>
        These terms may be updated from time to time. The date above will change when they do, and
        continued use after a change means you accept the revised terms.
      </p>

      {law && (
        <>
          <h2>8. Governing law</h2>
          <p>These terms are governed by the laws of {law}.</p>
        </>
      )}

      <p className="mt-prose-contact">
        Questions about these terms? Contact {operator}
        {email ? (
          <>
            {" "}
            at <a href={`mailto:${email}`}>{email}</a>
          </>
        ) : null}
        .
      </p>
    </>
  );
}
