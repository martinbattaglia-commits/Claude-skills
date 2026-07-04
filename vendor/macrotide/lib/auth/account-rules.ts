/**
 * Pure decision logic for OAuth link/unlink, factored out of the better-auth
 * `account.*` hooks (lib/auth/index.ts) so it's unit-testable without a DB. The
 * hooks supply the counts/flags; these functions decide. The `credential`
 * bootstrap row is never a "social" provider and is never counted as usable.
 */

/**
 * Block unlinking a provider when it would strand the user with no usable
 * sign-in method — no other OAuth provider AND no passkey. `otherSocialCount` is
 * the provider count EXCLUDING the one being removed.
 */
export function shouldBlockUnlink(opts: {
  isSocial: boolean;
  otherSocialCount: number;
  passkeyCount: number;
}): boolean {
  if (!opts.isSocial) return false;
  return opts.otherSocialCount <= 0 && opts.passkeyCount === 0;
}

/**
 * Adopt the just-linked provider's email when it's the account's *sole* OAuth
 * provider (passkey-first first link, or a re-link after unlinking the previous
 * one), or when the current email is still a placeholder. With a second provider
 * already present, the first-adopted email stands.
 */
export function shouldAdoptOnLink(opts: {
  isSocial: boolean;
  currentIsPlaceholder: boolean;
  isSoleProvider: boolean;
}): boolean {
  if (!opts.isSocial) return false;
  return opts.currentIsPlaceholder || opts.isSoleProvider;
}

/**
 * After unlinking, reset the account email to an emailless placeholder when no
 * OAuth provider remains (and it isn't already a placeholder) — so the displayed
 * email always reflects a currently-linked provider, or nothing.
 */
export function shouldResetEmailOnUnlink(opts: {
  isSocial: boolean;
  remainingSocialCount: number;
  currentIsPlaceholder: boolean;
}): boolean {
  if (!opts.isSocial) return false;
  return opts.remainingSocialCount === 0 && !opts.currentIsPlaceholder;
}
