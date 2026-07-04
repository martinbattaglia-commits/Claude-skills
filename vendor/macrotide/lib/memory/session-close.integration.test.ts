/**
 * Integration tests for the full real-time session close + resume cycle.
 *
 * Unlike the unit tests in session-close.test.ts (which stub `extract` with
 * synthetic lastTurnIds), these tests spin up a real in-memory SQLite DB with
 * all migrations applied, insert actual chat_messages rows via appendMessage,
 * and assert that closeSession correctly wires the watermark to real DB IDs.
 *
 * No real model calls — the `extract` option is injected with a deterministic
 * spy that reads the DB to learn the real turn IDs.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { freshMarketDb } from "@/tests/db-helpers";
import { runWithDbContext } from "../db/context";
import {
  appendMessage,
  createThread,
  getThread,
  listMessages,
  reactivateThread,
} from "../db/queries/chat";
import * as schema from "../db/schema";
import type { ExtractionResult } from "./extract";
import { closeSession } from "./session-close";

// ─── Test DB helpers ─────────────────────────────────────────────────────────

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

// ─── Spy helpers ─────────────────────────────────────────────────────────────

/**
 * Builds a fake ExtractionResult whose `lastTurnId` equals the actual maximum
 * message ID stored in the thread at the time it's called. This mirrors what
 * the real incremental extractor does and lets assertions use real DB IDs.
 */
function makeExtractSpy(savedCount = 1, onCall?: (threadId: string, sinceTurnId: number) => void) {
  let callCount = 0;

  const extract = async (id: string): Promise<ExtractionResult> => {
    callCount++;
    // Read the watermark *before* it's advanced so the spy can capture the
    // sinceTurnId the real extractor would have received.
    const sinceTurnId = getThread(id)?.extractedThroughId ?? 0;
    onCall?.(id, sinceTurnId);

    const messages = listMessages(id);
    const lastTurnId = messages.length > 0 ? Math.max(...messages.map((m) => m.id)) : undefined;

    return {
      threadId: id,
      summary: "stub summary",
      saved: Array.from({ length: savedCount }, (_, i) => ({
        id: i,
        op: "add" as const,
        targetId: null,
        category: "user" as const,
        content: `extracted fact ${i}`,
        confidence: 0.9,
        injected: true,
        applied: "added" as const,
      })),
      provider: "stub",
      lastTurnId,
    };
  };

  return { extract, getCallCount: () => callCount };
}

/**
 * Builds a fake extractor scoped to turns PAST a given watermark — mirrors
 * what the real incremental extractor does when `sinceTurnId` is non-zero.
 * Returns `lastTurnId = max(id) of turns with id > watermark`.
 */
function makeIncrementalSpy(
  watermark: number,
  onCall?: (threadId: string, sinceTurnId: number) => void,
) {
  let callCount = 0;
  let capturedSince: number | undefined;

  const extract = async (id: string): Promise<ExtractionResult> => {
    callCount++;
    capturedSince = getThread(id)?.extractedThroughId ?? 0;
    onCall?.(id, capturedSince);

    const newMsgs = listMessages(id).filter((m) => m.id > watermark);
    const lastTurnId = newMsgs.length > 0 ? Math.max(...newMsgs.map((m) => m.id)) : undefined;

    return {
      threadId: id,
      summary: "incremental stub summary",
      saved: newMsgs.map((m, i) => ({
        id: i,
        op: "add" as const,
        targetId: null,
        category: "user" as const,
        content: `fact from turn ${m.id}`,
        confidence: 0.85,
        injected: true,
        applied: "added" as const,
      })),
      provider: "stub",
      lastTurnId,
    };
  };

  return { extract, getCallCount: () => callCount, getCapturedSince: () => capturedSince };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("closeSession integration — full real-time session close + resume cycle", () => {
  /**
   * Case 1: active thread → closeSession → status becomes idle and
   * extracted_through_id advances to the actual last turn id in the DB.
   */
  it("case 1: active thread → closeSession → status idle, watermark = last turn id", async () => {
    await withFresh(async () => {
      const t = createThread();
      appendMessage({ threadId: t.id, role: "user", content: "Hello, what is DCA?" });
      appendMessage({
        threadId: t.id,
        role: "assistant",
        content: "DCA is dollar cost averaging.",
      });

      const msgs = listMessages(t.id);
      const expectedLastTurnId = Math.max(...msgs.map((m) => m.id));

      const { extract } = makeExtractSpy(1);
      const r = await closeSession(t.id, { extract });

      expect(r.closed).toBe(true);
      expect(r.thread?.status).toBe("idle");

      const dbThread = getThread(t.id);
      expect(dbThread?.status).toBe("idle");
      expect(dbThread?.extractedThroughId).toBe(expectedLastTurnId);

      expect(r.extraction?.saved).toHaveLength(1);
      expect(r.extraction?.lastTurnId).toBe(expectedLastTurnId);
    });
  });

  /**
   * Case 2: closeSession on an already-idle thread is a no-op — the extractor
   * never fires, the watermark doesn't change, and closed is false.
   */
  it("case 2: closeSession on an already-idle thread → no-op, no duplicate extraction", async () => {
    await withFresh(async () => {
      const t = createThread();
      appendMessage({ threadId: t.id, role: "user", content: "My risk tolerance is moderate." });

      // First close — transitions to idle and sets the watermark.
      const firstSpy = makeExtractSpy(1);
      await closeSession(t.id, { extract: firstSpy.extract });
      const watermarkAfterFirstClose = getThread(t.id)?.extractedThroughId;
      expect(getThread(t.id)?.status).toBe("idle");

      // Second call on the already-idle thread.
      const secondSpy = makeExtractSpy(1);
      const r = await closeSession(t.id, { extract: secondSpy.extract });

      expect(r.closed).toBe(false);
      expect(secondSpy.getCallCount()).toBe(0); // extractor never ran
      // Watermark is unchanged from the first close.
      expect(getThread(t.id)?.extractedThroughId).toBe(watermarkAfterFirstClose);
      expect(getThread(t.id)?.status).toBe("idle");
    });
  });

  /**
   * Case 3: reactivate + append new turns → closeSession → only the NEW turns
   * past the prior watermark are extracted (spy verifies sinceTurnId, and the
   * watermark advances again to the new last turn).
   */
  it("case 3: reactivate + new turns → only new turns extracted, watermark advances", async () => {
    await withFresh(async () => {
      // ── First session: 2 turns ──────────────────────────────────────────────
      const t = createThread();
      appendMessage({ threadId: t.id, role: "user", content: "I want to buy SSF." });
      appendMessage({
        threadId: t.id,
        role: "assistant",
        content: "SSF is the Thai Super Savings Fund.",
      });

      const firstMsgs = listMessages(t.id);
      const firstWatermark = Math.max(...firstMsgs.map((m) => m.id));

      await closeSession(t.id, { extract: makeExtractSpy(1).extract });
      expect(getThread(t.id)?.extractedThroughId).toBe(firstWatermark);
      expect(getThread(t.id)?.status).toBe("idle");

      // ── Resume: reactivate + add new turns ─────────────────────────────────
      reactivateThread(t.id);
      expect(getThread(t.id)?.status).toBe("active");
      // Watermark must survive the reactivation intact.
      expect(getThread(t.id)?.extractedThroughId).toBe(firstWatermark);

      appendMessage({ threadId: t.id, role: "user", content: "Follow-up: what is RMF?" });
      appendMessage({
        threadId: t.id,
        role: "assistant",
        content: "RMF is the Thai Retirement Mutual Fund.",
      });

      const allMsgs = listMessages(t.id);
      const newMsgs = allMsgs.filter((m) => m.id > firstWatermark);
      expect(newMsgs).toHaveLength(2); // sanity: exactly the resumed turns

      const expectedNewWatermark = Math.max(...newMsgs.map((m) => m.id));

      // ── Second close: spy scoped to new turns only ──────────────────────────
      const incrementalSpy = makeIncrementalSpy(firstWatermark);
      const r = await closeSession(t.id, { extract: incrementalSpy.extract });

      expect(r.closed).toBe(true);
      expect(incrementalSpy.getCallCount()).toBe(1);

      // The sinceTurnId seen by the extractor equals the prior watermark,
      // confirming only turns > firstWatermark were in scope.
      expect(incrementalSpy.getCapturedSince()).toBe(firstWatermark);

      // Watermark advances to cover the new turns.
      expect(getThread(t.id)?.extractedThroughId).toBe(expectedNewWatermark);
      expect(getThread(t.id)?.status).toBe("idle");

      // Extracted facts correspond to the new turns only.
      expect(r.extraction?.saved).toHaveLength(newMsgs.length);
    });
  });

  /**
   * Case 4a: closeSession on a missing thread → {closed: false}, no throw.
   */
  it("case 4a: missing thread → {closed: false}, no throw", async () => {
    await withFresh(async () => {
      const r = await closeSession("does-not-exist-thread-id");
      expect(r.closed).toBe(false);
      expect(r.thread).toBeUndefined();
    });
  });

  /**
   * Case 4b: closeSession on an archived (non-active) thread → no-op.
   */
  it("case 4b: archived (non-active) thread → {closed: false}, no throw", async () => {
    await withFresh(async () => {
      const t = createThread();
      appendMessage({ threadId: t.id, role: "user", content: "Archive me." });

      // Manually set to archived (bypasses closeSession to test the guard directly).
      const { archiveThread } = await import("../db/queries/chat");
      archiveThread(t.id);
      expect(getThread(t.id)?.status).toBe("archived");

      const spy = makeExtractSpy(1);
      const r = await closeSession(t.id, { extract: spy.extract });

      expect(r.closed).toBe(false);
      expect(spy.getCallCount()).toBe(0); // extractor must not run
      expect(getThread(t.id)?.status).toBe("archived");
    });
  });
});
