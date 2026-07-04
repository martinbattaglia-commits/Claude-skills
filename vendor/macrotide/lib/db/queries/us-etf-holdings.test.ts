import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithDbContext } from "@/lib/db/context";
import { refreshUsSecurities } from "@/lib/jobs/refresh-us-securities";
import type { NportHolding } from "@/lib/market/providers/edgar-nport";
import { makeTestDbContext } from "@/tests/db-helpers";
import {
  deriveExposure,
  getEtfHoldings,
  listEtfsToRefreshHoldings,
  setEtfHoldings,
} from "./us-etf-holdings";

describe("deriveExposure (pure)", () => {
  it("aggregates country + asset-category by weight, sorted, with Unknown/Other buckets", () => {
    const r = deriveExposure([
      { country: "US", assetCat: "Equity (common)", weightPct: 60 },
      { country: "US", assetCat: "Equity (common)", weightPct: 20 },
      { country: "IE", assetCat: "Equity (common)", weightPct: 15 },
      { country: null, assetCat: null, weightPct: 5 },
      { country: "US", assetCat: "Equity (common)", weightPct: 0 }, // zero weight ignored
    ]);
    expect(r.byCountry).toEqual([
      { key: "US", pct: 80 },
      { key: "IE", pct: 15 },
      { key: "Unknown", pct: 5 },
    ]);
    expect(r.byAssetCat).toEqual([
      { key: "Equity (common)", pct: 95 },
      { key: "Other", pct: 5 },
    ]);
  });
});

// ── integration ──

const etfLine = (symbol: string, name: string) =>
  `Y|${symbol}|${name}|P| |Y|100|N||${symbol}|${symbol}|N`;
const HEADER =
  "Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares";
const directory = (...lines: string[]) => [HEADER, ...lines].join("\n");

const H = (over: Partial<NportHolding>): NportHolding => ({
  name: "X",
  ticker: null,
  assetClass: "Equity (common)",
  isin: null,
  cusip: null,
  weightPct: 1,
  country: "US",
  ...over,
});

const hoisted = vi.hoisted(() => ({ ctx: null as ReturnType<typeof makeTestDbContext> | null }));
function run<T>(fn: () => T | Promise<T>): Promise<T> {
  if (!hoisted.ctx) throw new Error("no ctx");
  return runWithDbContext(hoisted.ctx, fn) as Promise<T>;
}
beforeEach(() => {
  hoisted.ctx = makeTestDbContext();
});

describe("setEtfHoldings / getEtfHoldings", () => {
  it("stores rank-ordered holdings + freshness, reads case-insensitively, and replaces wholesale", async () => {
    await run(async () => {
      await refreshUsSecurities({
        fetchText: async () => directory(etfLine("VOO", "Vanguard S&P 500 ETF")),
        seenAt: "2026-06-26T00:00:00Z",
      });

      const written = setEtfHoldings(
        "VOO",
        [
          H({ name: "Apple Inc.", weightPct: 7.5, cusip: "037833100", country: "US" }),
          H({ name: "Nestle", weightPct: 1.2, country: "CH" }),
        ],
        "2026-03-31",
        "2026-06-26T01:00:00Z",
      );
      expect(written).toBe(2);

      const got = getEtfHoldings("voo"); // case-insensitive
      expect(got.asOf).toBe("2026-03-31");
      expect(got.fetchedAt).toBe("2026-06-26T01:00:00Z");
      expect(got.holdings.map((h) => h.name)).toEqual(["Apple Inc.", "Nestle"]);
      expect(got.holdings[0].rank).toBe(1);
      expect(got.holdings[1].country).toBe("CH");

      // VOO (an active ETF) is eligible for the bounded refresh selection.
      expect(listEtfsToRefreshHoldings(10)).toContain("VOO");

      // A second write replaces, not appends.
      setEtfHoldings(
        "VOO",
        [H({ name: "Only One", weightPct: 100 })],
        "2026-04-30",
        "2026-06-27T00:00:00Z",
      );
      const after = getEtfHoldings("VOO");
      expect(after.holdings).toHaveLength(1);
      expect(after.asOf).toBe("2026-04-30");
    });
  });
});
