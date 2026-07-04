import "server-only";
import { getSessionUser } from "./session";

/**
 * Resolve the authenticated user's id for per-user DB scoping.
 *
 * Returns the logged-in user's id, or `null` when there is no session — which
 * covers single-user / `AUTH_DISABLED` / demo mode. In that null case the query
 * layer (lib/db/queries/scope.ts) collapses to the legacy `user_id IS NULL`
 * row set, so behavior is identical to single-owner mode.
 *
 * NOTE: this is intentionally NON-enforcing — it never throws / returns 401.
 * Hard route-level enforcement (reject unauthenticated requests) is deferred.
 * For now this only supplies the id that `withDb` plumbs into
 * the AsyncLocalStorage db context.
 */
export async function requireUser(): Promise<string | null> {
  const user = await getSessionUser();
  return user?.id ?? null;
}
