/**
 * Read the verified email claim out of an OIDC id_token (Google sends one on
 * sign-in / link). We only ever decode a token better-auth already obtained and
 * verified over TLS during the OAuth exchange, so no signature check is needed —
 * we just base64url-decode the payload segment.
 *
 * Used by the account-link hook to adopt a provider's verified email onto a
 * passkey-first (placeholder-email) account. `verified` is true ONLY when the
 * token asserts `email_verified` — a missing or false claim must not be treated
 * as proof of ownership.
 */
export function idTokenEmail(idToken: string | null | undefined): {
  email?: string;
  verified: boolean;
} {
  if (!idToken) return { verified: false };
  const payload = idToken.split(".")[1];
  if (!payload) return { verified: false };
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return {
      email: typeof claims.email === "string" ? claims.email : undefined,
      verified: claims.email_verified === true || claims.email_verified === "true",
    };
  } catch {
    return { verified: false };
  }
}
