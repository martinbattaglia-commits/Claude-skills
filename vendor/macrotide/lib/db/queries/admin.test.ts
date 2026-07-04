import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { freshMarketDb } from "@/tests/db-helpers";
import { type DbContext, runWithDbContext } from "../context";
import * as schema from "../schema";
import { accountTier, usage, user } from "../schema";
import { listUsers, setUserTier } from "./admin";

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

type Db = ReturnType<typeof freshDb>["db"];

function seedUser(db: Db, id: string, createdAt: Date) {
  db.insert(user)
    .values({
      id,
      name: id,
      email: `${id}@x.io`,
      emailVerified: true,
      createdAt,
      updatedAt: createdAt,
    })
    .run();
}

let sqlite: ReturnType<typeof freshDb>["sqlite"];
let db: Db;
let marketDb: ReturnType<typeof freshDb>["marketDb"];
let marketSqlite: ReturnType<typeof freshDb>["marketSqlite"];
let ctx: DbContext;

beforeEach(() => {
  ({ sqlite, db, marketDb, marketSqlite } = freshDb());
  ctx = {
    appDb: db,
    appSqlite: sqlite,
    marketDb,
    marketSqlite,
    isDemo: false,
    sessionId: "owner",
    userId: null,
  };
});

describe("listUsers", () => {
  it("returns all users with default 'public' tier and zero usage", () => {
    seedUser(db, "u1", new Date("2026-01-01"));
    seedUser(db, "u2", new Date("2026-01-02"));
    const rows = runWithDbContext(ctx, () => listUsers("2026-05-24")) as ReturnType<
      typeof listUsers
    >;
    expect(rows.map((r) => r.id)).toEqual(["u1", "u2"]); // ordered by createdAt
    expect(rows.every((r) => r.tier === "public")).toBe(true);
    expect(rows.every((r) => r.usageToday === 0)).toBe(true);
  });

  it("reflects explicit tier and today's usage via the joins", () => {
    seedUser(db, "u1", new Date("2026-01-01"));
    db.insert(accountTier)
      .values({ userId: "u1", tier: "trusted", grantedAt: new Date().toISOString() })
      .run();
    db.insert(usage)
      .values({ userId: "u1", date: "2026-05-24", inputTokens: 100, outputTokens: 50 })
      .run();
    // A usage row for a different date must NOT be counted.
    db.insert(usage)
      .values({ userId: "u1", date: "2026-05-23", inputTokens: 999, outputTokens: 999 })
      .run();
    const rows = runWithDbContext(ctx, () => listUsers("2026-05-24")) as ReturnType<
      typeof listUsers
    >;
    expect(rows[0].tier).toBe("trusted");
    expect(rows[0].usageToday).toBe(150);
  });
});

describe("setUserTier", () => {
  it("flips an existing user between public and trusted", () => {
    seedUser(db, "u1", new Date("2026-01-01"));
    const okUp = runWithDbContext(ctx, () => setUserTier("u1", "trusted")) as boolean;
    expect(okUp).toBe(true);
    expect((runWithDbContext(ctx, () => listUsers()) as ReturnType<typeof listUsers>)[0].tier).toBe(
      "trusted",
    );

    const okDown = runWithDbContext(ctx, () => setUserTier("u1", "public")) as boolean;
    expect(okDown).toBe(true);
    expect((runWithDbContext(ctx, () => listUsers()) as ReturnType<typeof listUsers>)[0].tier).toBe(
      "public",
    );
  });

  it("returns false for a non-existent user (no orphan row)", () => {
    const ok = runWithDbContext(ctx, () => setUserTier("ghost", "trusted")) as boolean;
    expect(ok).toBe(false);
    const count = db.select().from(accountTier).all().length;
    expect(count).toBe(0);
  });
});
