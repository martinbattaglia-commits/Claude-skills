/**
 * Placeholder emails for passkey-first accounts.
 *
 * A passkey signup collects only a name — no email. But better-auth's `user`
 * row requires a unique, non-null, format-valid email, so we mint a synthetic
 * one. The domain is `passkey.invalid`:
 *   - RFC 6761 reserves `.invalid` as non-resolving and unregistrable, so the
 *     address can never be delivered to or collide with a real inbox.
 *   - It still passes better-auth's `z.email()` signup check (a bare
 *     `<id>@passkey` does NOT — Zod requires a dotted domain + TLD).
 *
 * When such an account later links an OAuth provider, the verified provider
 * email is *adopted* onto the row (see `lib/auth/index.ts`), at which point
 * `isPlaceholderEmail` flips to false and the real email surfaces in the UI.
 *
 * This module is intentionally NOT `server-only`: the client mints the
 * placeholder at signup, and client components use the predicate to hide it.
 */
export const PLACEHOLDER_EMAIL_DOMAIN = "passkey.invalid";

/** Mint a unique, non-deliverable placeholder email for a passkey-only account. */
export function placeholderEmail(): string {
  return `${crypto.randomUUID()}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

/**
 * True when `email` is a synthetic placeholder (a passkey-only account that
 * hasn't adopted a real provider email yet). Robust because `.invalid` can
 * never be a real address, so there are no false positives.
 */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return Boolean(email?.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`));
}
