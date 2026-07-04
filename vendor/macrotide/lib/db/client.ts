import "server-only";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { ensureTemplatePresets } from "../templates/ensure-presets";
import * as appSchema from "./schema/app";
import * as marketSchema from "./schema/market";

// The database is split along a lifecycle boundary:
//   - app.db    — system of record (accounts, buckets, holdings, plans, chat,
//                 preferences). Precious; backed up nightly.
//   - market.db — regenerable market data (fund catalog, fees, NAV/quote cache,
//                 feeder look-through). Rebuildable from upstream; NOT backed up.
function runtimePath(envPath: string | undefined, ...fallbackSegments: string[]) {
  if (envPath) {
    return isAbsolute(envPath) ? envPath : join(/*turbopackIgnore: true*/ process.cwd(), envPath);
  }
  return join(/*turbopackIgnore: true*/ process.cwd(), ...fallbackSegments);
}

// `next build` collects page data for routes in PARALLEL worker processes, each
// of which imports this module. Routes are imported for static analysis only —
// handlers never run, so the DB is never queried during the build. Opening the
// real file anyway caused two build-time failures:
//   1. every worker ran migrate() against the same fresh data/*.db, racing on
//      CREATE TABLE ("table `buckets` already exists"); and
//   2. even just opening the file and switching to WAL takes a brief write lock,
//      so N workers contending on one file failed the build non-deterministically
//      ("Failed to collect page data") — a busy_timeout only narrows that window,
//      it doesn't close it.
// Fix: during the build phase each worker gets its OWN private in-memory DB. No
// shared file, no lock, no contention — and nothing reads it, so migrations are
// unnecessary. The real file-backed DB + migrations are used at server startup
// (BUILD_PHASE === false), unchanged.
const BUILD_PHASE = process.env.NEXT_PHASE === "phase-production-build";

const APP_DB_PATH = BUILD_PHASE ? ":memory:" : runtimePath(process.env.DB_PATH, "data", "app.db");
const MARKET_DB_PATH = BUILD_PHASE
  ? ":memory:"
  : runtimePath(process.env.MARKET_DB_PATH, "data", "market.db");
const APP_MIGRATIONS_DIR = runtimePath(undefined, "lib", "db", "migrations", "app");
const MARKET_MIGRATIONS_DIR = runtimePath(undefined, "lib", "db", "migrations", "market");

// Next.js hot-reload reimports server modules — pin the connections on
// globalThis so we don't leak SQLite file handles across reloads in dev.
const globalForDb = globalThis as unknown as {
  __macrotideAppSqlite?: Database.Database;
  __macrotideAppDb?: ReturnType<typeof drizzle<typeof appSchema>>;
  __macrotideMarketSqlite?: Database.Database;
  __macrotideMarketDb?: ReturnType<typeof drizzle<typeof marketSchema>>;
};

function open(path: string): Database.Database {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const sqlite = new Database(path);
  // Wait for a held lock instead of throwing SQLITE_BUSY immediately. At runtime
  // more than one process opens these files concurrently — the server, the
  // systemd `jobs:refresh-market` timer (writes the quote cache), and one-off
  // `db:*` CLIs / the in-process backup reader — so a writer can briefly hold the
  // lock (including the journal_mode=WAL switch on open). Set it FIRST so it
  // covers that switch. (Build workers no longer contend: each gets its own
  // private :memory: DB — see BUILD_PHASE above.)
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = NORMAL");
  return sqlite;
}

function initApp() {
  const sqlite = open(APP_DB_PATH);
  const db = drizzle(sqlite, { schema: appSchema });

  if (existsSync(APP_MIGRATIONS_DIR) && !BUILD_PHASE) {
    migrate(db, { migrationsFolder: APP_MIGRATIONS_DIR });
    // Land any missing factory template presets (built-in model portfolios).
    // Additive + idempotent: never wipes or overwrites, so it's safe on every
    // boot against a DB full of real data. See lib/templates/ensure-presets.ts.
    ensureTemplatePresets(db);
  }

  // Back up app.db only — it is the precious system of record. market.db is
  // regenerable from upstream and is deliberately not backed up.
  if (!BUILD_PHASE) {
    void import("./backup")
      .then(({ backupIfStale }) => backupIfStale(sqlite))
      .catch((err) => {
        console.error("[macrotide] backup failed:", err);
      });
  }

  return { sqlite, db };
}

function initMarket() {
  const sqlite = open(MARKET_DB_PATH);
  const db = drizzle(sqlite, { schema: marketSchema });

  if (existsSync(MARKET_MIGRATIONS_DIR) && !BUILD_PHASE) {
    migrate(db, { migrationsFolder: MARKET_MIGRATIONS_DIR });
  }

  return { sqlite, db };
}

if (!globalForDb.__macrotideAppDb) {
  const { sqlite, db } = initApp();
  globalForDb.__macrotideAppSqlite = sqlite;
  globalForDb.__macrotideAppDb = db;
}

if (!globalForDb.__macrotideMarketDb) {
  const { sqlite, db } = initMarket();
  globalForDb.__macrotideMarketSqlite = sqlite;
  globalForDb.__macrotideMarketDb = db;
}

export const appSqlite = globalForDb.__macrotideAppSqlite as Database.Database;
export const appDb = globalForDb.__macrotideAppDb as ReturnType<typeof drizzle<typeof appSchema>>;
export const marketSqlite = globalForDb.__macrotideMarketSqlite as Database.Database;
export const marketDb = globalForDb.__macrotideMarketDb as ReturnType<
  typeof drizzle<typeof marketSchema>
>;

// Back-compat aliases — `ownerDb`/`ownerSqlite` historically meant "the app's
// own (non-demo) database". They now point at app.db. Prefer the typed
// accessors from `./context` (getAppDb / getMarketDb) in new code so demo
// sessions are honored.
export const ownerDb = appDb;
export const ownerSqlite = appSqlite;
