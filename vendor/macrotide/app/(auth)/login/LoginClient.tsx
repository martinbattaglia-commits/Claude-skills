"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { PasskeyIcon, ProviderIcon } from "@/components/ProviderIcon";
import { clearDemoSession } from "@/lib/auth/clear-demo";
import { authClient, signIn, useSession } from "@/lib/auth/client";
import { placeholderEmail } from "@/lib/auth/placeholder-email";
import { Turnstile } from "./Turnstile";
// Pull in the marketing tokens (warm `--bg`, `--line`, radii) so the login card
// sits on the same ground as the landing. Scoped to `.mt-landing-root`, applied
// on the shell below — see `shell`.
import "@/components/landing.css";

// Brand lockup — the mark + wordmark, matching the landing header (BrandMark +
// "Macrotide"). On the main login screen it's a link home (`asLink`); on the
// mandatory passkey step it's static so a click can't abandon a half-created
// account.
function BrandLockup({ asLink }: { asLink: boolean }) {
  const inner = (
    <>
      <BrandMark size={26} />
      <span style={wordmark}>Macrotide</span>
    </>
  );
  return asLink ? (
    <a href="/" style={brandLockup} aria-label="Macrotide — home">
      {inner}
    </a>
  ) : (
    <div style={brandLockup}>{inner}</div>
  );
}

type Mode = "intro" | "signup";

interface AuthConfig {
  providers: { google: boolean };
  turnstile: { enabled: boolean; siteKey: string | null };
}

// Map WebAuthn ceremony failures to friendly copy. Returns null for anything
// that isn't a recognized passkey error, so callers fall back to the original
// message (e.g. a real "email already registered" signup error). A cancelled
// prompt surfaces a raw DOMException ("The operation either timed out or was
// not allowed…") which we never want to show verbatim.
function passkeyErrorMessage(e: unknown): string | null {
  const name = e instanceof Error ? e.name : "";
  // User dismissed the OS/browser prompt, or it timed out — an intent, not a bug.
  if (name === "NotAllowedError" || name === "AbortError") {
    return "Passkey prompt was cancelled or timed out — please try again.";
  }
  // The authenticator already holds a passkey for this account.
  if (name === "InvalidStateError") {
    return "A passkey already exists for this account on this device.";
  }
  return null;
}

// Map a better-auth OAuth `?error=<code>` redirect to friendly copy. The codes
// come from the OAuth callback when a social sign-in can't complete — e.g.
// `account_not_linked` when the provider's email is unverified, or when the
// address already belongs to an account that can't be auto-merged. We never
// silently merge into a mismatched account (that's the #98 pre-registration
// takeover guard), so on these we steer the user to their other sign-in method
// rather than guessing which one. Method-agnostic copy: under the passkey/OAuth
// model the existing account could use either method.
function oauthErrorMessage(code: string | null): string | null {
  if (!code) return null;
  switch (code) {
    case "account_not_linked":
    case "unable_to_link_account":
    case "email_doesn't_match":
      return "We couldn't sign you in with that provider. If you already have an account, sign in with your original method, then link this provider from Account settings.";
    default:
      return "Sign-in didn't complete. Please try again.";
  }
}

// useSearchParams requires a Suspense boundary in Next 15 app router.
export default function LoginClient() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}

// localStorage flag: once the user dismisses the post-OAuth "add a passkey"
// offer, don't nag them again on this device.
const PASSKEY_PROMPT_DISMISSED = "mt_passkey_prompt_dismissed";

function LoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  // Reactive passkey list — used to skip the post-OAuth passkey offer for users
  // who already have one.
  const passkeyState = authClient.useListPasskeys();
  const [mode, setMode] = useState<Mode>("intro");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // Demo-specific loading, so the "Explore the demo" label doesn't flip to
  // "Loading the demo…" when another action (Google, passkey) sets `busy`.
  const [demoLoading, setDemoLoading] = useState(false);
  // Set after email signup creates the account+session but before its passkey
  // exists. Blocks the redirect-on-session effect (the account is unusable
  // without a passkey — random password, no OAuth) so a cancelled WebAuthn
  // prompt lands on a mandatory retry screen, not the dashboard.
  const [pendingPasskey, setPendingPasskey] = useState(false);
  // Per-field validation messages for the signup form, shown inline under each
  // input on submit and cleared as the user edits that field.
  const [fieldErrors, setFieldErrors] = useState<{
    name?: string;
    turnstile?: string;
  }>({});
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  // Decision for the optional post-OAuth passkey offer: false until the effect
  // below confirms the user has no passkey and hasn't dismissed it. Keeps the
  // localStorage read out of render (hydration-safe) and avoids flashing the
  // offer to users who'll be skipped past it.
  const [showOptionalOffer, setShowOptionalOffer] = useState(false);

  // After OAuth sign-in we redirect back to /login?passkey=prompt to offer
  // registering a passkey on this device. Detect that here.
  const passkeyPrompt = searchParams.get("passkey") === "prompt";

  // A refused OAuth sign-in lands back here as `?error=<code>` (see
  // signInSocial's errorCallbackURL). Surface friendly copy once on mount.
  const oauthErrorCode = searchParams.get("error");
  useEffect(() => {
    const msg = oauthErrorMessage(oauthErrorCode);
    if (msg) setError(msg);
  }, [oauthErrorCode]);

  // Load which providers + bot-protection the server has configured.
  useEffect(() => {
    fetch("/api/auth-config")
      .then((r) => (r.ok ? r.json() : null))
      .then((c: AuthConfig | null) => c && setConfig(c))
      .catch(() => {});
  }, []);

  // Already signed in? Skip the login screen — unless we're prompting for a
  // passkey after a fresh OAuth sign-in. Skip while `busy`: during account
  // creation, signUp.email() auto-signs-in and flips `session` before the
  // following addPasskey() can run, so a redirect here would preempt the
  // WebAuthn prompt. The active handler does its own redirect once done.
  useEffect(() => {
    if (session?.user && !passkeyPrompt && !pendingPasskey && !busy) {
      // Drop any stale demo session before bouncing into the dashboard so a
      // returning demo-then-login user doesn't carry the cookie. Best-effort.
      clearDemoSession();
      router.replace("/");
    }
  }, [session, router, passkeyPrompt, pendingPasskey, busy]);

  // Post-OAuth passkey offer: show it only when the user has NO passkey yet and
  // hasn't dismissed it before — otherwise it nags on every OAuth sign-in. Skip
  // straight into the app in those cases. (pendingPasskey is the mandatory
  // post-signup path and is never skipped here.)
  useEffect(() => {
    if (!passkeyPrompt || pendingPasskey || !session?.user || busy) return;
    if (passkeyState.isPending) return; // wait for the list before deciding
    const hasPasskey = (passkeyState.data?.length ?? 0) > 0;
    const dismissed =
      typeof window !== "undefined" &&
      window.localStorage.getItem(PASSKEY_PROMPT_DISMISSED) === "1";
    if (hasPasskey || dismissed) {
      clearDemoSession();
      router.replace("/");
    } else {
      setShowOptionalOffer(true);
    }
  }, [
    passkeyPrompt,
    pendingPasskey,
    session,
    busy,
    passkeyState.isPending,
    passkeyState.data,
    router,
  ]);

  // Header sent on the email account-creation POST so the server-side Turnstile
  // gate can verify it. Empty when Turnstile isn't configured (dev bypass).
  function turnstileHeaders(): Record<string, string> {
    return turnstileToken ? { "x-turnstile-token": turnstileToken } : {};
  }

  async function continueToApp() {
    await clearDemoSession();
    router.replace("/");
  }

  // "Skip for now" on the optional post-OAuth passkey offer: remember the
  // dismissal so it doesn't reappear on the next OAuth sign-in.
  async function dismissPasskeyPrompt() {
    try {
      window.localStorage.setItem(PASSKEY_PROMPT_DISMISSED, "1");
    } catch {
      // localStorage unavailable (private mode / blocked) — proceed anyway.
    }
    await continueToApp();
  }

  async function signInSocial(provider: "google") {
    setBusy(true);
    setError(null);
    try {
      const result = await signIn.social({
        provider,
        callbackURL: "/login?passkey=prompt",
        // If better-auth refuses the sign-in (e.g. the email already belongs to
        // an account created a different way, so it can't be auto-linked), it
        // redirects here with `?error=<code>` instead of better-auth's bare
        // error page. We translate the code to friendly copy below.
        errorCallbackURL: "/login",
      });
      if (result?.error) throw new Error(result.error.message ?? "sign in failed");
      // signIn.social triggers a redirect to the provider; nothing more to do.
    } catch (e) {
      setError(e instanceof Error ? e.message : "sign in failed");
      setBusy(false);
    }
  }

  async function addPasskeyAndContinue() {
    setBusy(true);
    setError(null);
    try {
      const addPk = await authClient.passkey.addPasskey({
        // WebAuthn user.name — the account identifier password managers display.
        // Use the person's name (matching signup); fall back to email.
        name: session?.user?.name ?? session?.user?.email ?? "Passkey",
      });
      if (addPk?.error) throw new Error(addPk.error.message ?? "passkey registration failed");
      setPendingPasskey(false);
      await continueToApp();
    } catch (e) {
      setError(
        passkeyErrorMessage(e) ?? (e instanceof Error ? e.message : "passkey registration failed"),
      );
      setBusy(false);
    }
  }

  async function startDemo() {
    setBusy(true);
    setDemoLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/demo", { method: "POST" });
      if (!res.ok) throw new Error("demo start failed");
      router.replace("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "demo start failed");
      setBusy(false);
      setDemoLoading(false);
    }
  }

  async function signInPasskey() {
    setBusy(true);
    setError(null);
    try {
      const result = await signIn.passkey();
      if (result?.error) throw new Error(result.error.message ?? "sign in failed");
      await continueToApp();
    } catch (e) {
      setError(passkeyErrorMessage(e) ?? (e instanceof Error ? e.message : "sign in failed"));
      setBusy(false);
    }
  }

  async function createAccountWithPasskey(e: React.FormEvent) {
    e.preventDefault();
    // Inline validation: surface exactly what's missing/invalid per field rather
    // than leaving the user at an inert button.
    const errs: typeof fieldErrors = {};
    if (!name.trim()) errs.name = "Enter your name";
    if (!turnstileSatisfied) errs.turnstile = "Complete the verification first";
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    setBusy(true);
    setError(null);
    try {
      // Step 1: create the user record. Passkey signup collects only a name, so
      // we mint a synthetic, non-deliverable placeholder email (the `user` row
      // requires a unique address — see lib/auth/placeholder-email). It's hidden
      // in the UI and gets replaced by a real verified address if the user later
      // links an OAuth provider. (addPasskey() needs a session, hence this
      // bootstrap first.)
      const signUp = await authClient.signUp.email({
        email: placeholderEmail(),
        name,
        // better-auth requires a password even though no password sign-in UI is
        // exposed. Generate a random one the user never sees.
        password: crypto.randomUUID() + crypto.randomUUID(),
        // Carry the Turnstile token so the server-side signup gate can verify
        // it. Bypassed server-side when Turnstile isn't configured.
        fetchOptions: { headers: turnstileHeaders() },
      });
      if (signUp?.error) throw new Error(signUp.error.message ?? "sign up failed");

      // The account + session now exist but there's no passkey yet — and no
      // password the user knows. Mark it pending so a cancelled WebAuthn prompt
      // can't slip into the dashboard via the redirect-on-session effect.
      setPendingPasskey(true);

      // Step 2: prompt the browser to create a passkey now that we have a
      // session cookie. Label it with the person's name (the placeholder email
      // must never surface in the authenticator / password manager).
      const addPk = await authClient.passkey.addPasskey({
        name,
      });
      if (addPk?.error) throw new Error(addPk.error.message ?? "passkey registration failed");

      setPendingPasskey(false);
      await continueToApp();
    } catch (err) {
      // Leave pendingPasskey set on failure: the account exists but has no
      // passkey, so we stay on the (mandatory) retry screen rather than redirect.
      // A cancelled WebAuthn prompt maps to friendly copy; a real signup error
      // (e.g. duplicate email) falls through to its own message.
      setError(passkeyErrorMessage(err) ?? (err instanceof Error ? err.message : "sign up failed"));
      setBusy(false);
    }
  }

  const hasOAuth = Boolean(config?.providers.google);
  // Turnstile must be solved before email account-creation when it's
  // configured. In dev (not configured) this is always satisfied.
  const turnstileSatisfied = !config?.turnstile.enabled || Boolean(turnstileToken);

  // While deciding whether to show the optional post-OAuth offer (passkey list
  // still loading, or about to redirect a user who already has one), render a
  // quiet shell rather than flashing the offer or the logged-out login screen.
  if (passkeyPrompt && !pendingPasskey && session?.user && !showOptionalOffer) {
    return <div className="mt-landing-root" style={shell} />;
  }

  // Passkey registration prompt. Two cases:
  //  - Post-OAuth: optional convenience — only shown when the user has no
  //    passkey yet and hasn't dismissed it (see showOptionalOffer); offers
  //    "Skip for now".
  //  - Post-email-signup (pendingPasskey): MANDATORY — the account has no
  //    password and no OAuth, so a passkey is the only way back in. No skip;
  //    a cancelled prompt stays here to retry.
  if ((showOptionalOffer || pendingPasskey) && session?.user) {
    return (
      <div className="mt-landing-root" style={shell}>
        <div style={card}>
          <BrandLockup asLink={false} />
          <div style={tagline}>
            {pendingPasskey
              ? "Almost done — create a passkey to finish setting up your account. It's how you'll sign in."
              : "You're signed in. Add a passkey to this device for faster sign-in next time?"}
          </div>
          <button type="button" style={primary} onClick={addPasskeyAndContinue} disabled={busy}>
            {busy ? "Setting up…" : pendingPasskey ? "Create passkey" : "Add a passkey"}
          </button>
          {!pendingPasskey && (
            <button type="button" style={ghost} onClick={dismissPasskeyPrompt} disabled={busy}>
              Skip for now
            </button>
          )}
          {error && <div style={errBanner}>{error}</div>}
          {pendingPasskey && !error && (
            <div style={footer}>A passkey is required to access your account.</div>
          )}
          <div style={footer}>Open source · Self-hosted</div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-landing-root" style={shell}>
      <div style={card}>
        <BrandLockup asLink={true} />
        <div style={tagline}>
          {mode === "intro" ? (
            <>
              An honest mirror for your index portfolio. Track holdings, watch fees, ask the
              Advisor.
            </>
          ) : (
            <>Create your account — we'll set up a passkey on this device.</>
          )}
        </div>

        {mode === "intro" && (
          <>
            {/* Two peer sign-in methods, each as a "Continue with…" button with
                its icon. Google only shows when configured. "Create account" (the
                name-only passkey signup) sits below as a text link; the demo is a
                ghost action under a divider. */}
            {hasOAuth && (
              <button
                type="button"
                style={methodBtn}
                onClick={() => signInSocial("google")}
                disabled={busy}
              >
                <ProviderIcon id="google" size={18} />
                Continue with Google
              </button>
            )}
            <button type="button" style={methodBtn} onClick={signInPasskey} disabled={busy}>
              <PasskeyIcon size={21} color="var(--ink)" />
              Continue with passkey
            </button>
            <button
              type="button"
              style={textLink}
              onClick={() => setMode("signup")}
              disabled={busy}
            >
              Create account
            </button>
            <div style={rule} />
            <button type="button" style={demoBtn} onClick={startDemo} disabled={busy}>
              {demoLoading ? "Loading the demo…" : "Explore the demo"}
            </button>
            <div style={hint}>
              Demo data lives only in your browser session — nothing is saved to a real account. The
              Advisor is limited to 10 messages in demo mode.
            </div>
          </>
        )}

        {mode === "signup" && (
          <form onSubmit={createAccountWithPasskey} style={{ width: "100%" }} noValidate>
            <input
              type="text"
              autoComplete="name"
              placeholder="Your name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (fieldErrors.name) setFieldErrors((f) => ({ ...f, name: undefined }));
              }}
              aria-invalid={Boolean(fieldErrors.name)}
              style={input}
            />
            {fieldErrors.name && <div style={fieldError}>{fieldErrors.name}</div>}
            {config?.turnstile.enabled && config.turnstile.siteKey && (
              <div style={{ margin: "8px 0" }}>
                <Turnstile
                  siteKey={config.turnstile.siteKey}
                  onToken={(t) => {
                    setTurnstileToken(t);
                    if (fieldErrors.turnstile)
                      setFieldErrors((f) => ({ ...f, turnstile: undefined }));
                  }}
                />
              </div>
            )}
            {fieldErrors.turnstile && <div style={fieldError}>{fieldErrors.turnstile}</div>}
            <button
              type="submit"
              style={{
                ...primary,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 9,
              }}
              disabled={busy}
            >
              {busy ? (
                "Setting up…"
              ) : (
                <>
                  <PasskeyIcon size={18} color="currentColor" />
                  Create passkey and continue
                </>
              )}
            </button>
            <p style={consentNote}>
              By continuing, you agree to the{" "}
              <a href="/legal/terms" target="_blank" rel="noreferrer" style={legalLink}>
                Terms
              </a>{" "}
              and{" "}
              <a href="/legal/privacy" target="_blank" rel="noreferrer" style={legalLink}>
                Privacy Policy
              </a>
              .
            </p>
            <button type="button" style={ghost} onClick={() => setMode("intro")} disabled={busy}>
              Back
            </button>
          </form>
        )}

        {error && <div style={errBanner}>{error}</div>}

        <div style={footer}>Open source · Self-hosted</div>
      </div>
    </div>
  );
}

const shell: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "32px 16px",
  // Warm marketing ground (`--bg`/tokens come from `.mt-landing-root`, applied
  // on this element) so login feels continuous with the landing.
  background: "var(--bg)",
  color: "var(--ink)",
  fontFamily: "var(--mt-font-sans)",
  letterSpacing: "-0.012em",
};

const card: React.CSSProperties = {
  width: "100%",
  maxWidth: 380,
  background: "var(--paper)",
  border: "1px solid var(--line)",
  borderRadius: "var(--mt-r-lg)",
  padding: "32px 24px 24px",
  boxShadow: "0 24px 48px -28px rgba(20, 20, 18, 0.18)",
  textAlign: "center",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 12,
};

const brandLockup: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 9,
  marginBottom: 4,
  color: "var(--ink)",
  textDecoration: "none",
};

const wordmark: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 600,
  letterSpacing: "-0.03em",
};

const tagline: React.CSSProperties = {
  fontSize: 14,
  color: "var(--muted)",
  lineHeight: 1.5,
  marginBottom: 12,
};

const baseBtn: React.CSSProperties = {
  width: "100%",
  // Match the in-app button geometry (globals.css `.btn`): rounded-rect, not the
  // landing's pill. The passkey primary stays accent-green (see `primary`); the
  // other actions use the app's neutral/ghost treatments below.
  padding: "11px 18px",
  borderRadius: "var(--r-md)",
  fontSize: 14,
  fontWeight: 500,
  fontFamily: "var(--font-sans)",
  letterSpacing: "-0.01em",
  cursor: "pointer",
  transition: "opacity 0.15s",
  border: "1px solid transparent",
};

const primary: React.CSSProperties = {
  ...baseBtn,
  background: "var(--accent)",
  color: "white",
};

const ghost: React.CSSProperties = {
  ...baseBtn,
  background: "transparent",
  color: "var(--muted)",
};

// "Continue with …" sign-in buttons: outlined, with the method's icon.
const methodBtn: React.CSSProperties = {
  ...baseBtn,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 9,
  background: "transparent",
  color: "var(--ink)",
  borderColor: "var(--line)",
};

// "Create account" — a quiet, muted text link under the sign-in buttons (not a
// button), with a little breathing room above it.
const textLink: React.CSSProperties = {
  width: "100%",
  background: "transparent",
  border: 0,
  color: "var(--muted)",
  fontSize: 13.5,
  fontWeight: 500,
  fontFamily: "var(--font-sans)",
  letterSpacing: "-0.01em",
  cursor: "pointer",
  padding: "2px 0",
  marginTop: 6,
  textAlign: "center",
};

// "Explore the demo" — accent-green so the no-commitment entry stands out.
const demoBtn: React.CSSProperties = {
  ...baseBtn,
  background: "transparent",
  color: "var(--accent)",
};

// Plain horizontal rule separating the sign-in block from the demo.
const rule: React.CSSProperties = {
  width: "100%",
  height: 1,
  background: "var(--line)",
  margin: "6px 0",
};

const input: React.CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: "var(--mt-r-md)",
  background: "var(--paper)",
  border: "1px solid var(--line)",
  color: "var(--ink)",
  fontSize: 14,
  fontFamily: "var(--mt-font-sans)",
  marginBottom: 8,
  boxSizing: "border-box",
};

const fieldError: React.CSSProperties = {
  width: "100%",
  fontSize: 12,
  color: "var(--loss)",
  textAlign: "left",
  marginTop: -4,
  marginBottom: 8,
};
const errBanner: React.CSSProperties = {
  width: "100%",
  fontSize: 12,
  background: "rgba(209, 69, 69, 0.08)",
  color: "var(--loss)",
  borderRadius: 8,
  padding: "8px 12px",
  textAlign: "left",
};

const consentNote: React.CSSProperties = {
  fontSize: 12,
  color: "var(--muted)",
  lineHeight: 1.5,
  margin: "8px 0 2px",
};

const legalLink: React.CSSProperties = {
  color: "var(--accent)",
  textDecoration: "underline",
};

const hint: React.CSSProperties = {
  fontSize: 12,
  color: "var(--muted)",
  lineHeight: 1.5,
  // Negative margin offsets the card's 12px flex gap so the caption hugs the
  // demo button it describes (net ~6px).
  marginTop: -6,
};

const footer: React.CSSProperties = {
  marginTop: 20,
  fontFamily: "var(--mt-font-mono)",
  fontSize: 11,
  letterSpacing: "0.04em",
  color: "var(--muted-2)",
};
