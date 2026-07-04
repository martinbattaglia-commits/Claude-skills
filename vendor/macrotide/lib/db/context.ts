import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type Database from "better-sqlite3";
import type { drizzle } from "drizzle-orm/better-sqlite3";
import { appDb, appSqlite, marketDb, marketSqlite } from "./client";
import type * as appSchema from "./schema/app";
import type * as marketSchema from "./schema/market";

export type AppDb = ReturnType<typeof drizzle<typeof appSchema>>;
export type MarketDb = ReturnType<typeof drizzle<typeof marketSchema>>;

// Back-compat alias: most query modules typed their handle as `Db`. App-owned
// modules are the overwhelming majority, so `Db` keeps meaning the app handle.
export type Db = AppDb;

export type DbContext = {
  /** app.db handle — system of record (accounts, buckets, holdings, …). */
  appDb: AppDb;
  appSqlite: Database.Database;
  /**
   * market.db handle — regenerable market data (fund catalog/fees, NAV/quote
   * cache, feeder look-through). For demo sessions this is the SHARED real
   * market.db, used read-write like a real user — demo reads from and warms the
   * same cache (market data is global, so this just avoids redundant fetches).
   */
  marketDb: MarketDb;
  marketSqlite: Database.Database;
  /** Demo sessions get an isolated in-memory app.db; mutations never touch the owner's data. */
  isDemo: boolean;
  /** Stable identifier for the active session (owner uses "owner"). */
  sessionId: string;
  /**
   * Authenticated user id for per-user row scoping. `null` in
   * single-owner / pre-auth / demo mode — query scoping then collapses to the
   * legacy `user_id IS NULL` set, so behavior is identical to single-owner mode.
   * Optional so existing callers (tests, jobs) that omit it default to null.
   */
  userId?: string | null;
};

const storage = new AsyncLocalStorage<DbContext>();

export function runWithDbContext<T>(ctx: DbContext, fn: () => T | Promise<T>): T | Promise<T> {
  return storage.run(ctx, fn);
}

/**
 * Run `fn` with the CURRENT context's DB handles but a specific user id, so
 * `ownedBy` scoping inside resolves to that user's rows (`null` → the
 * single-owner NULL set). This is how trusted batch jobs sweep per user
 * without bypassing row scoping: enumerate ids (admin's `listUserIds`), then
 * re-enter once per user. Inherits the ambient handles, so a test's in-memory
 * context or a job's owner singletons both pass through unchanged.
 */
export function runWithUserScope<T>(
  userId: string | null,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return storage.run({ ...getDbContext(), userId }, fn);
}

/**
 * Resolve the current request's DB context. Outside a route handler (background
 * jobs, scripts, dev-server boot) we fall back to the owner singletons (the real
 * app.db + market.db).
 */
export function getDbContext(): DbContext {
  const ctx = storage.getStore();
  if (ctx) return ctx;
  return {
    appDb,
    appSqlite,
    marketDb,
    marketSqlite,
    isDemo: false,
    sessionId: "owner",
  };
}

/** The current request's app.db (system of record). */
export function getAppDb(): AppDb {
  return getDbContext().appDb;
}

/** The current request's market.db (regenerable market data). */
export function getMarketDb(): MarketDb {
  return getDbContext().marketDb;
}

/**
 * Legacy alias for {@link getAppDb}. The vast majority of `getDb()` callers are
 * app-owned query modules; market/fund modules have been routed to
 * {@link getMarketDb}. Prefer the explicit accessors in new code.
 */
export function getDb(): AppDb {
  return getAppDb();
}

export function isDemoRequest(): boolean {
  return getDbContext().isDemo;
}

/**
 * Current request's authenticated user id, or `null` in single-owner / pre-auth
 * / demo mode. Per-user query scoping reads this (see lib/db/queries/scope.ts).
 */
export function getUserId(): string | null {
  return getDbContext().userId ?? null;
}
