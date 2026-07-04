import "server-only";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as appSchema from "./schema/app";

// A demo session is its own in-memory app.db (system of record), seeded with
// the persona's buckets/holdings/plans/journal. Market data is NOT seeded here:
// the demo shares the real market.db and its cache with real users (see
// lib/api/with-db.ts), so we only replay the APP baseline into the session DB.
const APP_MIGRATIONS_DIR = resolve("lib/db/migrations/app");
const IDLE_TTL_MS = 60 * 60 * 1000; // 1h
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5m
const MAX_SESSIONS = 200; // hard cap; oldest evicted on overflow

type DemoSession = {
  sqlite: Database.Database;
  db: ReturnType<typeof drizzle<typeof appSchema>>;
  createdAt: number;
  lastUsed: number;
  chatTurnsUsed: number;
};

const globalForDemo = globalThis as unknown as {
  __macrotideDemoSessions?: Map<string, DemoSession>;
  __macrotideDemoSweeperStarted?: boolean;
};

function sessions(): Map<string, DemoSession> {
  if (!globalForDemo.__macrotideDemoSessions) {
    globalForDemo.__macrotideDemoSessions = new Map();
  }
  return globalForDemo.__macrotideDemoSessions;
}

// Run drizzle-style migrations against an in-memory DB by replaying SQL files
// directly. better-sqlite3's migrate() works against any database handle, but
// loading from disk each session adds latency; the SQL is small so we cache it.
let cachedMigrationSql: string | null = null;
function migrationSql(): string {
  if (cachedMigrationSql !== null) return cachedMigrationSql;
  if (!existsSync(APP_MIGRATIONS_DIR)) {
    cachedMigrationSql = "";
    return "";
  }
  const files = readdirSync(APP_MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  cachedMigrationSql = files
    .map((f) => readFileSync(join(APP_MIGRATIONS_DIR, f), "utf8"))
    // drizzle generates statement-breakpoint comments; turn them into a single
    // semicolon-terminated stream so better-sqlite3's exec() can run them.
    .join("\n")
    .replace(/--> statement-breakpoint/g, ";");
  return cachedMigrationSql;
}

function startSweeper(): void {
  if (globalForDemo.__macrotideDemoSweeperStarted) return;
  globalForDemo.__macrotideDemoSweeperStarted = true;
  setInterval(() => {
    const now = Date.now();
    const map = sessions();
    for (const [id, session] of map.entries()) {
      if (now - session.lastUsed > IDLE_TTL_MS) {
        try {
          session.sqlite.close();
        } catch {
          // best-effort
        }
        map.delete(id);
      }
    }
  }, SWEEP_INTERVAL_MS).unref();
}

function evictOldest(): void {
  const map = sessions();
  let oldestKey: string | null = null;
  let oldestUsed = Number.POSITIVE_INFINITY;
  for (const [id, session] of map.entries()) {
    if (session.lastUsed < oldestUsed) {
      oldestUsed = session.lastUsed;
      oldestKey = id;
    }
  }
  if (oldestKey) {
    const session = map.get(oldestKey);
    try {
      session?.sqlite.close();
    } catch {
      // best-effort
    }
    map.delete(oldestKey);
  }
}

/**
 * Get-or-create a demo session keyed by ID. Each session has its own in-memory
 * SQLite, isolated from the owner's DB. Migrations + mock seed run on creation.
 */
export function getOrCreateDemoSession(sessionId: string): DemoSession {
  startSweeper();
  const map = sessions();
  const existing = map.get(sessionId);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }

  if (map.size >= MAX_SESSIONS) {
    evictOldest();
  }

  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = MEMORY");

  const sql = migrationSql();
  if (sql) sqlite.exec(sql);

  const db = drizzle(sqlite, { schema: appSchema });

  // Seed mock data so the demo has something to explore.
  // Imported lazily to avoid loading the static fixtures on every cold start.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { seedDemoData } = require("../mock/demo-seed");
  seedDemoData(db);

  const session: DemoSession = {
    sqlite,
    db,
    createdAt: Date.now(),
    lastUsed: Date.now(),
    chatTurnsUsed: 0,
  };
  map.set(sessionId, session);
  return session;
}

export function getDemoSession(sessionId: string): DemoSession | undefined {
  const session = sessions().get(sessionId);
  if (session) session.lastUsed = Date.now();
  return session;
}

export function dropDemoSession(sessionId: string): void {
  const map = sessions();
  const session = map.get(sessionId);
  if (!session) return;
  try {
    session.sqlite.close();
  } catch {
    // best-effort
  }
  map.delete(sessionId);
}

export function incrementChatTurn(sessionId: string): number {
  const session = sessions().get(sessionId);
  if (!session) return 0;
  session.chatTurnsUsed += 1;
  session.lastUsed = Date.now();
  return session.chatTurnsUsed;
}

export function getChatTurnsUsed(sessionId: string): number {
  return sessions().get(sessionId)?.chatTurnsUsed ?? 0;
}

export function demoSessionStats(): { count: number; ids: string[] } {
  const map = sessions();
  return { count: map.size, ids: [...map.keys()] };
}

export const DEMO_CHAT_TURN_CAP = 10;
