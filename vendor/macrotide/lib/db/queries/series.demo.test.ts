// Demo-mode read path: the Portfolio chart and benchmark overlay must source
// ~5 years of DENSE (daily-recent / weekly-far-back) history from the committed
// fixture (lib/mock/demo-history), NOT from market.db — and owner mode must
// still read market.db.

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBenchmarkSeries } from "@/lib/market/benchmarks";
import { PORTFOLIOS } from "@/lib/mock/data";
import { DEMO_HOLDING_HISTORY } from "@/lib/mock/demo-history";
import { demoIndexSeries } from "@/lib/mock/demo-history-read";
import { DEMO_CASH, seedDemoData } from "@/lib/mock/demo-seed";
import { freshAppDb, freshMarketDb } from "@/tests/db-helpers";
import { runWithDbContext } from "../context";
import { fundCatalog, holdings } from "../schema";
import { getPortfolioSeries } from "./series";

// FX layer would hit the network for any key; in demo mode the book is THB-only
// so no rate is needed, but mock it to be safe + offline.
vi.mock("@/lib/market/cache", () => ({
  getCachedSeries: async (_source: string, ticker: string) => ({
    ticker,
    series: [],
    quote: null,
  }),
}));

type AppDb = ReturnType<typeof freshAppDb>["db"];
type MarketDb = ReturnType<typeof freshMarketDb>["db"];

let appSqlite: Database.Database;
let appDb: AppDb;
let marketSqlite: Database.Database;
let marketDb: MarketDb;

function runDemo<T>(fn: () => T | Promise<T>): Promise<T> {
  return runWithDbContext(
    { appDb, appSqlite, marketDb, marketSqlite, isDemo: true, sessionId: "demo-test" },
    fn,
  ) as Promise<T>;
}

function runOwner<T>(fn: () => T | Promise<T>): Promise<T> {
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
  seedDemoData(appDb); // real demo holdings (THB Thai funds)
});

afterEach(() => {
  appSqlite.close();
  marketSqlite.close();
});

describe("getPortfolioSeries — demo mode (fixture-backed)", () => {
  it("returns dense multi-year history from the fixture, not market.db", async () => {
    // market.db is intentionally EMPTY — if the demo branch read it, we'd get [].
    const { aggregate, asOf } = await runDemo(() => getPortfolioSeries("max"));
    // Daily-recent + weekly-far-back over ~5y → hundreds of points, not ~60.
    expect(aggregate.length).toBeGreaterThanOrEqual(300);
    expect(asOf).not.toBeNull();
    // Spans multiple years.
    const firstYear = Number(aggregate[0].date.slice(0, 4));
    const lastYear = Number((asOf as string).slice(0, 4));
    expect(lastYear - firstYear).toBeGreaterThanOrEqual(3);
  });

  it("the recent window is daily (a 1-month range yields ~20+ trading days)", async () => {
    const { aggregate } = await runDemo(() => getPortfolioSeries("1mo"));
    expect(aggregate.length).toBeGreaterThanOrEqual(18);
  });

  // Full seeded book value: last per-unit fixture NAV × the holding's terminal
  // unit count (the seed's trade story always folds back to data.ts units).
  function fullBookValue(): number {
    let total = 0;
    for (const p of PORTFOLIOS) {
      for (const h of p.holdings) {
        const nav = DEMO_HOLDING_HISTORY[`thai_mutual_fund:${h.ticker}`]?.at(-1)?.[1] ?? 0;
        total += nav * h.units;
      }
    }
    return total;
  }

  // Direct US holdings have no demo NAV fixture, so the chart trade-prices them at
  // cost (units × trade price = cost) — a flat line flagged estimated. Their live
  // USD→THB value only shows in the current-value view, not the fixture chart.
  function fullMarketValue(): number {
    let total = 0;
    for (const p of PORTFOLIOS) {
      for (const h of p.holdings) {
        if (h.quoteSource === "market") total += h.cost;
      }
    }
    return total;
  }

  // Demo cash terminal balances (#149): cash_balance asserts a level; deposits add,
  // withdrawals subtract. Cash is valued 1.0 (THB), so the terminal balance is its value.
  function fullCashValue(): number {
    let total = 0;
    for (const acct of DEMO_CASH) {
      let bal = 0;
      for (const ev of acct.events) {
        if (ev.kind === "cash_balance") bal = ev.balance;
        else if (ev.kind === "deposit") bal += ev.amount;
        else bal -= ev.amount;
      }
      total += bal;
    }
    return total;
  }

  it("the window's FIRST date is full, not partial (carry-in seeds the left edge)", async () => {
    const fullBook = fullBookValue() + fullCashValue();
    // The first 1M point must already include every holding — close to the full
    // book (a month's drift, never a fraction like 3/12 ≈ 20%). Regression guard
    // for the left-edge jump: pre-fix this was ~250k (3 of 12 funds present).
    const { aggregate } = await runDemo(() => getPortfolioSeries("1mo"));
    const first = aggregate[0].value;
    expect(first).toBeGreaterThan(fullBook * 0.85);
    expect(first).toBeLessThan(fullBook * 1.15);
  });

  it("the demo aggregate equals the sum of every seeded holding's current value", async () => {
    const { aggregate } = await runDemo(() => getPortfolioSeries("max"));
    const lastTotal = aggregate.at(-1)?.value as number;
    // Terminal replayed units × last fixture NAV per holding (the trade story always
    // folds back to data.ts's unit counts), plus the explicit cash terminal balances,
    // plus the direct US holdings trade-priced at cost (no fixture NAV).
    expect(lastTotal).toBeCloseTo(fullBookValue() + fullCashValue() + fullMarketValue(), 0);
  });

  it("a shorter range returns fewer points (range filter applies)", async () => {
    const all = await runDemo(() => getPortfolioSeries("max"));
    const oneYear = await runDemo(() => getPortfolioSeries("1y"));
    expect(oneYear.aggregate.length).toBeLessThan(all.aggregate.length);
    expect(oneYear.aggregate.length).toBeGreaterThan(0);
  });

  it("owner mode does NOT read the fixture (empty market.db → trade-priced only)", async () => {
    // With market.db empty, owner mode can price only from the ledger's own
    // trades — a handful of event-dated, estimate-flagged points. If the owner
    // branch ever read the fixture, this would be a dense multi-hundred-point
    // series (like the demo assertions above).
    const owner = await runOwner(() => getPortfolioSeries("max"));
    expect(owner.aggregate.length).toBeGreaterThan(0);
    expect(owner.aggregate.length).toBeLessThan(30);
    expect(owner.estimatedThrough).not.toBeNull();

    // Demo reads the fixture → a dense multi-hundred-point series. (It also carries
    // an estimatedThrough now: the direct US holdings have no fixture NAV and are
    // trade-priced, so density — not the estimate flag — is what proves fixture use.)
    const demo = await runDemo(() => getPortfolioSeries("max"));
    expect(demo.aggregate.length).toBeGreaterThanOrEqual(300);
  });

  it("hasDistributingHolding reflects the shared market.db catalog in demo mode", async () => {
    // Default seeded demo catalog (empty) → no demo holding is dividend-paying.
    const before = await runDemo(() => getPortfolioSeries("max"));
    expect(before.hasDistributingHolding).toBe(false);

    // Mark ONE real demo holding's catalog entry as dividend-paying. The held
    // ticker is the catalog abbr_name, so the app-side join picks it up. We read
    // the ticker from the seeded book rather than hardcoding a real fund code.
    const heldTicker = appDb.select({ ticker: holdings.ticker }).from(holdings).get()?.ticker;
    expect(heldTicker).toBeTruthy();
    marketDb
      .insert(fundCatalog)
      .values({
        projId: "proj-demo-div",
        abbrName: heldTicker as string,
        distributionPolicy: "dividend",
      })
      .run();

    const after = await runDemo(() => getPortfolioSeries("max"));
    expect(after.hasDistributingHolding).toBe(true);
  });
});

describe("getBenchmarkSeries — demo mode (fixture-backed)", () => {
  it("serves a dense multi-year index series for a known benchmark", async () => {
    // us_tr is the featured S&P 500 TR benchmark → maps to the fixture's "sp500".
    const series = await runDemo(() => getBenchmarkSeries("us_tr", "max"));
    expect(series.length).toBeGreaterThanOrEqual(300);
    // Matches the decoded fixture series for the mapped index exactly.
    expect(series).toEqual(demoIndexSeries("sp500"));
  });

  it("the benchmark recent window is daily (1-month ≈ 20+ points)", async () => {
    const series = await runDemo(() => getBenchmarkSeries("us_tr", "1mo"));
    expect(series.length).toBeGreaterThanOrEqual(18);
  });

  it("stays daily-dense and current at a FAR-FUTURE date (re-dated fixture, no refresh)", async () => {
    // The fixture is re-dated so its latest point lands on "today" — so the recent
    // window stays daily and the demo looks current at ANY date, forever. Pin the
    // clock years ahead to prove the demo never silently goes stale.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-03-14T12:00:00Z"));
    try {
      const series = await runDemo(() => getBenchmarkSeries("us_tr", "1mo"));
      expect(series.length).toBeGreaterThanOrEqual(18);
      // Data is re-dated up to "now" — its last point is in the (faked) present.
      expect(series.at(-1)?.date.slice(0, 4)).toBe("2031");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the benchmark window's first point is on/before the range start (carry-in)", async () => {
    const since = (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 31); // matches the "1mo" window
      return d.toISOString().slice(0, 10);
    })();
    const series = await runDemo(() => getBenchmarkSeries("us_tr", "1mo"));
    // First point seeds the left edge: dated at/before `since`, so the overlay
    // spans the full window (the client rebases from the same start).
    expect(series[0].date <= since).toBe(true);
  });

  it("respects the range window", async () => {
    const all = await runDemo(() => getBenchmarkSeries("thai_tr", "max"));
    const oneYear = await runDemo(() => getBenchmarkSeries("thai_tr", "1y"));
    expect(oneYear.length).toBeLessThan(all.length);
    expect(oneYear.length).toBeGreaterThan(0);
  });

  it("returns [] for an unknown benchmark key", async () => {
    const series = await runDemo(() => getBenchmarkSeries("does-not-exist", "max"));
    expect(series).toEqual([]);
  });
});
