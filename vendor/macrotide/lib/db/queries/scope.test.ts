// Per-user scoping invariant. These lock in the FAIL-CLOSED contract the
// multi-user data layer builds on:
//   - With NO user in context (single-owner / pre-auth), behavior is identical
//     to single-owner mode: the NULL-owned row set is visible/writable.
//   - With a user in context, that user sees ONLY their own rows — NOT another
//     user's rows and NOT arbitrary NULL-owned rows. Genuinely-shared rows
//     (the built-in model library) stay visible because the read opts into
//     them explicitly via `ownedBy(..., { alsoWhere: builtIn = true })`.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { freshMarketDb } from "@/tests/db-helpers";
import { type DbContext, runWithDbContext } from "../context";
import * as schema from "../schema";
import { user } from "../schema";
import { createBucket, listBuckets } from "./buckets";
import { createModelPortfolio, listModelPortfolios } from "./models";

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

const BUCKET = {
  id: "b",
  name: "B",
  typeLabel: null,
  icon: null,
  color: null,
  brokerage: "FNDQ",
  notes: null,
  goalText: null,
  targetModelId: null,
  targetAllocation: null,
};

describe("per-user row scoping (fail-closed)", () => {
  it("null context behaves like single-owner: NULL-owned rows visible", () => {
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
      const created = createBucket(BUCKET);
      expect(created.userId).toBeNull();
      expect(listBuckets()).toHaveLength(1);
    });
  });

  it("a logged-in user sees ONLY their own rows — not shared NULL rows, not others'", () => {
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
    const asU2: DbContext = {
      appDb: db,
      appSqlite: sqlite,
      marketDb,
      marketSqlite,
      isDemo: false,
      sessionId: "s",
      userId: "u2",
    };

    // A NULL-owned (pre-backfill) row + one row per user.
    runWithDbContext(asNull, () => createBucket({ ...BUCKET, id: "shared", name: "Shared" }));
    runWithDbContext(asU1, () => createBucket({ ...BUCKET, id: "b1", name: "B1" }));
    runWithDbContext(asU2, () => createBucket({ ...BUCKET, id: "b2", name: "B2" }));

    runWithDbContext(asU1, () => {
      expect(createBucket({ ...BUCKET, id: "b1b", name: "B1b" }).userId).toBe("u1");
      const ids = listBuckets()
        .map((b) => b.id)
        .sort();
      // u1's own rows ONLY — NOT the NULL-owned "shared" row, NOT u2's "b2".
      expect(ids).toEqual(["b1", "b1b"]);
    });
  });

  it("a second user cannot see the first user's rows", () => {
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

    runWithDbContext(asU1, () => createBucket({ ...BUCKET, id: "b1", name: "B1" }));
    runWithDbContext(asU2, () => createBucket({ ...BUCKET, id: "b2", name: "B2" }));

    runWithDbContext(asU2, () => {
      const ids = listBuckets()
        .map((b) => b.id)
        .sort();
      expect(ids).toEqual(["b2"]); // u1's "b1" is invisible to u2
    });
    runWithDbContext(asU1, () => {
      expect(listBuckets().map((b) => b.id)).toEqual(["b1"]);
    });
  });

  it("built-in (shared, NULL-owned) model portfolios stay visible to a logged-in user", () => {
    const { sqlite, db, marketDb, marketSqlite } = freshDb();
    seedUsers(db);
    const now = new Date().toISOString();
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
    const asU2: DbContext = {
      appDb: db,
      appSqlite: sqlite,
      marketDb,
      marketSqlite,
      isDemo: false,
      sessionId: "s",
      userId: "u2",
    };

    const base = { allocation: [], createdAt: now };
    // Built-in: null-owned + built_in = true (the genuinely-shared library).
    runWithDbContext(asNull, () =>
      createModelPortfolio({ id: "bi", name: "Builtin", builtIn: true, ...base }),
    );
    // A null-owned but NON-built-in row must NOT leak to logged-in users.
    runWithDbContext(asNull, () =>
      createModelPortfolio({ id: "orphan", name: "Orphan", builtIn: false, ...base }),
    );
    runWithDbContext(asU1, () =>
      createModelPortfolio({ id: "m1", name: "U1 model", builtIn: false, ...base }),
    );
    runWithDbContext(asU2, () =>
      createModelPortfolio({ id: "m2", name: "U2 model", builtIn: false, ...base }),
    );

    runWithDbContext(asU1, () => {
      const ids = listModelPortfolios()
        .map((m) => m.id)
        .sort();
      // Own model + the built-in — NOT the orphan null row, NOT u2's model.
      expect(ids).toEqual(["bi", "m1"]);
    });

    runWithDbContext(asNull, () => {
      // Single-owner still sees the full NULL set (built-in + orphan), not user rows.
      const ids = listModelPortfolios()
        .map((m) => m.id)
        .sort();
      expect(ids).toEqual(["bi", "orphan"]);
    });
  });
});
