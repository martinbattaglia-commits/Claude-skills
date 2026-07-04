import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshAppDb, freshMarketDb } from "@/tests/db-helpers";
import { twrSeries } from "../../portfolio/twr";
import { getMarketDb, runWithDbContext } from "../context";
import { buckets, fundCatalog, fundQuotes, holdings, navHistory, transactions } from "../schema";
import { getPortfolioSeries } from "./series";

// The FX layer (lib/market/fx) calls getCachedSeries, which would otherwise
// hit the network for any unseeded key. Mock it to read straight from the
// seeded market.db nav_history — exactly what a warm cache returns — so the
// tests are deterministic and offline. An unseeded key returns an empty series
// (the "cold cache" case), which buildFxConverter treats as missing.
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
    return {
      ticker,
      series: rows.map((r) => ({ date: r.date, close: r.nav })),
      quote: null,
    };
  },
}));

// Synthetic data only — generic placeholder tickers, no real fund codes.
// We seed the market cache so the FX layer (getCachedSeries) serves from
// nav_history without any network call: a fresh fund_quotes row makes
// isFresh() true, and the seeded nav_history rows are the FX series.

type AppDb = ReturnType<typeof freshAppDb>["db"];
type MarketDb = ReturnType<typeof freshMarketDb>["db"];

let appSqlite: Database.Database;
let appDb: AppDb;
let marketSqlite: Database.Database;
let marketDb: MarketDb;

// Recent dates so they fall inside the range window getPortfolioSeries derives
// from "now" (the nav query filters date >= since).
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
  for (let i = 0; i < DATES.length; i++) {
    db.insert(navHistory).values({ ticker: key, date: DATES[i], nav: values[i] }).run();
  }
  // A fresh quote row so getCachedSeries treats the series as <24h old.
  db.insert(fundQuotes)
    .values({ ticker: key, nav: values[values.length - 1], updatedAt: new Date().toISOString() })
    .run();
}

function seedBucket(db: AppDb, id = "core"): void {
  db.insert(buckets).values({ id, name: id, brokerage: "TEST" }).run();
}

function seedHolding(
  db: AppDb,
  h: { bucketId?: string; ticker: string; quoteSource: string; units: number },
): void {
  const bucketId = h.bucketId ?? "core";
  db.insert(holdings)
    .values({ bucketId, ticker: h.ticker, englishName: h.ticker, quoteSource: h.quoteSource })
    .run();
  // Position is folded from the ledger on read — seed a matching opening anchor.
  db.insert(transactions)
    .values({
      bucketId,
      ticker: h.ticker,
      englishName: h.ticker,
      quoteSource: h.quoteSource,
      kind: "opening",
      tradeDate: "2020-01-01",
      units: h.units,
      pricePerUnit: null,
      amount: 0,
      fee: null,
      tradeCurrency: "THB",
      fxToThb: 1,
      importBatchId: "test-seed",
    })
    .run();
}

// Seed a catalog row so the holdings→catalog join (held ticker = abbr_name) can
// resolve a distribution policy. `policy` may be omitted to model an unknown
// (NULL) policy fund.
function seedCatalogFund(
  db: MarketDb,
  abbrName: string,
  policy: "dividend" | "accumulating" | null = null,
): void {
  db.insert(fundCatalog)
    .values({ projId: `proj-${abbrName}`, abbrName, distributionPolicy: policy })
    .run();
}

// Owner-mode context: these tests exercise the market.db read + FX path, which
// is the owner path (demo mode now sources NAV history from the committed
// fixture — covered separately in series.demo.test.ts).
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

describe("getPortfolioSeries — FX conversion", () => {
  it("leaves a THB-only book unchanged (no FX applied)", async () => {
    seedBucket(appDb);
    seedHolding(appDb, { ticker: "EXAMPLE-FUND-A", quoteSource: "thai_mutual_fund", units: 100 });
    seedNav(marketDb, "thai_mutual_fund:EXAMPLE-FUND-A", [10, 11, 12]);

    const { aggregate, missingFx } = await run(() => getPortfolioSeries("1mo"));

    // value = units * nav, no conversion: 100 * [10,11,12].
    expect(aggregate.map((p) => p.value)).toEqual([1000, 1100, 1200]);
    expect(missingFx).toEqual([]);
  });

  it("converts a USD holding to THB at each date's USD/THB rate", async () => {
    seedBucket(appDb);
    seedHolding(appDb, { ticker: "VOO", quoteSource: "market", units: 2 });
    seedNav(marketDb, "market:VOO", [100, 100, 100]); // flat in USD
    // USD/THB rises 30 → 31 → 32: the THB value should track the FX move even
    // though the USD price is flat.
    seedNav(marketDb, "market:THB=X", [30, 31, 32]);

    const { aggregate, missingFx } = await run(() => getPortfolioSeries("1mo"));

    // 2 units * 100 USD * rate.
    expect(aggregate.map((p) => p.value)).toEqual([6000, 6200, 6400]);
    expect(missingFx).toEqual([]);
  });

  it("sums a multi-currency book in THB via per-date cross rates", async () => {
    seedBucket(appDb);
    // THB fund: 100 units * 10 THB = 1000 THB, no conversion.
    seedHolding(appDb, { ticker: "EXAMPLE-FUND-A", quoteSource: "thai_mutual_fund", units: 100 });
    seedNav(marketDb, "thai_mutual_fund:EXAMPLE-FUND-A", [10, 10, 10]);
    // USD ETF: 1 unit * 100 USD.
    seedHolding(appDb, { ticker: "VOO", quoteSource: "market", units: 1 });
    seedNav(marketDb, "market:VOO", [100, 100, 100]);
    // JPY index proxy: 10 units * 200 JPY.
    seedHolding(appDb, { ticker: "^N225", quoteSource: "market", units: 10 });
    seedNav(marketDb, "market:^N225", [200, 200, 200]);

    // USD/THB = 30 (flat). USD/JPY = 150 (flat) → JPY/THB = 30/150 = 0.2.
    seedNav(marketDb, "market:THB=X", [30, 30, 30]);
    seedNav(marketDb, "market:JPY=X", [150, 150, 150]);

    const { aggregate, missingFx } = await run(() => getPortfolioSeries("1mo"));

    // THB 1000 + USD (1*100*30 = 3000) + JPY (10*200*0.2 = 400) = 4400.
    expect(aggregate.map((p) => p.value)).toEqual([4400, 4400, 4400]);
    expect(missingFx).toEqual([]);
  });

  it("degrades gracefully when an FX rate is missing (drops that holding, flags it)", async () => {
    seedBucket(appDb);
    seedHolding(appDb, { ticker: "EXAMPLE-FUND-A", quoteSource: "thai_mutual_fund", units: 100 });
    seedNav(marketDb, "thai_mutual_fund:EXAMPLE-FUND-A", [10, 10, 10]);
    seedHolding(appDb, { ticker: "VOO", quoteSource: "market", units: 1 });
    seedNav(marketDb, "market:VOO", [100, 100, 100]);
    // No yahoo:THB=X seeded and no network → USD can't convert. The THB fund
    // still totals; the USD holding is dropped and USD is flagged.
    const { aggregate, missingFx } = await run(() => getPortfolioSeries("1mo"));

    expect(aggregate.map((p) => p.value)).toEqual([1000, 1000, 1000]);
    expect(missingFx).toContain("USD");
  });
});

describe("getPortfolioSeries — carry-in (owner mode left edge)", () => {
  /** Insert a nav row at an arbitrary date offset from today. */
  function navAtOffset(key: string, daysAgo: number, nav: number): void {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - daysAgo);
    marketDb
      .insert(navHistory)
      .values({ ticker: key, date: d.toISOString().slice(0, 10), nav })
      .run();
    marketDb
      .insert(fundQuotes)
      .values({ ticker: key, nav, updatedAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
  }

  it("seeds the window's first date from the last pre-window nav", async () => {
    seedBucket(appDb);
    seedHolding(appDb, { ticker: "EXAMPLE-FUND-A", quoteSource: "thai_mutual_fund", units: 10 });
    // Only data point is BEFORE the 1mo window (45 days ago). Without carry-in
    // the windowed query returns nothing and the holding vanishes; with carry-in
    // it's forward-filled from that pre-window value onto the window's first date.
    navAtOffset("thai_mutual_fund:EXAMPLE-FUND-A", 45, 12);

    const { aggregate } = await run(() => getPortfolioSeries("1mo"));
    expect(aggregate.length).toBeGreaterThan(0);
    expect(aggregate[0].value).toBe(120); // 10 units * 12, carried in
  });

  it("left edge includes EVERY holding that has prior data (no partial edge)", async () => {
    seedBucket(appDb);
    // Both funds were held before the window opened: A only has a pre-window
    // point; B has both a pre-window point and a later in-window one.
    seedHolding(appDb, { ticker: "EXAMPLE-FUND-A", quoteSource: "thai_mutual_fund", units: 10 });
    seedHolding(appDb, { ticker: "EXAMPLE-FUND-B", quoteSource: "thai_mutual_fund", units: 5 });
    navAtOffset("thai_mutual_fund:EXAMPLE-FUND-A", 50, 12); // 10*12 = 120 carried in
    navAtOffset("thai_mutual_fund:EXAMPLE-FUND-B", 40, 20); // 5*20 = 100 carried in (pre-window)
    navAtOffset("thai_mutual_fund:EXAMPLE-FUND-B", 10, 22); // later in-window move

    const { aggregate } = await run(() => getPortfolioSeries("1mo"));
    // Both funds present on the first plotted date → 120 + 100, no partial edge.
    expect(aggregate[0].value).toBe(220);
  });

  it("does not widen the timeline before the window start", async () => {
    seedBucket(appDb);
    seedHolding(appDb, { ticker: "EXAMPLE-FUND-A", quoteSource: "thai_mutual_fund", units: 10 });
    navAtOffset("thai_mutual_fund:EXAMPLE-FUND-A", 45, 12);

    const since = (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 31);
      return d.toISOString().slice(0, 10);
    })();
    const { aggregate } = await run(() => getPortfolioSeries("1mo"));
    // No plotted date precedes the window start; the carry-in is re-dated to it.
    expect(aggregate.every((p) => p.date >= since)).toBe(true);
  });
});

describe("getPortfolioSeries — hasDistributingHolding flag", () => {
  it("is true when a held fund's catalog distributionPolicy is 'dividend'", async () => {
    seedBucket(appDb);
    seedHolding(appDb, { ticker: "EXAMPLE-FUND-A", quoteSource: "thai_mutual_fund", units: 100 });
    seedNav(marketDb, "thai_mutual_fund:EXAMPLE-FUND-A", [10, 11, 12]);
    // Catalog row for the held ticker (held ticker == abbr_name) pays dividends.
    seedCatalogFund(marketDb, "EXAMPLE-FUND-A", "dividend");

    const { hasDistributingHolding } = await run(() => getPortfolioSeries("1mo"));
    expect(hasDistributingHolding).toBe(true);
  });

  it("is false when held funds are accumulating or have an unknown policy", async () => {
    seedBucket(appDb);
    seedHolding(appDb, { ticker: "EXAMPLE-FUND-A", quoteSource: "thai_mutual_fund", units: 100 });
    seedHolding(appDb, { ticker: "EXAMPLE-FUND-B", quoteSource: "thai_mutual_fund", units: 50 });
    seedNav(marketDb, "thai_mutual_fund:EXAMPLE-FUND-A", [10, 11, 12]);
    seedNav(marketDb, "thai_mutual_fund:EXAMPLE-FUND-B", [20, 20, 20]);
    seedCatalogFund(marketDb, "EXAMPLE-FUND-A", "accumulating");
    seedCatalogFund(marketDb, "EXAMPLE-FUND-B", null); // unknown policy

    const { hasDistributingHolding } = await run(() => getPortfolioSeries("1mo"));
    expect(hasDistributingHolding).toBe(false);
  });

  it("is false when a holding doesn't match any catalog fund (e.g. a US ETF)", async () => {
    seedBucket(appDb);
    seedHolding(appDb, { ticker: "VOO", quoteSource: "market", units: 2 });
    seedNav(marketDb, "market:VOO", [100, 100, 100]);
    seedNav(marketDb, "market:THB=X", [30, 30, 30]);
    // A dividend-paying catalog fund the user does NOT hold must not trigger it.
    seedCatalogFund(marketDb, "EXAMPLE-FUND-A", "dividend");

    const { hasDistributingHolding } = await run(() => getPortfolioSeries("1mo"));
    expect(hasDistributingHolding).toBe(false);
  });

  it("is true if ANY held fund pays dividends, even alongside accumulating ones", async () => {
    seedBucket(appDb);
    seedHolding(appDb, { ticker: "EXAMPLE-FUND-A", quoteSource: "thai_mutual_fund", units: 100 });
    seedHolding(appDb, { ticker: "EXAMPLE-FUND-B", quoteSource: "thai_mutual_fund", units: 50 });
    seedNav(marketDb, "thai_mutual_fund:EXAMPLE-FUND-A", [10, 11, 12]);
    seedNav(marketDb, "thai_mutual_fund:EXAMPLE-FUND-B", [20, 20, 20]);
    seedCatalogFund(marketDb, "EXAMPLE-FUND-A", "accumulating");
    seedCatalogFund(marketDb, "EXAMPLE-FUND-B", "dividend");

    const { hasDistributingHolding } = await run(() => getPortfolioSeries("1mo"));
    expect(hasDistributingHolding).toBe(true);
  });
});

// ——— Ledger replay (#140): the basket is the ledger, not current holdings ———

/** Insert a raw ledger row; no holdings row needed (the chart is ledger-driven). */
function seedTxn(
  db: AppDb,
  t: {
    bucketId?: string;
    ticker: string;
    kind: string;
    tradeDate: string;
    units?: number | null;
    amount: number;
    value?: number | null;
    pricePerUnit?: number | null;
  },
): void {
  db.insert(transactions)
    .values({
      bucketId: t.bucketId ?? "core",
      ticker: t.ticker,
      englishName: t.ticker,
      quoteSource: "thai_mutual_fund",
      kind: t.kind,
      tradeDate: t.tradeDate,
      units: t.units ?? null,
      pricePerUnit: t.pricePerUnit ?? null,
      amount: t.amount,
      value: t.value ?? null,
      fee: null,
      tradeCurrency: "THB",
      fxToThb: 1,
      importBatchId: "test-seed",
    })
    .run();
}

function dateDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function navOn(key: string, date: string, nav: number): void {
  marketDb.insert(navHistory).values({ ticker: key, date, nav }).run();
  marketDb
    .insert(fundQuotes)
    .values({ ticker: key, nav, updatedAt: new Date().toISOString() })
    .onConflictDoNothing()
    .run();
}

describe("getPortfolioSeries — ledger replay (#140)", () => {
  const KEY_A = "thai_mutual_fund:EXAMPLE-FUND-A";
  const KEY_B = "thai_mutual_fund:EXAMPLE-FUND-B";

  it("never back-projects: a mid-window buy contributes nothing before its date", async () => {
    seedBucket(appDb);
    seedNav(marketDb, KEY_A, [10, 11, 12]);
    seedTxn(appDb, {
      ticker: "EXAMPLE-FUND-A",
      kind: "buy",
      tradeDate: DATES[1],
      units: 100,
      amount: -1000,
    });

    const { aggregate, netInvested } = await run(() => getPortfolioSeries("1mo"));

    // No point exists before the first ledger event — the old code drew
    // 100 units across all three dates (the #140 false-step bug).
    expect(aggregate.map((p) => p.date)).toEqual([DATES[1], DATES[2]]);
    expect(aggregate.map((p) => p.value)).toEqual([1100, 1200]);
    expect(netInvested.map((p) => p.value)).toEqual([1000, 1000]);
  });

  it("keeps an exited position in history (proceeds become in-transit cash)", async () => {
    seedBucket(appDb);
    seedHolding(appDb, { ticker: "EXAMPLE-FUND-A", quoteSource: "thai_mutual_fund", units: 10 });
    seedNav(marketDb, KEY_A, [12, 12, 12]);
    seedTxn(appDb, {
      ticker: "EXAMPLE-FUND-A",
      kind: "sell",
      tradeDate: DATES[1],
      units: 10,
      amount: 120,
    });

    const { aggregate, cash } = await run(() => getPortfolioSeries("1mo"));

    // Held on the first date; sold on the second — the recent proceeds stay as
    // pending settlement cash instead of the position vanishing from history.
    expect(aggregate.map((p) => p.value)).toEqual([120, 120, 120]);
    expect(cash.map((p) => p.value)).toEqual([0, 120, 120]);
  });

  it("draws no dip across a fund switch, and contribution stays flat", async () => {
    seedBucket(appDb);
    const [d20, d10, d8, d5] = [dateDaysAgo(20), dateDaysAgo(10), dateDaysAgo(8), dateDaysAgo(5)];
    navOn(KEY_A, d20, 10);
    navOn(KEY_A, d10, 15);
    navOn(KEY_B, d8, 20);
    navOn(KEY_B, d5, 21);
    seedTxn(appDb, {
      ticker: "EXAMPLE-FUND-A",
      kind: "buy",
      tradeDate: d20,
      units: 100,
      amount: -1000,
    });
    seedTxn(appDb, {
      ticker: "EXAMPLE-FUND-A",
      kind: "sell",
      tradeDate: d10,
      units: 100,
      amount: 1500,
    });
    seedTxn(appDb, {
      ticker: "EXAMPLE-FUND-B",
      kind: "buy",
      tradeDate: d8,
      units: 75,
      amount: -1500,
    });

    const { aggregate, netInvested, cashDecomp } = await run(() => getPortfolioSeries("1mo"));

    // During the 2 transit days the proceeds ARE the value — no fake drawdown.
    expect(aggregate.map((p) => p.value)).toEqual([1000, 1500, 1500, 1575]);
    // The switch is internal: only the original buy is external money.
    expect(netInvested.map((p) => p.value)).toEqual([1000, 1000, 1000, 1000]);
    // The proceeds are in-transit settlement cash (all-cash slice records it for the
    // Mix composition), but NOT a held account — so the "Funds only" exclusion slice
    // stays empty and applying that mode subtracts nothing: the switch can't reopen
    // the phantom dip in the return view either.
    expect(cashDecomp.cashValue.map((p) => p.value)).toEqual([0, 1500, 0, 0]);
    expect(cashDecomp.heldCashValue.map((p) => p.value)).toEqual([0, 0, 0, 0]);
  });

  it("TWR keeps a realized gain when you sell at a profit and walk away", async () => {
    seedBucket(appDb);
    // Buy A @1000, it rises to 1500, sell at the +50% gain, never rebuy → the
    // proceeds expire (walk away). NAV rises the day BEFORE the sell so the gain
    // shows in the value line before units zero out.
    const [d60, d41, d40] = [dateDaysAgo(60), dateDaysAgo(41), dateDaysAgo(40)];
    navOn(KEY_A, d60, 10);
    navOn(KEY_A, d41, 15);
    seedTxn(appDb, {
      ticker: "EXAMPLE-FUND-A",
      kind: "buy",
      tradeDate: d60,
      units: 100,
      amount: -1000,
    });
    seedTxn(appDb, {
      ticker: "EXAMPLE-FUND-A",
      kind: "sell",
      tradeDate: d40,
      units: 100,
      amount: 1500,
    });

    const { aggregate, netInvested, netInvestedForReturn } = await run(() =>
      getPortfolioSeries("3mo"),
    );

    // Value climbs 1000 → 1500, then drops to 0 at the walk-away sale.
    expect(aggregate.map((p) => p.value)).toEqual([1000, 1500, 0]);
    // Contribution line (money-weighted): cost basis floors at 0, never negative.
    expect(netInvested.map((p) => p.value)).toEqual([1000, 1000, 0]);
    // TWR contribution line: the FULL 1500 proceeds leave (1000 in − 1500 out = −500).
    expect(netInvestedForReturn.map((p) => p.value)).toEqual([1000, 1000, -500]);

    // The fix: TWR PRESERVES the +50% (growth 1.5) — the realized gain leaving the
    // book is an external outflow, not a market loss.
    const twr = twrSeries(
      aggregate.map((p) => ({ d: p.date, v: p.value })),
      netInvestedForReturn.map((p) => ({ d: p.date, v: p.value })),
    );
    expect(twr.at(-1)?.v).toBeCloseTo(1.5, 6);
    // Contrast: feeding the cost-basis contribution line wipes the gain (the bug).
    const twrBug = twrSeries(
      aggregate.map((p) => ({ d: p.date, v: p.value })),
      netInvested.map((p) => ({ d: p.date, v: p.value })),
    );
    expect(twrBug.at(-1)?.v).toBeCloseTo(1.0, 6);
  });

  it("prices pre-coverage history from the ledger's own trade prices", async () => {
    seedBucket(appDb);
    seedNav(marketDb, KEY_A, [12, 12, 12]); // cached coverage = recent only
    seedTxn(appDb, {
      ticker: "EXAMPLE-FUND-A",
      kind: "buy",
      tradeDate: "2020-06-01",
      units: 100,
      amount: -1000, // implies 10 THB/unit on 2020-06-01
    });

    const { aggregate, estimatedThrough } = await run(() => getPortfolioSeries("max"));

    expect(aggregate[0]).toEqual({ date: "2020-06-01", value: 1000 });
    expect(aggregate.at(-1)?.value).toBe(1200);
    // The pre-coverage stretch is flagged so the UI can caption it.
    expect(estimatedThrough).toBe("2020-06-01");
  });

  it("derives a value-only Balance's units at its date and replays forward", async () => {
    seedBucket(appDb);
    seedNav(marketDb, KEY_A, [12, 12, 15]);
    seedTxn(appDb, {
      ticker: "EXAMPLE-FUND-A",
      kind: "snapshot",
      tradeDate: DATES[0],
      units: null,
      amount: 0,
      value: 1200, // ÷ nav 12 → 100 units
    });

    const { aggregate, netInvested, estimatedThrough } = await run(() => getPortfolioSeries("1mo"));

    expect(aggregate.map((p) => p.value)).toEqual([1200, 1200, 1500]);
    // A restatement moves no cash — the contribution line doesn't budge.
    expect(netInvested.map((p) => p.value)).toEqual([0, 0, 0]);
    expect(estimatedThrough).toBeNull();
  });

  it("does not flag a date where only a tiny dust position is estimate-priced", async () => {
    seedBucket(appDb);
    // Big holding fully cache-priced; a ฿1 dust holding is trade-implied only
    // (no cached NAV) — under the 2% materiality gate, so it must NOT caption
    // the whole chart as estimated.
    seedHolding(appDb, { ticker: "EXAMPLE-FUND-A", quoteSource: "thai_mutual_fund", units: 1000 });
    seedNav(marketDb, KEY_A, [10, 10, 10]); // 10,000 THB, cache-priced
    seedTxn(appDb, {
      ticker: "EXAMPLE-FUND-B", // no cached NAV → trade-implied
      kind: "buy",
      tradeDate: DATES[0],
      units: 1,
      amount: -1, // ฿1 dust ≪ 2% of the book
    });

    const { estimatedThrough } = await run(() => getPortfolioSeries("1mo"));
    expect(estimatedThrough).toBeNull();
  });
});
