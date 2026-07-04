import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { freshMarketDb } from "@/tests/db-helpers";
import { runWithDbContext } from "../context";
import * as schema from "../schema";
import { createBucket } from "./buckets";
import { deleteAccountEarmark, listEarmarks, setAccountEarmark } from "./earmarks";

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

// Synthetic data only — generic bucket + account names, never real fund codes.
const BUCKET = {
  id: "test-core",
  name: "Test Core",
  typeLabel: "Free",
  icon: "wallet",
  color: "#3b82f6",
  brokerage: "FNDQ",
  notes: null,
  goalText: null,
  targetModelId: null,
  targetAllocation: null,
};

describe("earmarks queries", () => {
  it("sets an account earmark in the typed case (#235), lists it", () => {
    withFresh(() => {
      createBucket(BUCKET);
      const e = setAccountEarmark({
        bucketId: "test-core",
        ticker: "savings",
        amount: 200_000,
        currency: "THB",
        purpose: "Emergency",
      });
      // The cash account name keeps the user's case (no upper-casing workaround).
      expect(e.ticker).toBe("savings");
      expect(e.scope).toBe("account");
      expect(e.amount).toBe(200_000);
      expect(listEarmarks()).toHaveLength(1);
    });
  });

  it("upserts per (bucket, ticker) — re-setting replaces, never duplicates", () => {
    withFresh(() => {
      createBucket(BUCKET);
      setAccountEarmark({ bucketId: "test-core", ticker: "SAVINGS", amount: 200_000 });
      const e2 = setAccountEarmark({
        bucketId: "test-core",
        ticker: "savings", // same account, different case
        amount: null, // "All"
        purpose: "Emergency",
      });
      expect(listEarmarks()).toHaveLength(1);
      expect(e2.amount).toBeNull();
      expect(e2.purpose).toBe("Emergency");
    });
  });

  it("deletes an account earmark (the whole balance is investable again)", () => {
    withFresh(() => {
      createBucket(BUCKET);
      setAccountEarmark({ bucketId: "test-core", ticker: "SAVINGS", amount: 100_000 });
      deleteAccountEarmark("test-core", "savings");
      expect(listEarmarks()).toHaveLength(0);
    });
  });

  it("stores the role; defaults to reserved; an investable row carries only a label", () => {
    withFresh(() => {
      createBucket(BUCKET);
      const reserved = setAccountEarmark({
        bucketId: "test-core",
        ticker: "EMERGENCY",
        amount: null,
        purpose: "Emergency",
      });
      expect(reserved.role).toBe("reserved"); // default
      const investable = setAccountEarmark({
        bucketId: "test-core",
        ticker: "BROKERAGE",
        role: "investable",
        amount: null,
        purpose: "Retirement",
      });
      expect(investable.role).toBe("investable");
      expect(investable.purpose).toBe("Retirement");
      expect(listEarmarks()).toHaveLength(2);
    });
  });
});
