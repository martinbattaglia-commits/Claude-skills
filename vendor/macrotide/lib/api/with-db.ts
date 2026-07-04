import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { appDb, appSqlite, marketDb, marketSqlite } from "@/lib/db/client";
import { type DbContext, runWithDbContext } from "@/lib/db/context";
import { getOrCreateDemoSession } from "@/lib/db/demo";

export const DEMO_COOKIE = "macrotide_demo";

export interface WithDbOptions {
  /**
   * Mark this route as intentionally reachable WITHOUT a session — the explicit,
   * in-code public allowlist (deny-by-default auth). An anonymous caller then
   * gets the owner singleton scoped to the shared `user_id IS NULL` row set, so
   * use this ONLY for routes meant to serve shared/built-in data to logged-out
   * visitors (e.g. a future public fund screener). Greppable on purpose — there
   * is no separate path list to drift out of sync.
   */
  public?: boolean;
}

interface RequestActor {
  userId: string | null;
  demoId: string | undefined;
  authRequired: boolean;
}

/**
 * Resolve who is making this request: the authenticated user (wins over any
 * stale demo cookie), an isolated demo session, or neither. `authRequired`
 * mirrors `isAuthRequired()` but is inlined as a bare env read so this hot path
 * doesn't pull the heavy better-auth/db module graph into the bundle.
 */
async function resolveActor(): Promise<RequestActor> {
  // Resolve the user FIRST so an authenticated session takes precedence over a
  // lingering demo cookie. A logged-in user must never be routed to demo data.
  const userId = await requireUser();
  const authRequired = process.env.AUTH_DISABLED !== "1";
  let demoId: string | undefined;
  if (!userId && authRequired) {
    // Only consult the demo cookie when there is no user AND auth is on. Under
    // AUTH_DISABLED there is no demo concept — a stale `macrotide_demo` cookie
    // must NOT hijack the local owner into an empty demo DB.
    const store = await cookies();
    demoId = store.get(DEMO_COOKIE)?.value;
  }
  return { userId, demoId, authRequired };
}

/** 401 for an anonymous request to a non-public route. */
function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

/**
 * Deny-by-default gate for API routes that do NOT go through `withDb` (pure
 * compute routes with no DB access — e.g. OCR transcription). Returns a 401
 * NextResponse when the request is anonymous and auth is required, or `null`
 * when the caller may proceed (authenticated, demo session, or AUTH_DISABLED
 * single-owner dev). Call at the top of the handler:
 *
 *     const denied = await requireApiSession();
 *     if (denied) return denied;
 */
export async function requireApiSession(): Promise<NextResponse | null> {
  const { userId, demoId, authRequired } = await resolveActor();
  if (authRequired && !userId && !demoId) return unauthorized();
  return null;
}

/**
 * Resolve a per-request DB context. An **authenticated session always wins**:
 * if a user is logged in we route to the owner app.db scoped to their id and
 * ignore any lingering `macrotide_demo` cookie. Only when there is NO
 * authenticated user AND a demo cookie is present do we route the app handle to
 * that session's isolated in-memory SQLite. Otherwise the owner singletons.
 *
 * **Deny-by-default auth.** When auth is required and the request is anonymous
 * (no session, no demo cookie), a non-allowlisted route is rejected with 401
 * rather than silently served the shared owner (`user_id IS NULL`) row set. Pass
 * `{ public: true }` to opt a route into the explicit public allowlist. Under
 * `AUTH_DISABLED=1` (single-owner dev) nothing is rejected.
 *
 * The market handle (fund catalog + NAV/quote cache) is the SHARED real
 * market.db in every case — including demo, which uses it read-write like a real
 * user (reads + write-through cache fills; see lib/market/cache.ts), so a symbol
 * fetched once serves every later session. A demo session thus sees REAL market
 * data while its own buckets/holdings/plans stay isolated in its in-memory app.db.
 *
 * For owner requests we carry the authenticated user id on the context so
 * per-user query scoping (lib/db/queries/scope.ts) applies. `userId` is null in
 * single-owner / `AUTH_DISABLED` mode (and for any explicit public route), which
 * makes scoping collapse to the legacy `user_id IS NULL` set. Demo sessions are
 * already isolated, so they stay `userId: null`.
 *
 * Wrap every route handler that touches the DB with this so demo sessions remain
 * isolated and the deny-by-default gate is applied.
 */
export async function withDb<T>(
  fn: (ctx: DbContext) => T | Promise<T>,
  opts: WithDbOptions = {},
): Promise<T> {
  const { userId, demoId, authRequired } = await resolveActor();

  // Deny-by-default: reject an anonymous request to a non-allowlisted route
  // instead of serving the shared owner (`user_id IS NULL`) set. The cast is
  // sound because every route handler returns the withDb result directly as its
  // HTTP response, so a 401 NextResponse flows straight through.
  if (!opts.public && authRequired && !userId && !demoId) {
    return unauthorized() as T;
  }

  let ctx: DbContext;
  if (userId) {
    ctx = {
      appDb,
      appSqlite,
      marketDb,
      marketSqlite,
      isDemo: false,
      sessionId: "owner",
      userId,
    };
  } else if (demoId) {
    const session = getOrCreateDemoSession(demoId);
    ctx = {
      // Demo app.db is the session's isolated in-memory copy …
      appDb: session.db,
      appSqlite: session.sqlite,
      // … but market data is the shared real market.db, used read-write just
      // like a real user so demo benefits from (and warms) the same cache.
      marketDb,
      marketSqlite,
      isDemo: true,
      sessionId: demoId,
      userId: null,
    };
  } else {
    // Reached only under AUTH_DISABLED (single-owner dev) or an explicit public
    // route: the owner singleton scoped to the shared `user_id IS NULL` set.
    ctx = {
      appDb,
      appSqlite,
      marketDb,
      marketSqlite,
      isDemo: false,
      sessionId: "owner",
      userId: null,
    };
  }

  return await runWithDbContext(ctx, async () => fn(ctx));
}
