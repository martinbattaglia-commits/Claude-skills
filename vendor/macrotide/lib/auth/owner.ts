import "server-only";
import { getSessionUser, type SessionUser } from "./session";

// ─── Owner identity ──────────────────────────────────────────────────────────
//
// "Owner" is the single operator of this deployment — the account the data
// backfill (scripts/backfill-owner.ts) attached all pre-multi-user rows to and
// promoted to the `trusted` tier. It is identified by the `OWNER_EMAIL` env
// var, the same canonical owner identifier the backfill script reads.
//
// Until now `OWNER_EMAIL` was script-only (run once during migration). The
// admin tier UI is the first feature that needs to recognize the owner at
// runtime, so we read the same var here. Keep it in the deployment env (not
// just .env.local for the one-off script) for the admin screen to work.
//
// FAIL-CLOSED: if `OWNER_EMAIL` is unset/blank, NOBODY is the owner — the admin
// API returns 403 and the UI hides its entry point. This is the safe default
// (Saltzer–Schroeder): a misconfigured deployment grants no admin power rather
// than accidentally electing some user as owner.

/** The configured owner email, normalised (trimmed + lowercased), or null. */
export function ownerEmail(): string | null {
  const raw = process.env.OWNER_EMAIL?.trim().toLowerCase();
  return raw ? raw : null;
}

/**
 * Whether the given session user is the deployment owner. Pure + synchronous so
 * the authorization logic is trivially unit-testable. Compares the session
 * email to `OWNER_EMAIL` case-insensitively. Fail-closed: no configured owner,
 * or no session user, → not the owner.
 */
export function isOwnerUser(user: Pick<SessionUser, "email"> | null | undefined): boolean {
  const owner = ownerEmail();
  if (!owner) return false;
  if (!user?.email) return false;
  return user.email.trim().toLowerCase() === owner;
}

/**
 * Resolve the current request's session and report whether it is the owner.
 * Returns the session user too so callers can avoid a second lookup.
 */
export async function getOwnerStatus(): Promise<{ user: SessionUser | null; isOwner: boolean }> {
  const user = await getSessionUser();
  return { user, isOwner: isOwnerUser(user) };
}

/** Convenience: is the current request the owner? */
export async function isRequestOwner(): Promise<boolean> {
  return (await getOwnerStatus()).isOwner;
}
