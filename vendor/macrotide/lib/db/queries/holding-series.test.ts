import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshAppDb, freshMarketDb } from "@/tests/db-helpers";
import { getMarketDb, runWithDbContext } from "../context";
import {
  buckets,
  fundCatalog,
  fundQuotes,
  fundShareClasses,
  holdings,
  navHistory,
  transactions,
} from "../schema";
import { getHoldingValueSeries } from "./series";

// Mirror series.test.ts: serve the FX layer straight from seeded nav_history so
// the tests are deterministic and offline.
vi.mock("@/lib/market/cache", () => ({
  getCachedSeries: async (source: string, ticker: string) => {
    const { eq } = await import("drizzle-orm");
    const db = getMarketDb();
    const key = `${source}:${ticker}`;
    const rows = db
      .select()
      .from(navHistory)
      .where(eq(navHistory.ticker, key))
      .orderBy(navHistory.date)
      .all();
    return { ticker, series: rows.map((r) => ({ date: r.date, close: r.nav })), quote: null };
  },
}));

type AppDb = ReturnType<typeof freshAppDb>["db"];
type MarketDb = ReturnType<typeof freshMarketDb>["db"];

let appSqlite: Database.Database;
let appDb: AppDb;
let marketSqlite: Database.Database;
let marketDb: MarketDb;

function recentDates(n: number): string[] {
  const out: string[] = [];
  for (let i = n; i >= 1; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
const DATES = recentDates(3);

function seedNav(db: MarketDb, key: string, values: number[]): void {
  for (let i = 0; i < values.length; i++) {
    db.insert(navHistory).values({ ticker: key, date: DATES[i], nav: values[i] }).run();
  }
  db.insert(fundQuotes)
    .values({ ticker: key, nav: values[values.length - 1], updatedAt: new Date().toISOString() })
    .run();
}

function seedBucket(db: AppDb, id = "core"): void {
  db.insert(buckets).values({ id, name: id, brokerage: "TEST" }).run();
}

function seedTxn(
  db: AppDb,
  t: {
    ticker: string;
    quoteSource: string;
    kind: string;
    tradeDate: string;
    units: number;
    amount: number;
    pricePerUnit?: number | null;
  },
): void {
  db.insert(transactions)
    .values({
      bucketId: "core",
      ticker: t.ticker,
      englishName: t.ticker,
      quoteSource: t.quoteSource,
      kind: t.kind,
      tradeDate: t.tradeDate,
      units: t.units,
      pricePerUnit: t.pricePerUnit ?? null,
      amount: t.amount,
      fee: null,
      tradeCurrency: "THB",
      fxToThb: 1,
      importBatchId: "test-seed",
    })
    .run();
}

function run<T>(fn: () => T | Promise<T>): Promise<T> {
  return runWithDbContext(
    { appDb, appSqlite, marketDb, marketSqlite, isDemo: false, sessionId: "owner" },
    fn,
  ) as Promise<T>;
}

beforeEach(() => {
  const app = freshAppDb();
  const market = freshMarketDb();
  appSqlite = app.sqlite;
  appDb = app.db;
  marketSqlite = market.sqlite;
  marketDb = market.db;
});

afterEach(() => {
  appSqlite.close();
  marketSqlite.close();
});

describe("getHoldingValueSeries", () => {
  it("values a THB holding at units × NAV across the window, with a cost-basis line", async () => {
    seedBucket(appDb);
    // Buy 100 units at ฿10 before the window opens, so units are held throughout.
    seedTxn(appDb, {
      ticker: "EXAMPLE-FUND-A",
      quoteSource: "thai_mutual_fund",
      kind: "buy",
      tradeDate: "2020-01-01",
      units: 100,
      amount: 1000,
      pricePerUnit: 10,
    });
    seedNav(marketDb, "thai_mutual_fund:EXAMPLE-FUND-A", [10, 11, 12]);

    const { value, costBasis } = await run(() => getHoldingValueSeries("EXAMPLE-FUND-A", "1mo"));

    expect(value.map((p) => p.value)).toEqual([1000, 1100, 1200]);
    // Cost basis is what was paid (100 × ฿10), flat across the window.
    expect(costBasis.map((p) => p.value)).toEqual([1000, 1000, 1000]);
  });

  it("bridges a fund CODE rename: prices the ledger's old code under the CURRENT code (#235)", async () => {
    seedBucket(appDb);
    // The ledger keeps the original code (immutable); the user holds it.
    seedTxn(appDb, {
      ticker: "OLD-A",
      quoteSource: "thai_mutual_fund",
      kind: "buy",
      tradeDate: "2020-01-01",
      units: 100,
      amount: 1000,
      pricePerUnit: 10,
    });
    // The holding row carries the stable anchor; the catalog has since renamed the
    // code to NEW-B (resolveCatalogSymbol via the anchor → current ticker NEW-B).
    appDb
      .insert(holdings)
      .values({
        bucketId: "core",
        ticker: "OLD-A",
        englishName: "Fund",
        quoteSource: "thai_mutual_fund",
        catalogProjId: "P",
        catalogClassName: "main",
      })
      .run();
    marketDb
      .insert(fundCatalog)
      .values({ projId: "P", abbrName: "NEW-B", englishName: "Fund" })
      .run();
    marketDb
      .insert(fundShareClasses)
      .values({ projId: "P", className: "main", ticker: "NEW-B" })
      .run();
    // NAV lives under the CURRENT code (re-pointed on rename).
    seedNav(marketDb, "thai_mutual_fund:NEW-B", [10, 11, 12]);

    // The UI passes the current (displayed) code; without the bridge this returned
    // an empty series (ledger filtered by NEW-B, NAV read under the dead key).
    const { value } = await run(() => getHoldingValueSeries("NEW-B", "1mo"));
    expect(value.map((p) => p.value)).toEqual([1000, 1100, 1200]);
  });

  it("contributes 0 before the position's first event — no back-projection", async () => {
    seedBucket(appDb);
    // First buy lands on the MIDDLE date of the window.
    seedTxn(appDb, {
      ticker: "EXAMPLE-FUND-A",
      quoteSource: "thai_mutual_fund",
      kind: "buy",
      tradeDate: DATES[1],
      units: 100,
      amount: 1000,
      pricePerUnit: 10,
    });
    seedNav(marketDb, "thai_mutual_fund:EXAMPLE-FUND-A", [10, 11, 12]);

    const { value } = await run(() => getHoldingValueSeries("EXAMPLE-FUND-A", "1mo"));

    // Nothing before the first event; value appears only from DATES[1] on.
    const byDate = new Map(value.map((p) => [p.date, p.value]));
    expect(byDate.get(DATES[0])).toBeUndefined();
    expect(byDate.get(DATES[1])).toBe(1100);
    expect(byDate.get(DATES[2])).toBe(1200);
  });

  it("keeps charting an exited position, then drops it to 0 after the full sell", async () => {
    seedBucket(appDb);
    seedTxn(appDb, {
      ticker: "EXAMPLE-FUND-A",
      quoteSource: "thai_mutual_fund",
      kind: "buy",
      tradeDate: "2020-01-01",
      units: 100,
      amount: 1000,
      pricePerUnit: 10,
    });
    // Sell everything on the middle date.
    seedTxn(appDb, {
      ticker: "EXAMPLE-FUND-A",
      quoteSource: "thai_mutual_fund",
      kind: "sell",
      tradeDate: DATES[1],
      units: 100,
      amount: 1100,
      pricePerUnit: 11,
    });
    seedNav(marketDb, "thai_mutual_fund:EXAMPLE-FUND-A", [10, 11, 12]);

    const { value } = await run(() => getHoldingValueSeries("EXAMPLE-FUND-A", "1mo"));
    const byDate = new Map(value.map((p) => [p.date, p.value]));

    expect(byDate.get(DATES[0])).toBe(1000); // still held
    expect(byDate.get(DATES[2])).toBe(0); // fully exited — no phantom value
  });

  it("returns empty for a ticker with no ledger events", async () => {
    seedBucket(appDb);
    const res = await run(() => getHoldingValueSeries("NOPE", "1mo"));
    expect(res.value).toEqual([]);
    expect(res.costBasis).toEqual([]);
    expect(res.asOf).toBeNull();
  });
});
