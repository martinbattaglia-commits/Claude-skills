// Per-user plans: each user has an independent plan row; single-owner mode
// (userId null) keeps a single NULL-owned plan row. upsertPlan no longer
// collides on a fixed id=1 — a second user's save can't clobber the first's.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { freshMarketDb } from "@/tests/db-helpers";
import { type DbContext, runWithDbContext } from "../context";
import * as schema from "../schema";
import { user } from "../schema";
import { getPlan, upsertPlan } from "./plan";

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

function seedUsers(db: ReturnType<typeof freshDb>["db"]) {
  const now = new Date();
  db.insert(user)
    .values([
      {
        id: "u1",
        name: "U1",
        email: "u1@x.io",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "u2",
        name: "U2",
        email: "u2@x.io",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .run();
}

describe("per-user plans", () => {
  it("single-owner (null context): one NULL-owned plan, upsert updates in place", () => {
    const { sqlite, db, marketDb, marketSqlite } = freshDb();
    const ctx: DbContext = {
      appDb: db,
      appSqlite: sqlite,
      marketDb,
      marketSqlite,
      isDemo: false,
      sessionId: "owner",
      userId: null,
    };
    runWithDbContext(ctx, () => {
      expect(getPlan()).toBeUndefined();
      const created = upsertPlan({ markdown: "v1" });
      expect(created.userId).toBeNull();
      expect(created.markdown).toBe("v1");

      const updated = upsertPlan({ markdown: "v2", selectedModelId: "m" });
      expect(updated.id).toBe(created.id); // same row, updated in place
      expect(updated.markdown).toBe("v2");
      expect(updated.selectedModelId).toBe("m");

      expect(getPlan()?.markdown).toBe("v2");
      expect(db.select().from(schema.plans).all()).toHaveLength(1);
    });
  });

  it("two users have independent plans; one cannot overwrite the other", () => {
    const { sqlite, db, marketDb, marketSqlite } = freshDb();
    seedUsers(db);
    const asU1: DbContext = {
      appDb: db,
      appSqlite: sqlite,
      marketDb,
      marketSqlite,
      isDemo: false,
      sessionId: "s",
      userId: "u1",
    };
    const asU2: DbContext = {
      appDb: db,
      appSqlite: sqlite,
      marketDb,
      marketSqlite,
      isDemo: false,
      sessionId: "s",
      userId: "u2",
    };

    runWithDbContext(asU1, () => {
      expect(upsertPlan({ markdown: "u1 plan" }).userId).toBe("u1");
    });
    runWithDbContext(asU2, () => {
      // u2's save must NOT clobber u1's (the old fixed id=1 bug).
      expect(upsertPlan({ markdown: "u2 plan" }).userId).toBe("u2");
    });

    runWithDbContext(asU1, () => {
      expect(getPlan()?.markdown).toBe("u1 plan");
    });
    runWithDbContext(asU2, () => {
      expect(getPlan()?.markdown).toBe("u2 plan");
    });

    // Two distinct rows persisted.
    expect(db.select().from(schema.plans).all()).toHaveLength(2);
  });

  it("a logged-in user does not see the NULL-owned (single-owner) plan", () => {
    const { sqlite, db, marketDb, marketSqlite } = freshDb();
    seedUsers(db);
    const asNull: DbContext = {
      appDb: db,
      appSqlite: sqlite,
      marketDb,
      marketSqlite,
      isDemo: false,
      sessionId: "s",
      userId: null,
    };
    const asU1: DbContext = {
      appDb: db,
      appSqlite: sqlite,
      marketDb,
      marketSqlite,
      isDemo: false,
      sessionId: "s",
      userId: "u1",
    };

    runWithDbContext(asNull, () => upsertPlan({ markdown: "legacy" }));
    runWithDbContext(asU1, () => {
      expect(getPlan()).toBeUndefined();
      upsertPlan({ markdown: "u1 plan" });
      expect(getPlan()?.markdown).toBe("u1 plan");
    });
    // Legacy NULL row untouched.
    runWithDbContext(asNull, () => {
      expect(getPlan()?.markdown).toBe("legacy");
    });
  });
});
