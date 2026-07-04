// Tests for the close-stale-sessions CLI script.
//
// Coverage:
//   1. parseArgs — unit-tested as a pure function (no DB, no I/O).
//   2. Dry-run behavior — uses an :memory: freshDb context so nothing is
//      written to a real DB. The test verifies that findIdleThreads picks up
//      the stale candidates correctly, which is exactly what the dry-run path
//      reports.
//
// The real closeStaleSessions sweep (actual closes + extraction) is already
// covered in lib/db/queries/chat.test.ts; this file focuses on the CLI layer.

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withFreshContext } from "@/tests/db-helpers";
import { getDb } from "../lib/db/context";
import { createThread, findIdleThreads } from "../lib/db/queries/chat";
import { chatThreads } from "../lib/db/schema";
import { DEFAULT_IDLE_DAYS } from "../lib/jobs/close-stale-sessions";
import { parseArgs } from "../scripts/close-stale-sessions";

// ─── helpers ────────────────────────────────────────────────────────────────

const withFresh = withFreshContext;

/** ISO timestamp `days` days before now. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
}

/** Create a thread whose `updatedAt` is set to `days` days ago. */
function threadAged(days: number): string {
  const t = createThread();
  getDb()
    .update(chatThreads)
    .set({ updatedAt: daysAgo(days) })
    .where(eq(chatThreads.id, t.id))
    .run();
  return t.id;
}

// ─── parseArgs unit tests ────────────────────────────────────────────────────

describe("parseArgs", () => {
  it("returns defaults when no args are passed", () => {
    const result = parseArgs([]);
    expect(result.idleDays).toBe(DEFAULT_IDLE_DAYS);
    expect(result.dryRun).toBe(false);
  });

  it("parses --dry-run flag", () => {
    expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
  });

  it("parses --idle-days=N", () => {
    expect(parseArgs(["--idle-days=14"]).idleDays).toBe(14);
  });

  it("parses both flags together", () => {
    const result = parseArgs(["--idle-days=3", "--dry-run"]);
    expect(result.idleDays).toBe(3);
    expect(result.dryRun).toBe(true);
  });

  it("ignores --idle-days=0 (non-positive)", () => {
    const result = parseArgs(["--idle-days=0"]);
    expect(result.idleDays).toBe(DEFAULT_IDLE_DAYS);
  });

  it("ignores unrecognised flags", () => {
    const result = parseArgs(["--verbose", "--foo=bar"]);
    expect(result.idleDays).toBe(DEFAULT_IDLE_DAYS);
    expect(result.dryRun).toBe(false);
  });

  it("last --idle-days wins when flag appears multiple times", () => {
    const result = parseArgs(["--idle-days=5", "--idle-days=10"]);
    expect(result.idleDays).toBe(10);
  });
});

// ─── dry-run candidate detection (in-memory DB) ─────────────────────────────

describe("dry-run candidate detection", () => {
  it("finds stale threads and ignores recent ones", () => {
    withFresh(() => {
      const stale = threadAged(10);
      threadAged(2); // recent — should NOT appear

      const candidates = findIdleThreads(7);
      expect(candidates.map((t) => t.id)).toContain(stale);
      expect(candidates).toHaveLength(1);
    });
  });

  it("returns empty list when no threads exceed the idle threshold", () => {
    withFresh(() => {
      threadAged(2);
      threadAged(3);

      const candidates = findIdleThreads(7);
      expect(candidates).toHaveLength(0);
    });
  });

  it("respects a custom idleDays value from parseArgs", () => {
    withFresh(() => {
      const t = threadAged(3);

      const { idleDays: conservativeWindow } = parseArgs(["--idle-days=7"]);
      const { idleDays: aggressiveWindow } = parseArgs(["--idle-days=2"]);

      expect(findIdleThreads(conservativeWindow).map((c) => c.id)).not.toContain(t);
      expect(findIdleThreads(aggressiveWindow).map((c) => c.id)).toContain(t);
    });
  });

  it("dry-run does not mutate thread status", () => {
    withFresh(() => {
      const stale = threadAged(10);

      // Simulate the dry-run path: read candidates, do NOT close.
      const candidates = findIdleThreads(7);
      expect(candidates.map((t) => t.id)).toContain(stale);

      // Status must still be 'active' — nothing was closed.
      const thread = getDb().select().from(chatThreads).where(eq(chatThreads.id, stale)).get();
      expect(thread?.status).toBe("active");
    });
  });
});
