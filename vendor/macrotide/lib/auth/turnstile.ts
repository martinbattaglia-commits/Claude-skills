import "server-only";

/**
 * Cloudflare Turnstile bot-protection gate.
 *
 * Env vars (operator-supplied):
 *   TURNSTILE_SITE_KEY    — PUBLIC, shipped to the browser to render the widget.
 *   TURNSTILE_SECRET_KEY  — server-only, used to verify the client token here.
 *
 * Dev behavior: when `TURNSTILE_SECRET_KEY` is unset, verification is BYPASSED
 * (treated as a pass) so local dev / passkey-only deploys work with no setup.
 * Production should set both keys; without the secret, the signup gate is open.
 */
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** True when the server secret is present — i.e. verification is enforced. */
export function turnstileConfigured(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET_KEY);
}

/** Public site key for the browser widget, or null when not configured. */
export function turnstileSiteKey(): string | null {
  return process.env.TURNSTILE_SITE_KEY ?? null;
}

interface SiteverifyResponse {
  success: boolean;
  "error-codes"?: string[];
}

/**
 * Verify a Turnstile token against Cloudflare's siteverify endpoint.
 *
 * Returns `true` (bypass) when no secret is configured. Otherwise returns the
 * verification result; a missing/empty token is an automatic failure. Network
 * or parse errors fail closed (`false`) when verification is enforced.
 */
export async function verifyTurnstile(
  token: string | null | undefined,
  remoteIp?: string,
): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // dev bypass — no secret means the gate is off
  if (!token) return false;

  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as SiteverifyResponse;
    return data.success === true;
  } catch {
    return false;
  }
}
