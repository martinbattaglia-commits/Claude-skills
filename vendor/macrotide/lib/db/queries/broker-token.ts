import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { getUserId } from "../context";
import { getSetting, listSettings, setSetting } from "./settings";

/**
 * Constant-time string equality, so token verification doesn't leak a
 * byte-by-byte match position through response timing. Unequal lengths short-
 * circuit (the token length is fixed and not secret); equal lengths compare in
 * time independent of how many leading bytes match.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// The broker import token — a narrowly-scoped API key that authorizes POSTing
// broker-import data into ONE user's ledger via the ingest endpoint, and nothing
// else. It is embedded in the user's installed userscript so a sync can reach
// Macrotide without an open, cookie-authenticated tab. It does NOT store or grant
// any broker access (the broker session stays in the user's own browser). It
// lives in the `settings` table, keyed per user, and is rotatable from Settings.

const PREFIX = "broker_import_token:";

function keyFor(userId: string | null): string {
  return `${PREFIX}${userId ?? "owner"}`;
}

/** The current user's token, or null if none has been minted yet. */
export function getBrokerImportToken(): string | null {
  return getSetting<string>(keyFor(getUserId())) ?? null;
}

/** The current user's token, minting one on first use. */
export function getOrCreateBrokerImportToken(): string {
  const existing = getBrokerImportToken();
  if (existing) return existing;
  const token = randomBytes(16).toString("hex");
  setSetting(keyFor(getUserId()), token);
  return token;
}

/** Replace the current user's token (invalidates any installed userscript). */
export function rotateBrokerImportToken(): string {
  const token = randomBytes(16).toString("hex");
  setSetting(keyFor(getUserId()), token);
  return token;
}

/**
 * Resolve an import token to the user it belongs to:
 *   - a userId string for a logged-in owner,
 *   - `null` for the single-owner / `AUTH_DISABLED` "owner" token,
 *   - `undefined` when the token matches nothing (caller → 401).
 * Reads `settings` (not user-scoped — keyed by the user suffix), so it must run
 * inside the owner app.db context.
 */
export function resolveBrokerImportTokenUser(token: string): string | null | undefined {
  if (!token) return undefined;
  for (const row of listSettings()) {
    if (
      typeof row.key === "string" &&
      row.key.startsWith(PREFIX) &&
      typeof row.value === "string" &&
      constantTimeEqual(row.value, token)
    ) {
      const suffix = row.key.slice(PREFIX.length);
      return suffix === "owner" ? null : suffix;
    }
  }
  return undefined;
}
