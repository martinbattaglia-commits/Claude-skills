// Shared test helpers for the split database.
//
// Each helper builds a fresh in-memory SQLite from a migration BASELINE and
// wraps it as a drizzle handle. After the app/market split a full DbContext
// carries BOTH an app.db handle and a market.db handle, so `makeTestDbContext`
// builds both and returns a ready-to-use context for runWithDbContext().

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { DbContext } from "@/lib/db/context";
import { runWithDbContext } from "@/lib/db/context";
import * as appSchema from "@/lib/db/schema/app";
import * as marketSchema from "@/lib/db/schema/market";

const APP_MIGRATIONS_DIR = resolve("lib/db/migrations/app");
const MARKET_MIGRATIONS_DIR = resolve("lib/db/migrations/market");

/** Replay every .sql file in a migrations dir into a fresh :memory: SQLite. */
function applyMigrations(sqlite: Database.Database, dir: string): void {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const sql = files
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n")
    .replace(/--> statement-breakpoint/g, ";");
  sqlite.exec(sql);
}

/**
 * Fresh in-memory app.db (system of record) migrated from the app baseline.
 *
 * @param options.foreignKeys - Whether to enforce FK constraints (default: true).
 *   Pass `false` when the test needs to use arbitrary userId values without
 *   seeding the users table — the migrations may re-enable the pragma, so this
 *   flag applies the pragma AFTER migrations run.
 */
export function freshAppDb(options: { foreignKeys?: boolean } = {}) {
  const { foreignKeys = true } = options;
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrations(sqlite, APP_MIGRATIONS_DIR);
  // Apply after migrations in case any migration re-enables the pragma.
  if (!foreignKeys) sqlite.pragma("foreign_keys = OFF");
  return { sqlite, db: drizzle(sqlite, { schema: appSchema }) };
}

/** Fresh in-memory market.db (regenerable data) migrated from the market baseline. */
export function freshMarketDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrations(sqlite, MARKET_MIGRATIONS_DIR);
  return { sqlite, db: drizzle(sqlite, { schema: marketSchema }) };
}

/**
 * A complete DbContext backed by two fresh in-memory databases. Pass overrides
 * for isDemo / sessionId / userId as needed.
 */
export function makeTestDbContext(
  overrides: Partial<Pick<DbContext, "isDemo" | "sessionId" | "userId">> = {},
): DbContext {
  const app = freshAppDb();
  const market = freshMarketDb();
  return {
    appDb: app.db,
    appSqlite: app.sqlite,
    marketDb: market.db,
    marketSqlite: market.sqlite,
    isDemo: overrides.isDemo ?? false,
    sessionId: overrides.sessionId ?? "test",
    userId: overrides.userId ?? null,
  };
}

/**
 * Run `fn` inside a fresh isolated DbContext (isDemo: true, sessionId: "test").
 *
 * Replaces the common hand-rolled pattern:
 * ```ts
 * function freshDb() { ... }
 * function withFresh<T>(fn: () => T): T {
 *   const { sqlite, db, marketDb, marketSqlite } = freshDb();
 *   return runWithDbContext({ appDb: db, appSqlite: sqlite, ... }, fn) as T;
 * }
 * ```
 * across test files that need a self-contained app.db + market.db per call.
 */
export function withFreshContext<T>(fn: () => T): T {
  const ctx = makeTestDbContext({ isDemo: true });
  return runWithDbContext(ctx, fn) as T;
}
