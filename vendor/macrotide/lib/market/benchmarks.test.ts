// Benchmark overlay carry-in + FX: the series must span the full window from its
// first date and be converted to the base currency (฿), for owner mode
// (market.db cache). Demo mode is covered in series.demo.test.ts.

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWithDbContext } from "@/lib/db/context";
import { fundQuotes, navHistory } from "@/lib/db/schema";
import { freshAppDb, freshMarketDb } from "@/tests/db-helpers";
import { getBenchmarkSeries } from "./benchmarks";

type AppDb = ReturnType<typeof freshAppDb>["db"];
type MarketDb = ReturnType<typeof freshMarketDb>["db"];

let appSqlite: Database.Database;
let appDb: AppDb;
let marketSqlite: Database.Database;
let marketDb: MarketDb;

// us_tr → benchmark_tr:SPY (USD total-return proxy for the S&P 500).
const SPY_KEY = "benchmark_tr:SPY";

function runOwner<T>(fn: () => T | Promise<T>): Promise<T> {
  return runWithDbContext(
    { appDb, appSqlite, marketDb, marketSqlite, isDemo: false, sessionId: "owner" },
    fn,
  ) as Promise<T>;
}

function navAtOffset(key: string, daysAgo: number, nav: number): void {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  marketDb
    .insert(navHistory)
    .values({ ticker: key, date: d.toISOString().slice(0, 10), nav })
    .run();
}

function seedFreshQuote(key: string, nav: number): void {
  marketDb
    .insert(fundQuotes)
    .values({ ticker: key, nav, updatedAt: new Date().toISOString() })
    .run();
}

/** Seed a USD→THB rate so owner-mode conversion serves from cache (no network).
 * Points sit inside the 1mo window so getCachedSeries returns them. */
function seedUsdThb(rate: number): void {
  navAtOffset("market:THB=X", 25, rate);
  navAtOffset("market:THB=X", 3, rate);
  seedFreshQuote("market:THB=X", rate);
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

describe("getBenchmarkSeries — owner-mode carry-in", () => {
  it("seeds the window's first date from the last pre-window close", async () => {
    // Pre-window close (45d ago) + one in-window close (10d ago). A fresh quote
    // makes getCachedSeries serve from cache (no network).
    navAtOffset(SPY_KEY, 45, 4000);
    navAtOffset(SPY_KEY, 10, 4200);
    seedFreshQuote(SPY_KEY, 4200);
    seedUsdThb(1); // identity FX so we assert the raw carry-in value

    const since = (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 31); // 1mo window
      return d.toISOString().slice(0, 10);
    })();

    const series = await runOwner(() => getBenchmarkSeries("us_tr", "1mo"));
    // First point seeds the left edge at `since` with the pre-window close.
    expect(series.length).toBeGreaterThanOrEqual(2);
    expect(series[0].date).toBe(since);
    expect(series[0].value).toBe(4000);
  });

  it("no carry-in when an in-window point already lands on the window start", async () => {
    navAtOffset(SPY_KEY, 31, 5000); // exactly on the 1mo window start
    navAtOffset(SPY_KEY, 5, 5100);
    seedFreshQuote(SPY_KEY, 5100);
    seedUsdThb(1);

    const series = await runOwner(() => getBenchmarkSeries("us_tr", "1mo"));
    // The window-start row is already there; no synthetic carry-in prepended.
    expect(series[0].value).toBe(5000);
    // No duplicate first date.
    expect(series.filter((p) => p.date === series[0].date)).toHaveLength(1);
  });

  it("converts the USD proxy series into the base currency (฿)", async () => {
    navAtOffset(SPY_KEY, 10, 100);
    seedFreshQuote(SPY_KEY, 100);
    seedUsdThb(35); // 1 USD = 35 ฿

    const series = await runOwner(() => getBenchmarkSeries("us_tr", "1mo"));
    expect(series.length).toBeGreaterThanOrEqual(1);
    // 100 USD × 35 = 3500 ฿.
    expect(series[series.length - 1].value).toBe(3500);
  });
});
