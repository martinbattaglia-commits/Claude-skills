import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { freshMarketDb } from "@/tests/db-helpers";
import { runWithDbContext } from "../db/context";
import type { Preference } from "../db/queries/preferences";
import { save } from "../db/queries/preferences";
import * as schema from "../db/schema";
import {
  buildMemoryBlock,
  INJECT_CONFIDENCE_THRESHOLD,
  memoryBlockHash,
  stripInjectedMemory,
  USER_CAP,
} from "./inject";

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
  const db = drizzle(sqlite, { schema });
  const market = freshMarketDb();
  return { sqlite, db, marketDb: market.db, marketSqlite: market.sqlite };
}

function withFresh<T>(fn: () => T): T {
  const { sqlite, db, marketDb, marketSqlite } = freshDb();
  return runWithDbContext(
    { appDb: db, appSqlite: sqlite, marketDb, marketSqlite, isDemo: true, sessionId: "test" },
    fn,
  ) as T;
}

// Build a stub Preference for the rows-override path (no DB).
function stub(over: Partial<Preference> & { id: number; content: string }): Preference {
  const now = "2026-05-22T00:00:00.000Z";
  return {
    userId: null,
    category: "user",
    detail: null,
    source: "advisor_tool",
    sourceSessionId: null,
    sourceTurnIds: null,
    confidence: null,
    supersededBy: null,
    lastConfirmedAt: null,
    validFrom: now,
    validUntil: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe("buildMemoryBlock", () => {
  it("returns the empty string when no active preferences exist", () => {
    withFresh(() => {
      expect(buildMemoryBlock(null)).toBe("");
      expect(memoryBlockHash(buildMemoryBlock(null))).toBe(memoryBlockHash(""));
    });
  });

  it("renders the 2-category markdown format with About you / How to respond headings", () => {
    withFresh(() => {
      save({ category: "user", content: "risk tolerance: moderate", source: "advisor_tool" });
      save({ category: "user", content: "wife's name is Sarah", source: "advisor_tool" });
      save({
        category: "advisor",
        content: "be concise; skip disclaimers",
        source: "advisor_tool",
      });

      const block = buildMemoryBlock(null);
      // Render order is fixed: user ("About you") then advisor ("How to respond"),
      // rows within a category by id ascending.
      expect(block).toBe(
        [
          "## Your stored preferences",
          "",
          "### About you",
          "- risk tolerance: moderate",
          "- wife's name is Sarah",
          "",
          "### How to respond",
          "- be concise; skip disclaimers",
        ].join("\n"),
      );
    });
  });

  it("is byte-identical across calls with the same DB state (cache-discipline guarantee)", () => {
    withFresh(() => {
      save({ category: "user", content: "risk tolerance: moderate", source: "advisor_tool" });
      save({ category: "user", content: "401k at Fidelity", source: "advisor_tool" });
      save({ category: "user", content: "Thai tax resident", source: "advisor_tool" });

      const a = buildMemoryBlock(null);
      const b = buildMemoryBlock(null);
      expect(a).toBe(b);
      expect(memoryBlockHash(a)).toBe(memoryBlockHash(b));
    });
  });

  it("orders rows within a category by id ascending regardless of insertion order quirks", () => {
    withFresh(() => {
      const r1 = save({
        category: "user",
        content: "z-last alphabetically",
        source: "advisor_tool",
      });
      const r2 = save({
        category: "user",
        content: "a-first alphabetically",
        source: "advisor_tool",
      });
      const block = buildMemoryBlock(null);
      const lines = block.split("\n").filter((l) => l.startsWith("- "));
      expect(lines).toEqual(["- z-last alphabetically", "- a-first alphabetically"]);
      expect(r1.id).toBeLessThan(r2.id);
    });
  });

  it("uses the rows override (no DB) and injects content, never detail", () => {
    const block = buildMemoryBlock(null, {
      rows: [stub({ id: 1, category: "user", content: "hook line", detail: "long elaboration" })],
    });
    expect(block).toBe(
      ["## Your stored preferences", "", "### About you", "- hook line"].join("\n"),
    );
    expect(block).not.toContain("long elaboration");
  });

  it("excludes low-confidence auto-extracted rows from the injected block", () => {
    withFresh(() => {
      save({ category: "user", content: "explicit fact", source: "advisor_tool" });
      save({
        category: "user",
        content: "high-conf extracted",
        source: "extracted",
        confidence: INJECT_CONFIDENCE_THRESHOLD,
      });
      save({
        category: "user",
        content: "low-conf extracted",
        source: "extracted",
        confidence: INJECT_CONFIDENCE_THRESHOLD - 0.1,
      });

      const block = buildMemoryBlock(null);
      expect(block).toContain("- explicit fact");
      expect(block).toContain("- high-conf extracted");
      expect(block).not.toContain("low-conf extracted");
    });
  });

  describe("the bound", () => {
    it("caps the injected hot-set at USER_CAP and appends an 'N more' line", () => {
      const rows = Array.from({ length: USER_CAP + 3 }, (_, i) =>
        stub({ id: i + 1, category: "user", content: `fact ${i + 1}` }),
      );
      const block = buildMemoryBlock(null, { rows });
      const bullets = block.split("\n").filter((l) => l.startsWith("- "));
      expect(bullets).toHaveLength(USER_CAP);
      expect(block).toContain(
        "_3 more memories are stored; use recall_preferences to look them up._",
      );
    });

    it("explicit rows outrank extracted ones at the cap (explicit-first)", () => {
      const explicit = Array.from({ length: USER_CAP }, (_, i) =>
        stub({ id: i + 1, category: "user", content: `explicit ${i + 1}`, confidence: null }),
      );
      const extracted = stub({
        id: USER_CAP + 1,
        category: "user",
        content: "extracted overflow",
        source: "extracted",
        confidence: 0.95,
      });
      const block = buildMemoryBlock(null, { rows: [...explicit, extracted] });
      // All explicit fit; the single extracted row is the one dropped to recall.
      expect(block).not.toContain("extracted overflow");
      expect(block).toContain("_1 more memory is stored");
    });

    it("respects the char budget (overflow by chars, not just count)", () => {
      const big = "x".repeat(11_000); // two (~22k) fit in 24k, the third overflows
      const rows = [1, 2, 3].map((id) => stub({ id, category: "user", content: `${id}:${big}` }));
      const block = buildMemoryBlock(null, { rows });
      const bullets = block.split("\n").filter((l) => l.startsWith("- "));
      expect(bullets).toHaveLength(2);
      expect(block).toContain("_1 more memory is stored");
    });

    it("no 'N more' line when nothing overflows", () => {
      const block = buildMemoryBlock(null, {
        rows: [stub({ id: 1, category: "user", content: "only one" })],
      });
      expect(block).not.toContain("more memor");
    });
  });
});

describe("stripInjectedMemory", () => {
  it("removes the injected block (including the 'N more' line), leaving surrounding text intact", () => {
    const block = [
      "## Your stored preferences",
      "",
      "### About you",
      "- risk tolerance: moderate",
      "",
      "_2 more memories are stored; use recall_preferences to look them up._",
    ].join("\n");
    const text = `${block}\n\nYou are Macrotide, an AI companion.`;
    expect(stripInjectedMemory(text)).toBe("You are Macrotide, an AI companion.");
  });

  it("is a no-op on text without an injected block", () => {
    const text = "User: what is an index fund?\n\nAdvisor: a basket of...";
    expect(stripInjectedMemory(text)).toBe(text);
  });

  it("does not consume real content that follows the block", () => {
    const text = [
      "## Your stored preferences",
      "",
      "### About you",
      "- owns NVDA",
      "",
      "User: hi",
    ].join("\n");
    expect(stripInjectedMemory(text)).toBe("User: hi");
  });
});
