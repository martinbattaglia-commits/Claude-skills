import { contactEmail, LEGAL_LAST_UPDATED, operatorName } from "@/lib/legal/config";

export const metadata = { title: "Privacy Policy · Macrotide" };

// Render per request so the operator-configurable env values (OPERATOR_NAME,
// CONTACT_EMAIL) are read at runtime — a restart applies a change, no rebuild.
export const dynamic = "force-dynamic";

export default function PrivacyPage() {
  const email = contactEmail();
  const runBy = operatorName() ?? "a single individual";
  const operator = operatorName() ?? "the operator";

  return (
    <>
      <h1>Privacy Policy</h1>
      <p className="mt-prose-updated">Last updated: {LEGAL_LAST_UPDATED}</p>

      <h2>1. Who runs Macrotide</h2>
      <p>
        Macrotide is a small personal and experimental project operated by {runBy} on a single
        server. Your data lives in that operator&apos;s own database — there is no large company
        behind it. This policy explains, in plain language, what data is collected, where it goes,
        and the choices you have.
      </p>

      <h2>2. What we store</h2>
      <p>
        Account data and the content you create are stored in a SQLite database on the
        operator&apos;s server.
      </p>
      <ul>
        <li>
          <strong>Account:</strong> your name, email address, and the passkey (or, if enabled later,
          OAuth) identifiers you use to sign in. There is no email/password login, no magic links,
          and no marketing email.
        </li>
        <li>
          <strong>Your content:</strong> the portfolio, holdings, allocation plans, journal entries,
          and chat threads you create. This is scoped to your account.
        </li>
        <li>
          <strong>Usage:</strong> limited counters such as per-day AI token usage, used to enforce
          quotas.
        </li>
      </ul>

      <h2>3. Data isolation</h2>
      <p>
        Your records are scoped to your account and are not visible to other users. Built-in
        reference data (such as model portfolios) is shared and read-only.
      </p>

      <h2>4. Where your data goes (third parties)</h2>
      <p>
        Some features send data to third-party services to work. By using those features, your input
        is shared with the relevant provider:
      </p>
      <ul>
        <li>
          <strong>AI chat — OpenRouter and the LLM providers it routes to:</strong> the messages you
          send in chat are forwarded to OpenRouter and on to the third-party language model
          providers it routes to, so they can generate a response.
        </li>
        <li>
          <strong>Statement OCR — a vision model via OpenRouter:</strong> if you upload a statement
          image for transcription, that image is sent to a third-party vision model through
          OpenRouter to read the text from it.
        </li>
        <li>
          <strong>Market data — Yahoo Finance and the Thai SEC Open API:</strong> the app queries
          these for prices and fund data. These requests do not include your personal data.
        </li>
        <li>
          <strong>Cloudflare Turnstile:</strong> used at sign-up for bot protection.
        </li>
        <li>
          <strong>Google sign-in, if enabled:</strong> used only to authenticate you; the operator
          would receive your basic profile (name, email) from Google. OAuth is not enabled at
          launch.
        </li>
      </ul>
      <p>
        Each third-party provider handles data under its own terms and privacy policy. Please
        don&apos;t put anything highly sensitive into chat or uploaded images.
      </p>

      <h2>5. Demo mode</h2>
      <p>
        You can try Macrotide without an account using demo mode. Demo data is isolated, kept only
        in memory, and discarded when the session ends — it is not saved to the database.
      </p>

      <h2>6. Cookies</h2>
      <p>
        We use a session cookie to keep you signed in, and a separate cookie for demo mode. No
        third-party advertising or tracking cookies are set.
      </p>

      <h2>7. Your choices</h2>
      <p>
        You can stop using Macrotide at any time. To request deletion of your account and the data
        associated with it, contact {operator} (below). Because this is a single-operator
        deployment, the operator can remove your data directly from the database.
      </p>

      <h2>8. Security and honesty</h2>
      <p>
        Reasonable care is taken to protect your data, but this is a personal project on modest
        infrastructure and no system can be guaranteed secure. Macrotide is provided &quot;as
        is&quot; and may change or shut down at any time.
      </p>

      <h2>9. Changes</h2>
      <p>This policy may be updated; the date above will change accordingly.</p>

      <p className="mt-prose-contact">
        Privacy questions or a deletion request? Contact {operator}
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
