// New-user provisioning: a freshly-created user gets a default
// 'public' account_tier row and one seeded bucket stamped with their user_id.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { freshMarketDb } from "@/tests/db-helpers";
import { type DbContext, runWithDbContext } from "../db/context";
import { listBuckets } from "../db/queries/buckets";
import * as schema from "../db/schema";
import { accountTier, user } from "../db/schema";
import { provisionNewUser } from "./provision";

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

function seedUser(db: ReturnType<typeof freshDb>["db"], id: string) {
  const now = new Date();
  db.insert(user)
    .values({
      id,
      name: id,
      email: `${id}@x.io`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe("provisionNewUser", () => {
  it("inserts a default 'public' account_tier row and seeds one owned bucket", () => {
    const { sqlite, db, marketDb, marketSqlite } = freshDb();
    seedUser(db, "u1");
    const ctx: DbContext = {
      appDb: db,
      appSqlite: sqlite,
      marketDb,
      marketSqlite,
      isDemo: false,
      sessionId: "owner",
      userId: "u1",
    };

    runWithDbContext(ctx, () => {
      provisionNewUser("u1");

      const tier = db.select().from(accountTier).where(eq(accountTier.userId, "u1")).get();
      expect(tier?.tier).toBe("public");
      expect(tier?.grantedAt).toBeTruthy();

      const buckets = listBuckets();
      expect(buckets).toHaveLength(1);
      expect(buckets[0]?.userId).toBe("u1");
    });
  });

  it("is idempotent on the tier row (ON CONFLICT DO NOTHING)", () => {
    const { sqlite, db, marketDb, marketSqlite } = freshDb();
    seedUser(db, "u1");
    const ctx: DbContext = {
      appDb: db,
      appSqlite: sqlite,
      marketDb,
      marketSqlite,
      isDemo: false,
      sessionId: "owner",
      userId: "u1",
    };

    runWithDbContext(ctx, () => {
      provisionNewUser("u1");
      // Calling again must not throw on the PK conflict.
      expect(() => provisionNewUser("u1")).not.toThrow();
      const tiers = db.select().from(accountTier).where(eq(accountTier.userId, "u1")).all();
      expect(tiers).toHaveLength(1);
    });
  });

  it("isolates the seeded bucket to its owner", () => {
    const { sqlite, db, marketDb, marketSqlite } = freshDb();
    seedUser(db, "u1");
    seedUser(db, "u2");

    runWithDbContext(
      {
        appDb: db,
        appSqlite: sqlite,
        marketDb,
        marketSqlite,
        isDemo: false,
        sessionId: "owner",
        userId: "u1",
      },
      () => provisionNewUser("u1"),
    );
    runWithDbContext(
      {
        appDb: db,
        appSqlite: sqlite,
        marketDb,
        marketSqlite,
        isDemo: false,
        sessionId: "owner",
        userId: "u2",
      },
      () => provisionNewUser("u2"),
    );

    runWithDbContext(
      {
        appDb: db,
        appSqlite: sqlite,
        marketDb,
        marketSqlite,
        isDemo: false,
        sessionId: "owner",
        userId: "u1",
      },
      () => {
        const buckets = listBuckets();
        expect(buckets).toHaveLength(1);
        expect(buckets[0]?.userId).toBe("u1");
      },
    );
  });
});
