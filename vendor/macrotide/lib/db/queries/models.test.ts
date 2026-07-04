import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { freshMarketDb } from "@/tests/db-helpers";
import { runWithDbContext } from "../context";
import * as schema from "../schema";
import { modelPortfolios, user } from "../schema";
import {
  createModelPortfolio,
  deleteModelPortfolio,
  getModelPortfolio,
  listModelPortfolios,
  updateModelPortfolio,
} from "./models";

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
  // Seed users referenced by user-owned model_portfolios (user_id FK).
  for (const id of ["alice", "bob"]) {
    db.insert(user)
      .values({
        id,
        name: id,
        email: `${id}@test.local`,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
  }
  const market = freshMarketDb();
  return { sqlite, db, marketDb: market.db, marketSqlite: market.sqlite };
}

/** Run `fn` with a fresh in-memory DB as the given user (null = single-owner). */
function withUser<T>(userId: string | null, db: ReturnType<typeof freshDb>, fn: () => T): T {
  return runWithDbContext(
    {
      appDb: db.db,
      appSqlite: db.sqlite,
      marketDb: db.marketDb,
      marketSqlite: db.marketSqlite,
      isDemo: true,
      sessionId: "test",
      userId,
    },
    fn,
  ) as T;
}

/** Insert a built-in (shared, NULL-owned) model directly. */
function seedBuiltIn(db: ReturnType<typeof freshDb>, id: string) {
  db.db
    .insert(modelPortfolios)
    .values({
      id,
      userId: null,
      name: "Built-in",
      builtIn: true,
      allocation: [{ label: "Equity", pct: 100, color: "var(--accent)" }],
      createdAt: new Date().toISOString(),
    })
    .run();
}

describe("model portfolio ownership", () => {
  it("a logged-in user can read built-ins but cannot update them (fail-closed)", () => {
    const db = freshDb();
    seedBuiltIn(db, "bi1");
    withUser("alice", db, () => {
      // Readable
      expect(getModelPortfolio("bi1")?.id).toBe("bi1");
      // Update is a no-op — strict ownership excludes shared NULL-owned rows
      const updated = updateModelPortfolio("bi1", { name: "Hacked" });
      expect(updated).toBeUndefined();
      expect(getModelPortfolio("bi1")?.name).toBe("Built-in");
    });
  });

  it("a logged-in user cannot delete a built-in", () => {
    const db = freshDb();
    seedBuiltIn(db, "bi2");
    withUser("alice", db, () => {
      deleteModelPortfolio("bi2");
      expect(getModelPortfolio("bi2")?.id).toBe("bi2");
    });
  });

  it("duplicate-to-customize forks a built-in into a user-owned, editable copy", () => {
    const db = freshDb();
    seedBuiltIn(db, "bi3");
    withUser("alice", db, () => {
      const original = getModelPortfolio("bi3");
      const copy = createModelPortfolio({
        id: "copy1",
        name: `${original?.name} (copy)`,
        builtIn: false,
        allocation: original?.allocation ?? [],
      });
      // Owned by alice and not a built-in
      expect(copy.userId).toBe("alice");
      expect(copy.builtIn).toBe(false);
      // The fork IS editable in place
      const edited = updateModelPortfolio("copy1", { name: "My Mix" });
      expect(edited?.name).toBe("My Mix");
      // The shared original is untouched
      expect(getModelPortfolio("bi3")?.name).toBe("Built-in");
    });
  });

  it("a user only sees their own models plus shared built-ins, not other users' rows", () => {
    const db = freshDb();
    seedBuiltIn(db, "bi4");
    withUser("alice", db, () =>
      createModelPortfolio({
        id: "a1",
        name: "Alice mix",
        builtIn: false,
        allocation: [],
      }),
    );
    withUser("bob", db, () =>
      createModelPortfolio({
        id: "b1",
        name: "Bob mix",
        builtIn: false,
        allocation: [],
      }),
    );
    const aliceIds = withUser("alice", db, () =>
      listModelPortfolios()
        .map((m) => m.id)
        .sort(),
    );
    expect(aliceIds).toEqual(["a1", "bi4"]);
  });

  it("single-owner mode (no user) can edit and delete its own NULL-owned models", () => {
    const db = freshDb();
    withUser(null, db, () => {
      const m = createModelPortfolio({ id: "s1", name: "Solo", builtIn: false, allocation: [] });
      expect(m.userId).toBeNull();
      expect(updateModelPortfolio("s1", { name: "Solo 2" })?.name).toBe("Solo 2");
      deleteModelPortfolio("s1");
      expect(getModelPortfolio("s1")).toBeUndefined();
    });
  });
});
