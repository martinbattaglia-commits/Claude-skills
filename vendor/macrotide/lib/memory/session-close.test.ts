import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { freshMarketDb } from "@/tests/db-helpers";
import { runWithDbContext } from "../db/context";
import { createThread, getThread, markIdle, reactivateThread } from "../db/queries/chat";
import * as schema from "../db/schema";
import type { ExtractionResult } from "./extract";
import { closeSession } from "./session-close";

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

function withFresh<T>(fn: () => T): T {
  const { sqlite, db, marketDb, marketSqlite } = freshDb();
  return runWithDbContext(
    { appDb: db, appSqlite: sqlite, marketDb, marketSqlite, isDemo: true, sessionId: "test" },
    fn,
  ) as T;
}

const result = (threadId: string, saved: number, lastTurnId?: number): ExtractionResult => ({
  threadId,
  summary: "",
  saved: Array.from({ length: saved }, (_, i) => ({
    id: i,
    op: "add" as const,
    targetId: null,
    category: "user" as const,
    content: "x",
    confidence: 0.9,
    injected: true,
    applied: "added" as const,
  })),
  provider: "stub",
  lastTurnId,
});

describe("closeSession", () => {
  it("extracts while still active, marks idle, and advances the watermark", async () => {
    await withFresh(async () => {
      const t = createThread();
      let statusAtExtraction: string | undefined;
      const extract = async (id: string) => {
        // Extraction must see the thread still active (idle transition is last).
        statusAtExtraction = getThread(id)?.status;
        return result(id, 1, 10);
      };
      const r = await closeSession(t.id, { extract });
      expect(statusAtExtraction).toBe("active");
      expect(r.closed).toBe(true);
      expect(r.extraction?.saved).toHaveLength(1);
      expect(getThread(t.id)?.status).toBe("idle");
      // Watermark advanced to the highest turn the pass covered.
      expect(getThread(t.id)?.extractedThroughId).toBe(10);
    });
  });

  it("is a no-op on an already-idle thread — no duplicate extraction", async () => {
    await withFresh(async () => {
      const t = createThread();
      markIdle(t.id);
      let calls = 0;
      const extract = async (id: string) => {
        calls += 1;
        return result(id, 1, 5);
      };
      const r = await closeSession(t.id, { extract });
      expect(r.closed).toBe(false);
      expect(calls).toBe(0);
      expect(getThread(t.id)?.extractedThroughId).toBeNull();
    });
  });

  it("only advances the watermark forward (resumed session re-closes from there)", async () => {
    await withFresh(async () => {
      const t = createThread();
      // First close covers through turn 4.
      await closeSession(t.id, { extract: async (id) => result(id, 1, 4) });
      expect(getThread(t.id)?.extractedThroughId).toBe(4);

      // Resume (new turn flips it back to active), then close again — the second
      // pass advances the watermark to the new turns only.
      reactivateThread(t.id);
      expect(getThread(t.id)?.status).toBe("active");
      let sawSince: number | undefined;
      await closeSession(t.id, {
        extract: async (id) => {
          // The default extractor would be scoped to since=4; assert the
          // watermark the orchestrator will pass forward by reading state.
          sawSince = getThread(id)?.extractedThroughId ?? 0;
          return result(id, 1, 9);
        },
      });
      expect(sawSince).toBe(4); // prior watermark, i.e. only turns >4 are new
      expect(getThread(t.id)?.extractedThroughId).toBe(9);
    });
  });

  it("no-ops on a missing thread without running the extractor", async () => {
    await withFresh(async () => {
      const r = await closeSession("does-not-exist", {
        extract: async () => {
          throw new Error("extractor should not run");
        },
      });
      expect(r.closed).toBe(false);
    });
  });

  it("still marks idle when the extractor throws, leaving the watermark intact", async () => {
    await withFresh(async () => {
      const t = createThread();
      const r = await closeSession(t.id, {
        extract: async () => {
          throw new Error("model exploded");
        },
      });
      expect(r.closed).toBe(true);
      expect(getThread(t.id)?.status).toBe("idle");
      expect(getThread(t.id)?.extractedThroughId).toBeNull(); // no advance on failure
    });
  });
});
