import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { freshMarketDb } from "@/tests/db-helpers";
import { runWithDbContext } from "../db/context";
import {
  getById,
  listActive,
  type Preference,
  type PreferenceCategory,
  save,
} from "../db/queries/preferences";
import * as schema from "../db/schema";
import type { ConsolidationOp } from "../memory/consolidate";
import { consolidateMemory, findNearDupClusters } from "./consolidate-memory";

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const dir = resolve("lib/db/migrations/app");
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
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

const longContent = (prefix: string) => `${prefix} ${"x".repeat(9000)}`;

describe("findNearDupClusters", () => {
  it("groups lexically-similar rows, ignores distinct ones", () => {
    const rows = [
      { id: 1, content: "be concise" },
      { id: 2, content: "be concise please" },
      { id: 3, content: "I am a Thai tax resident" },
    ] as Preference[];
    const clusters = findNearDupClusters(rows, 0.5);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].map((r) => r.id).sort()).toEqual([1, 2]);
  });
});

describe("consolidateMemory", () => {
  it("sends the WHOLE category to the model (holistic — no lexical gate)", async () => {
    await withFresh(async () => {
      const a = save({ category: "user", content: "be concise", source: "advisor_tool" });
      const b = save({ category: "user", content: "Thai tax resident", source: "advisor_tool" });
      let received: number[] = [];
      const propose = async (_c: PreferenceCategory, rows: Preference[]) => {
        received = rows.map((r) => r.id).sort((x, y) => x - y);
        return [];
      };
      const res = await consolidateMemory({ scopes: [null], propose });
      // Even with nothing that lexically clusters, both memories reach the model.
      expect(received).toEqual([a.id, b.id]);
      expect(res.scopesWorked).toBe(1);
      expect(res.mergedCount).toBe(0);
    });
  });

  it("flags a degraded model chain — every call unparseable → parseFailures === modelCalls", async () => {
    await withFresh(async () => {
      save({ category: "user", content: "be concise", source: "advisor_tool" });
      save({ category: "user", content: "Thai tax resident", source: "advisor_tool" });
      // The proposer returns null when the model was invoked but never parsed.
      const propose = async (): Promise<ConsolidationOp[] | null> => null;
      const res = await consolidateMemory({ scopes: [null], propose });
      expect(res.modelCalls).toBeGreaterThan(0);
      expect(res.parseFailures).toBe(res.modelCalls); // the CLI exits non-zero on this
      expect(res.mergedCount).toBe(0);
    });
  });

  it("a valid (even empty) result is NOT a parse-failure", async () => {
    await withFresh(async () => {
      save({ category: "user", content: "be concise", source: "advisor_tool" });
      save({ category: "user", content: "Thai tax resident", source: "advisor_tool" });
      const propose = async (): Promise<ConsolidationOp[]> => [];
      const res = await consolidateMemory({ scopes: [null], propose });
      expect(res.modelCalls).toBeGreaterThan(0);
      expect(res.parseFailures).toBe(0);
    });
  });

  it("merges a near-dup that does NOT lexically cluster (the holistic win)", async () => {
    await withFresh(async () => {
      // Jaccard 0.375 — below the old 0.5 cluster threshold, so the old gate skipped
      // the model entirely. Holistically the model sees both and can merge them.
      const explicit = save({
        category: "user",
        content: "no individual stocks, funds only",
        source: "advisor_tool",
      });
      const extracted = save({
        category: "user",
        content: "I told you no individual stocks",
        source: "extracted",
        confidence: 0.98,
      });
      expect(findNearDupClusters([explicit, extracted])).toHaveLength(0); // proves the gap
      const propose = async (): Promise<ConsolidationOp[]> => [
        { op: "merge", ids: [explicit.id, extracted.id] },
      ];
      const res = await consolidateMemory({ scopes: [null], propose });
      expect(res.mergedCount).toBe(1);
      expect(listActive().map((r) => r.id)).toEqual([explicit.id]);
      expect(getById(extracted.id)?.supersededBy).toBe(explicit.id);
    });
  });

  it("falls back to lexical-cluster batches when the payload exceeds the budget", async () => {
    await withFresh(async () => {
      const a = save({ category: "user", content: "be concise", source: "advisor_tool" });
      const b = save({ category: "user", content: "be concise please", source: "advisor_tool" });
      const c = save({ category: "user", content: "Thai tax resident", source: "advisor_tool" });
      const batches: number[][] = [];
      const propose = async (_c: PreferenceCategory, rows: Preference[]) => {
        batches.push(rows.map((r) => r.id).sort((x, y) => x - y));
        return [];
      };
      // A tiny budget forces the scale fallback → only the near-dup CLUSTER [a,b] is
      // sent; the singleton c is dropped (the scale-path limitation).
      await consolidateMemory({ scopes: [null], propose, maxPayloadChars: 1 });
      expect(batches).toEqual([[a.id, b.id]]);
      expect(batches.flat()).not.toContain(c.id);
    });
  });

  it("consolidates a near-duplicate even in a SMALL store", async () => {
    await withFresh(async () => {
      // Mirrors the real bug: an explicit save + a session-close extraction of the
      // same fact, different wording — a near-dup well under any size ceiling.
      const explicit = save({
        category: "user",
        content: "no individual stocks, funds only",
        source: "advisor_tool",
      });
      const extracted = save({
        category: "user",
        content: "I only invest in funds, no individual stocks",
        source: "extracted",
        confidence: 0.98,
      });
      const propose = async (): Promise<ConsolidationOp[]> => [
        { op: "merge", ids: [explicit.id, extracted.id] },
      ];
      const res = await consolidateMemory({ scopes: [null], propose });
      expect(res.scopesWorked).toBe(1);
      expect(res.mergedCount).toBe(1);
      // The explicit memory survives; the extracted near-dup is folded in.
      expect(listActive().map((r) => r.id)).toEqual([explicit.id]);
      expect(getById(extracted.id)?.supersededBy).toBe(explicit.id);
    });
  });

  it("supersedes a stale extracted note when a newer one contradicts it", async () => {
    await withFresh(async () => {
      // Two notes about the SAME attribute that conflict — they cluster lexically
      // (shared subject tokens), so the contradiction reaches the model.
      const stale = save({
        category: "user",
        content: "risk tolerance: moderate",
        source: "extracted",
        confidence: 0.8,
      });
      const current = save({
        category: "user",
        content: "risk tolerance: aggressive",
        source: "extracted",
        confidence: 0.9,
      });
      const propose = async (): Promise<ConsolidationOp[]> => [
        { op: "supersede", staleId: stale.id, currentId: current.id },
      ];
      const res = await consolidateMemory({ scopes: [null], propose });
      expect(res.supersededCount).toBe(1);
      // The stale note is retired (reversibly); the current one stands.
      expect(listActive().map((r) => r.id)).toEqual([current.id]);
      expect(getById(stale.id)?.supersededBy).toBe(current.id);
    });
  });

  it("refuses to retire an EXPLICIT note via supersede (explicit-protected)", async () => {
    await withFresh(async () => {
      const explicit = save({
        category: "user",
        content: "risk tolerance: moderate",
        source: "advisor_tool",
      });
      const extracted = save({
        category: "user",
        content: "risk tolerance: aggressive",
        source: "extracted",
        confidence: 0.9,
      });
      // The model wrongly proposes retiring the EXPLICIT note — must be rejected:
      // an inference can never retire a user-stated fact.
      const propose = async (): Promise<ConsolidationOp[]> => [
        { op: "supersede", staleId: explicit.id, currentId: extracted.id },
      ];
      const res = await consolidateMemory({ scopes: [null], propose });
      expect(res.supersededCount).toBe(0);
      // Both remain active — the explicit note can't be retired by automation.
      expect(
        listActive()
          .map((r) => r.id)
          .sort((a, b) => a - b),
      ).toEqual([explicit.id, extracted.id].sort((a, b) => a - b));
    });
  });

  it("merges near-duplicates with long content (loser superseded into survivor)", async () => {
    await withFresh(async () => {
      // Long content, still under the holistic payload budget → sent whole.
      const a = save({
        category: "user",
        content: longContent("be concise"),
        source: "advisor_tool",
      });
      const b = save({
        category: "user",
        content: longContent("be concise please"),
        source: "advisor_tool",
      });
      save({ category: "user", content: longContent("Thai tax resident"), source: "advisor_tool" });

      const propose = async (): Promise<ConsolidationOp[]> => [{ op: "merge", ids: [a.id, b.id] }];
      const res = await consolidateMemory({ scopes: [null], propose });
      expect(res.scopesWorked).toBe(1);
      expect(res.mergedCount).toBe(1);
      // b is merged away → not active, superseded_by points at the survivor.
      expect(listActive().some((r) => r.id === b.id)).toBe(false);
      expect(getById(b.id)?.supersededBy).toBe(a.id);
    });
  });

  it("explicit-protects the survivor: an extracted survivor is overridden by an explicit loser", async () => {
    await withFresh(async () => {
      const extracted = save({
        category: "user",
        content: longContent("risk tolerance moderate"),
        source: "extracted",
        confidence: 0.8,
      });
      const explicit = save({
        category: "user",
        content: longContent("risk tolerance moderate indeed"),
        source: "advisor_tool",
      });
      save({ category: "user", content: longContent("likes gold"), source: "advisor_tool" });

      // Model wrongly picks the extracted row as survivor; apply must flip it.
      const propose = async (): Promise<ConsolidationOp[]> => [
        { op: "merge", ids: [extracted.id, explicit.id] },
      ];
      await consolidateMemory({ scopes: [null], propose });
      // The explicit row survives; the extracted one is merged away.
      expect(listActive().some((r) => r.id === explicit.id)).toBe(true);
      expect(getById(extracted.id)?.supersededBy).toBe(explicit.id);
    });
  });
});
