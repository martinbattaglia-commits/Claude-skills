import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { freshMarketDb } from "@/tests/db-helpers";
import { runWithDbContext } from "../context";
import * as schema from "../schema";
import {
  appendMessage,
  createThread,
  getLatestSummary,
  listMessages,
  SUMMARY_ROLE,
  upsertSummary,
} from "./chat";

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const migrationsDir = resolve("lib/db/migrations/app");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const sql = files
    .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
    .join("\n")
    .replace(/--> statement-breakpoint/g, ";");
  sqlite.exec(sql);
  const market = freshMarketDb();
  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
    marketDb: market.db,
    marketSqlite: market.sqlite,
  };
}

function withFresh<T>(fn: () => T | Promise<T>): Promise<T> {
  const { sqlite, db, marketDb, marketSqlite } = freshDb();
  return runWithDbContext(
    { appDb: db, appSqlite: sqlite, marketDb, marketSqlite, isDemo: true, sessionId: "test" },
    fn,
  ) as Promise<T>;
}

describe("context-summary persistence (migration-free)", () => {
  it("stores a summary as a SUMMARY_ROLE row without dropping any conversation rows", async () => {
    await withFresh(() => {
      const t = createThread();
      // 25 turn-pairs = 50 user/assistant rows.
      for (let i = 0; i < 25; i++) {
        appendMessage({ threadId: t.id, role: "user", content: `Q${i}` });
        appendMessage({ threadId: t.id, role: "assistant", content: `A${i}` });
      }

      upsertSummary(t.id, "Summary of the first many turns.");

      // Display view excludes the internal summary row → conversation intact.
      const display = listMessages(t.id);
      expect(display).toHaveLength(50);
      expect(display.every((m) => m.role !== SUMMARY_ROLE)).toBe(true);

      // Full view includes the one summary row (51 total) — nothing deleted.
      const all = listMessages(t.id, { includeInternal: true });
      expect(all).toHaveLength(51);
      expect(all.filter((m) => m.role === SUMMARY_ROLE)).toHaveLength(1);
    });
  });

  it("upsert replaces the prior summary (one per thread) and never touches conversation rows", async () => {
    await withFresh(() => {
      const t = createThread();
      appendMessage({ threadId: t.id, role: "user", content: "hi" });
      appendMessage({ threadId: t.id, role: "assistant", content: "hello" });

      upsertSummary(t.id, "first summary");
      upsertSummary(t.id, "second summary");

      const all = listMessages(t.id, { includeInternal: true });
      expect(all.filter((m) => m.role === SUMMARY_ROLE)).toHaveLength(1);
      expect(getLatestSummary(t.id)?.content).toBe("second summary");

      // The two real turns are still present and unchanged.
      expect(listMessages(t.id)).toHaveLength(2);
    });
  });
});
