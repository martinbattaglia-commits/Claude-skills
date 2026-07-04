import "server-only";
import { appDb, appSqlite, marketDb, marketSqlite } from "@/lib/db/client";
import { type DbContext, runWithDbContext } from "@/lib/db/context";
import { resolveBrokerImportTokenUser } from "@/lib/db/queries/broker-token";

// Run a handler authenticated by a broker import token instead of a session
// cookie. The userscript posts cross-origin (no Macrotide cookies), so the token
// is the only credential. We resolve it against the OWNER app.db, then run `fn`
// in that user's owner context so per-user query scoping applies. Demo DBs are
// never reachable this way — tokens only live in the owner app.db.

/**
 * Resolve `token` → its user and run `fn` in that user's owner DB context.
 * Returns `{ ok: false }` (→ 401) when the token matches no user.
 */
export async function withImportToken<T>(
  token: string,
  fn: () => T | Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const base: DbContext = {
    appDb,
    appSqlite,
    marketDb,
    marketSqlite,
    isDemo: false,
    sessionId: "owner",
    userId: null,
  };
  // Token lookup is not user-scoped (keyed by the user suffix), so a base owner
  // context suffices to find which user owns it.
  const userId = await runWithDbContext(base, () => resolveBrokerImportTokenUser(token));
  if (userId === undefined) return { ok: false };
  const value = await runWithDbContext({ ...base, userId }, async () => fn());
  return { ok: true, value };
}
