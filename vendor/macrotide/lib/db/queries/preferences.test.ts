import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { freshMarketDb } from "@/tests/db-helpers";
import { runWithDbContext } from "../context";
import * as schema from "../schema";
import {
  confirm,
  createLink,
  decayExtracted,
  forget,
  listActive,
  listLinks,
  listRecentlyForgotten,
  recall,
  restore,
  save,
  update,
  updateFromExtraction,
} from "./preferences";

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

describe("preferences queries", () => {
  it("save inserts an active row, listActive returns it", () => {
    withFresh(() => {
      const row = save({
        category: "user",
        content: "risk tolerance: moderate",
        source: "advisor_tool",
      });
      expect(row.validUntil).toBeNull();
      const active = listActive();
      expect(active).toHaveLength(1);
      expect(active[0].content).toBe("risk tolerance: moderate");
    });
  });

  it("save is idempotent on identical (category, content) — no duplicate row", () => {
    withFresh(() => {
      const a = save({
        category: "user",
        content: "funds only",
        source: "advisor_tool",
      });
      // Re-saving the same fact (e.g. the frozen-session blind spot) returns the
      // existing row instead of piling up duplicates. Case/whitespace-insensitive.
      const b = save({
        category: "user",
        content: "  Funds Only ",
        source: "advisor_tool",
      });
      expect(b.id).toBe(a.id);
      expect(listActive("user")).toHaveLength(1);
      // A genuinely different fact in the same category still inserts.
      save({ category: "user", content: "no crypto", source: "advisor_tool" });
      expect(listActive("user")).toHaveLength(2);
    });
  });

  it("listActive filters by category and orders by category then id", () => {
    withFresh(() => {
      save({ category: "user", content: "p1", source: "advisor_tool" });
      save({ category: "advisor", content: "r1", source: "advisor_tool" });
      save({ category: "user", content: "p2", source: "advisor_tool" });
      const profile = listActive("user");
      expect(profile.map((r) => r.content)).toEqual(["p1", "p2"]);
      const all = listActive();
      // Ordered by (category, id): advisor sorts before user.
      expect(all.map((r) => r.category)).toEqual(["advisor", "user", "user"]);
    });
  });

  it("forget sets validUntil; row drops from active, shows in recently-forgotten", () => {
    withFresh(() => {
      const r = save({
        category: "user",
        content: "wife: Sarah",
        source: "advisor_tool",
      });
      const result = forget(String(r.id));
      expect(result.kind).toBe("match");
      expect(result.row?.validUntil).toBeTruthy();
      expect(listActive()).toHaveLength(0);
      expect(listRecentlyForgotten()).toHaveLength(1);
    });
  });

  it("forget by substring matches single active row; ambiguous when multiple match", () => {
    withFresh(() => {
      save({ category: "user", content: "owns NVDA shares", source: "advisor_tool" });
      const single = forget("NVDA");
      expect(single.kind).toBe("match");

      save({ category: "user", content: "loves cats", source: "advisor_tool" });
      save({ category: "user", content: "owns three cats", source: "advisor_tool" });
      const ambiguous = forget("cats");
      expect(ambiguous.kind).toBe("ambiguous");
      expect(ambiguous.candidates).toHaveLength(2);
    });
  });

  it("update supersedes the old row and inserts a new active row in one txn", () => {
    withFresh(() => {
      const orig = save({
        category: "user",
        content: "retirement age: 50",
        source: "advisor_tool",
      });
      const result = update(String(orig.id), "retirement age: 55");
      expect(result.kind).toBe("match");
      expect(result.oldRow?.validUntil).toBeTruthy();
      expect(result.newRow?.content).toBe("retirement age: 55");
      expect(result.newRow?.validUntil).toBeNull();
      expect(listActive()).toHaveLength(1);
      expect(listActive()[0].id).toBe(result.newRow?.id);
    });
  });

  it("restore clears validUntil on a recently-forgotten row", () => {
    withFresh(() => {
      const r = save({ category: "user", content: "temp", source: "advisor_tool" });
      forget(String(r.id));
      expect(listActive()).toHaveLength(0);
      const restored = restore(r.id);
      expect(restored?.validUntil).toBeNull();
      expect(listActive()).toHaveLength(1);
    });
  });

  it("restore is a no-op on an already-active row", () => {
    withFresh(() => {
      const r = save({ category: "user", content: "stays", source: "advisor_tool" });
      const result = restore(r.id);
      expect(result).toBeUndefined();
      expect(listActive()).toHaveLength(1);
    });
  });
});

describe("recall (FTS5 + BM25)", () => {
  it("returns active rows matching any query token (case-insensitive, OR-joined)", () => {
    withFresh(() => {
      save({ category: "user", content: "tax: files jointly in Thailand", source: "advisor_tool" });
      save({ category: "user", content: "retirement age: 55", source: "advisor_tool" });
      save({ category: "user", content: "owns a dog", source: "advisor_tool" });

      const tax = recall("TAX situation");
      expect(tax.rows.map((r) => r.content)).toEqual(["tax: files jointly in Thailand"]);

      // Tokens are OR'd, so an unrelated extra word still recalls.
      const or = recall("retirement crypto");
      expect(or.rows.map((r) => r.content)).toEqual(["retirement age: 55"]);
    });
  });

  it("searches detail as well as content", () => {
    withFresh(() => {
      save({
        category: "user",
        content: "avoid US-domiciled ETFs",
        detail: "because of PFIC tax rules as a Thai resident",
        source: "advisor_tool",
      });
      expect(recall("PFIC").rows.map((r) => r.content)).toEqual(["avoid US-domiciled ETFs"]);
    });
  });

  it("excludes forgotten (inactive) rows", () => {
    withFresh(() => {
      const r = save({
        category: "user",
        content: "wants quarterly rebalancing",
        source: "advisor_tool",
      });
      expect(recall("rebalancing").rows).toHaveLength(1);
      forget(String(r.id));
      expect(recall("rebalancing").rows).toHaveLength(0);
    });
  });

  it("returns no rows for blank / punctuation-only queries and on no match", () => {
    withFresh(() => {
      save({ category: "user", content: "likes index funds", source: "advisor_tool" });
      expect(recall("   ")).toEqual({ rows: [], total: 0 });
      expect(recall("!!!")).toEqual({ rows: [], total: 0 });
      expect(recall("bitcoin").rows).toEqual([]);
    });
  });

  it("reports total and respects the limit (truncation signal)", () => {
    withFresh(() => {
      save({ category: "user", content: "alpha keyword", source: "advisor_tool" });
      save({ category: "user", content: "beta keyword", source: "advisor_tool" });
      const all = recall("keyword");
      expect(all.rows).toHaveLength(2);
      expect(all.total).toBe(2);
      const limited = recall("keyword", 1);
      expect(limited.rows).toHaveLength(1);
      expect(limited.total).toBe(2); // total reflects all matches, not the page
    });
  });
});

// Fail-closed per-user scoping (ADR 0006 §5): a logged-in user sees only their
// own notes — never another user's, never the legacy NULL-owned owner set.
describe("cross-user isolation", () => {
  it("scopes every read to the request user", () => {
    const { sqlite, db, marketDb, marketSqlite } = freshDb();
    const now = new Date();
    db.insert(schema.user)
      .values([
        {
          id: "A",
          name: "A",
          email: "a@example.test",
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "B",
          name: "B",
          email: "b@example.test",
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    const base = {
      appDb: db,
      appSqlite: sqlite,
      marketDb,
      marketSqlite,
      isDemo: false,
      sessionId: "test",
    };
    const as = (userId: string | null, fn: () => void) => runWithDbContext({ ...base, userId }, fn);

    as(null, () =>
      save({ category: "user", content: "legacy owner note", source: "advisor_tool" }),
    );
    as("A", () => save({ category: "user", content: "A's note", source: "advisor_tool" }));
    as("B", () => save({ category: "user", content: "B's note", source: "advisor_tool" }));

    as("A", () => {
      const rows = listActive();
      expect(rows.map((r) => r.content)).toEqual(["A's note"]);
      // A cannot see, recall, or forget B's note or the NULL owner note.
      expect(recall("note").rows.map((r) => r.content)).toEqual(["A's note"]);
      expect(forget("B's note").kind).toBe("none");
      expect(forget("legacy owner note").kind).toBe("none");
    });
    as("B", () => {
      expect(listActive().map((r) => r.content)).toEqual(["B's note"]);
    });
    as(null, () => {
      expect(listActive().map((r) => r.content)).toEqual(["legacy owner note"]);
    });
  });
});

describe("confirm", () => {
  it("stamps last_confirmed_at (the anti-stale reinforcement signal)", () => {
    withFresh(() => {
      const r = save({ category: "user", content: "no crypto", source: "advisor_tool" });
      expect(r.lastConfirmedAt).toBeNull();
      const result = confirm(String(r.id));
      expect(result.kind).toBe("match");
      expect(result.row?.lastConfirmedAt).toBeTruthy();
    });
  });
});

describe("superseded_by — edit-history vs forget (⑦)", () => {
  it("an update's old row is superseded (not a forget) and stays out of recently-forgotten", () => {
    withFresh(() => {
      const orig = save({
        category: "user",
        content: "retirement age: 50",
        source: "advisor_tool",
      });
      const res = update(String(orig.id), "retirement age: 55");
      expect(res.oldRow?.supersededBy).toBe(res.newRow?.id);
      // The old version is edit-history, not a deliberate forget → not in the undo queue.
      expect(listRecentlyForgotten()).toHaveLength(0);
    });
  });

  it("a deliberate forget leaves superseded_by NULL and shows in recently-forgotten", () => {
    withFresh(() => {
      const r = save({ category: "user", content: "temp fact", source: "advisor_tool" });
      forget(String(r.id));
      const forgotten = listRecentlyForgotten();
      expect(forgotten).toHaveLength(1);
      expect(forgotten[0].supersededBy).toBeNull();
    });
  });

  it("restore revives a forgotten row but refuses a superseded one (no double-activate)", () => {
    withFresh(() => {
      const r = save({ category: "user", content: "keep me", source: "advisor_tool" });
      forget(String(r.id));
      expect(restore(r.id)?.validUntil).toBeNull();

      // A superseded row cannot be restored (its successor is live).
      const orig = save({ category: "user", content: "v1", source: "advisor_tool" });
      const res = update(String(orig.id), "v2");
      expect(restore(orig.id)).toBeUndefined();
      expect(listActive().some((x) => x.id === res.newRow?.id)).toBe(true);
    });
  });
});

describe("updateFromExtraction trust-tier guard", () => {
  it("supersedes an extracted row but refuses to override an explicit one", () => {
    withFresh(() => {
      const extracted = save({
        category: "user",
        content: "risk tolerance: moderate",
        source: "extracted",
        confidence: 0.8,
      });
      const ok = updateFromExtraction(extracted.id, "risk tolerance: aggressive", 0.85);
      expect(ok.ok).toBe(true);
      expect(listActive().map((r) => r.content)).toEqual(["risk tolerance: aggressive"]);

      const explicit = save({
        category: "user",
        content: "funds only, no individual stocks",
        source: "advisor_tool",
      });
      const rejected = updateFromExtraction(explicit.id, "individual stocks are fine now", 0.9);
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.rejected).toBe("not_extracted");
      // The explicit note is untouched.
      expect(listActive().some((r) => r.content === "funds only, no individual stocks")).toBe(true);
    });
  });
});

describe("memory links", () => {
  it("lists live links, re-points on supersede, and drops a forgotten target", () => {
    withFresh(() => {
      const a = save({ category: "user", content: "A", source: "advisor_tool" });
      const b = save({ category: "user", content: "B", source: "advisor_tool" });
      createLink(a.id, b.id, "relates_to");
      expect(listLinks(a.id).map((l) => l.preference.content)).toEqual(["B"]);

      // Superseding A re-points the link to the new row.
      const upd = update(String(a.id), "A2");
      const newAId = upd.newRow?.id as number;
      expect(listLinks(newAId).map((l) => l.preference.content)).toEqual(["B"]);

      // Forgetting B (the target) drops it from the validity-aware read.
      forget(String(b.id));
      expect(listLinks(newAId)).toEqual([]);
    });
  });
});

describe("decayExtracted", () => {
  it("decays unconfirmed extracted rows but leaves explicit and confirmed ones", () => {
    withFresh(() => {
      const extracted = save({
        category: "user",
        content: "likes gold",
        source: "extracted",
        confidence: 0.9,
      });
      const explicit = save({ category: "user", content: "explicit", source: "advisor_tool" });
      const confirmed = save({
        category: "user",
        content: "confirmed extracted",
        source: "extracted",
        confidence: 0.9,
      });
      confirm(String(confirmed.id));

      const n = decayExtracted({ step: 0.1, minAgeDays: 0 });
      expect(n).toBe(1);
      const byContent = (c: string) => listActive().find((r) => r.content === c);
      expect(byContent("likes gold")?.confidence).toBeCloseTo(0.8);
      expect(byContent("explicit")?.confidence).toBeNull();
      expect(byContent("confirmed extracted")?.confidence).toBe(0.9);
      void extracted;
      void explicit;
    });
  });
});
