// Non-THB cost-basis derivation. A foreign-listed security's money facts are
// stored in THB (native × trade-date fxToThb) while its NAV arrives in the native
// currency, so the fold must convert the NAV divisor to THB before deriving units —
// otherwise units = value_THB ÷ NAV_native comes out wildly wrong. These tests pin
// that a USD holding derives a correct NATIVE share count, and that a THB holding
// (fxToThb 1) is unaffected.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { freshMarketDb } from "@/tests/db-helpers";
import { type DbContext, getMarketDb, runWithDbContext } from "../context";
import * as schema from "../schema";
import { fundQuotes, navHistory } from "../schema";
import { createBucket } from "./buckets";
import { listHoldings } from "./holdings";
import { insertTransactions } from "./transactions";

function freshCtx(): DbContext {
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
    appDb: drizzle(sqlite, { schema }),
    appSqlite: sqlite,
    marketDb: market.db,
    marketSqlite: market.sqlite,
    isDemo: false,
    sessionId: "s",
    userId: null,
  };
}

const BUCKET = {
  name: "B",
  typeLabel: null,
  icon: null,
  color: null,
  brokerage: "X",
  notes: null,
  goalText: null,
  targetModelId: null,
  targetAllocation: null,
};

// Seed a NATIVE-currency NAV for a US ticker (cache key `market:TICKER`).
function seedNav(ticker: string, date: string, navNative: number): void {
  const key = `market:${ticker}`;
  const db = getMarketDb();
  db.insert(navHistory).values({ ticker: key, date, nav: navNative }).run();
  db.insert(fundQuotes)
    .values({ ticker: key, nav: navNative, updatedAt: new Date().toISOString() })
    .run();
}

describe("resolveDerivedUnits — non-THB holdings", () => {
  it("derives a native share count from a THB value ÷ (native NAV × trade-date FX)", () => {
    runWithDbContext(freshCtx(), () => {
      createBucket({ ...BUCKET, id: "b1" });
      // VOO trades at $550 on the date; the user held it worth $5,500 → 10 units.
      // Entered in THB at fxToThb 35: value = 5500 × 35 = ฿192,500.
      seedNav("USSTK", "2024-06-01", 550);
      insertTransactions([
        {
          bucketId: "b1",
          ticker: "USSTK",
          quoteSource: "market",
          kind: "opening",
          tradeDate: "2024-06-01",
          // value-only Balance: no units, THB value fact, USD trade-date rate.
          value: 5500 * 35,
          amount: 0,
          tradeCurrency: "USD",
          fxToThb: 35,
        },
      ]);
      const h = listHoldings("b1");
      expect(h).toHaveLength(1);
      // units = 192500 ÷ (550 × 35) = 10 — a native share count, NOT 192500/550 (=350).
      expect(h[0].units).toBeCloseTo(10, 6);
    });
  });

  it("derives units for an amount-only USD buy with no execution price", () => {
    runWithDbContext(freshCtx(), () => {
      createBucket({ ...BUCKET, id: "b1" });
      seedNav("USSTK", "2024-06-01", 550);
      insertTransactions([
        {
          bucketId: "b1",
          ticker: "USSTK",
          quoteSource: "market",
          kind: "buy",
          tradeDate: "2024-06-01",
          // amount-only trade: ฿ spent (5500 USD × 35), units derive from NAV(date).
          amount: -(5500 * 35),
          tradeCurrency: "USD",
          fxToThb: 35,
        },
      ]);
      const h = listHoldings("b1");
      expect(h[0].units).toBeCloseTo(10, 6);
      // Cost basis folds in THB: ฿192,500 over 10 units → ฿19,250/unit.
      expect(h[0].avgCost).toBeCloseTo(19_250, 3);
    });
  });

  it("a THB holding (fxToThb 1) is unaffected — value ÷ NAV as before", () => {
    runWithDbContext(freshCtx(), () => {
      createBucket({ ...BUCKET, id: "b1" });
      seedNav("THAISTK", "2024-06-01", 25);
      insertTransactions([
        {
          bucketId: "b1",
          ticker: "THAISTK",
          quoteSource: "market",
          kind: "opening",
          tradeDate: "2024-06-01",
          value: 2500,
          amount: 0,
          tradeCurrency: "THB",
          fxToThb: 1,
        },
      ]);
      const h = listHoldings("b1");
      expect(h[0].units).toBeCloseTo(100, 6); // 2500 ÷ 25
    });
  });
});
