import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMarketDb, runWithDbContext } from "@/lib/db/context";
import { usEtfHoldings } from "@/lib/db/schema";
import { refreshUsSecurities } from "@/lib/jobs/refresh-us-securities";
import type { NportHolding } from "@/lib/market/providers/edgar-nport";
import { makeTestDbContext } from "@/tests/db-helpers";
import { getUsSecurityDetail, mergeRelatedEtfs } from "./us-detail";
import { setDividends } from "./us-dividends";
import { type HeldViaEtf, setEtfHoldings } from "./us-etf-holdings";
import type { RelatedEtf } from "./us-related";
import { resolveUsHolding } from "./us-securities";

const stockLine = (s: string, n: string) => `Y|${s}|${n}|Q| |N|100|N||${s}|${s}|N`;
const etfLine = (s: string, n: string) => `Y|${s}|${n}|P| |Y|100|N||${s}|${s}|N`;
const HEADER =
  "Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares";
const directory = (...lines: string[]) => [HEADER, ...lines].join("\n");

const holding = (name: string, weightPct: number, country: string): NportHolding => ({
  name,
  ticker: null,
  assetClass: "Equity (common)",
  isin: null,
  cusip: null,
  weightPct,
  country,
});

const hoisted = vi.hoisted(() => ({ ctx: null as ReturnType<typeof makeTestDbContext> | null }));
function run<T>(fn: () => T | Promise<T>): Promise<T> {
  if (!hoisted.ctx) throw new Error("no ctx");
  return runWithDbContext(hoisted.ctx, fn) as Promise<T>;
}
beforeEach(() => {
  hoisted.ctx = makeTestDbContext();
});

describe("getUsSecurityDetail", () => {
  it("assembles an ETF: holdings + derived exposure + dividends", async () => {
    await run(async () => {
      await refreshUsSecurities({
        fetchText: async () => directory(etfLine("VOO", "Vanguard S&P 500 ETF")),
        seenAt: "2026-06-26T00:00:00Z",
      });
      setEtfHoldings(
        "VOO",
        [holding("Apple Inc.", 7, "US"), holding("Nestle", 3, "CH")],
        "2026-03-31",
        "2026-06-26T01:00:00Z",
      );
      setDividends(
        "VOO",
        [
          {
            exDate: "2026-03-20",
            payableDate: null,
            recordDate: null,
            cashAmount: 1.5,
            special: false,
          },
        ],
        "2026-06-26T01:00:00Z",
      );

      const d = getUsSecurityDetail("voo"); // case-insensitive
      expect(d?.security.symbol).toBe("VOO");
      expect(d?.holdings?.items.map((h) => h.name)).toEqual(["Apple Inc.", "Nestle"]);
      expect(d?.holdings?.exposure.byCountry).toEqual([
        { key: "US", pct: 7 },
        { key: "CH", pct: 3 },
      ]);
      expect(d?.dividends.items).toHaveLength(1);
      // No cached price seeded → yield is null (price-free path), holdings still present.
      expect(d?.dividends.trailingYield).toBeNull();
    });
  });

  it("a stock has no holdings block", async () => {
    await run(async () => {
      await refreshUsSecurities({
        fetchText: async () => directory(stockLine("AAPL", "Apple Inc - Common Stock")),
        seenAt: "2026-06-26T00:00:00Z",
      });
      const d = getUsSecurityDetail("AAPL");
      expect(d?.security.securityType).toBe("stock");
      expect(d?.holdings).toBeNull();
    });
  });

  it("returns null for an uncatalogued symbol", async () => {
    await run(async () => {
      expect(getUsSecurityDetail("NOPE")).toBeNull();
    });
  });

  it("merges the held-via ETFs into 'own the index' with weight + fee", async () => {
    await run(async () => {
      await refreshUsSecurities({
        fetchText: async () =>
          directory(
            stockLine("AAPL", "Apple Inc - Common Stock"),
            etfLine("VOO", "Vanguard S&P 500 ETF"),
          ),
        seenAt: "2026-06-26T00:00:00Z",
      });
      setEtfHoldings(
        "VOO",
        [holding("Apple Inc.", 6.6, "US")],
        "2026-03-31",
        "2026-06-26T01:00:00Z",
      );
      // Stamp the crosswalk so VOO's Apple holding resolves to AAPL (held-via link).
      getMarketDb()
        .update(usEtfHoldings)
        .set({ resolvedSymbol: "AAPL" })
        .where(sql`${usEtfHoldings.symbol} = 'VOO'`)
        .run();

      const d = getUsSecurityDetail("AAPL");
      const voo = d?.relatedEtfs.find((e) => e.symbol === "VOO");
      expect(voo?.weightPct).toBe(6.6); // held-via weight folded in
    });
  });
});

describe("mergeRelatedEtfs (pure)", () => {
  const etf = (
    symbol: string,
    ter: number | null,
    group: RelatedEtf["group"] = "broad",
    popularityScore = 0,
  ): RelatedEtf => ({
    symbol,
    name: `${symbol} ETF`,
    ter,
    securityType: "etf",
    popularityScore,
    group,
  });
  const heldVia = (
    symbol: string,
    weightPct: number,
    ter: number | null,
    popularityScore = 0,
  ): HeldViaEtf => ({
    symbol,
    name: `${symbol} ETF`,
    weightPct,
    ter,
    popularityScore,
  });

  it("dedups an ETF that both tracks and holds, keeping its fee + weight, cheapest first", () => {
    const merged = mergeRelatedEtfs(
      [etf("QQQ", 0.002), etf("SPLG", 0.0002)],
      [heldVia("QQQ", 7.63, 0.002), heldVia("VTI", 6.0, 0.0003)],
    );
    // Grouped broad → holder, each cheapest-first: broad [SPLG 0.02%, QQQ 0.20%]
    // then the held-via-only VTI in the trailing "holder" group.
    expect(merged.map((e) => e.symbol)).toEqual(["SPLG", "QQQ", "VTI"]);
    // QQQ appears ONCE, carrying both its fee and its AAPL weight; it's a tracker
    // so it's flagged as an index ETF.
    const qqq = merged.filter((e) => e.symbol === "QQQ");
    expect(qqq).toHaveLength(1);
    expect(qqq[0]).toMatchObject({ ter: 0.002, weightPct: 7.63, isIndex: true });
    // A tracker with no held-via weight stays weightless but is still index.
    expect(merged.find((e) => e.symbol === "SPLG")).toMatchObject({
      weightPct: null,
      isIndex: true,
    });
    // A held-via-only ETF is kept but NOT flagged index (we can't confirm it).
    expect(merged.find((e) => e.symbol === "VTI")).toMatchObject({
      weightPct: 6.0,
      isIndex: false,
    });
  });

  it("keeps a higher-fee sector ETF in its own group after the cheap broad ones", () => {
    // Broad VOO/SPLG are far cheaper than the sector XLK; a flat cheapest-first cap
    // would bury or drop XLK. Grouping emits broad → sector, so XLK still surfaces.
    const merged = mergeRelatedEtfs(
      [etf("SPLG", 0.0002), etf("VOO", 0.0003), etf("XLK", 0.0009, "sector")],
      [heldVia("XLK", 22.5, 0.0009)],
    );
    expect(merged.map((e) => e.symbol)).toEqual(["SPLG", "VOO", "XLK"]);
    const xlk = merged.find((e) => e.symbol === "XLK");
    // The sector ETF keeps its group + index flag and gains the held-via weight.
    expect(xlk).toMatchObject({ group: "sector", isIndex: true, weightPct: 22.5 });
  });

  it("breaks an equal-fee, equal-weight tie by popularity, then ticker", () => {
    // Same TER, no held-via weight → the more-popular tracker leads even though
    // its ticker sorts later (matches the Explore starter-shelf tiebreak).
    const merged = mergeRelatedEtfs(
      [etf("AAA", 0.0003, "broad", 0.1), etf("ZED", 0.0003, "broad", 0.9)],
      [],
    );
    expect(merged.map((e) => e.symbol)).toEqual(["ZED", "AAA"]);
  });
});

describe("resolveUsHolding — surfaces securityType for the row type chip", () => {
  it("returns 'etf' for an ETF and 'stock' for a single name", async () => {
    await run(async () => {
      await refreshUsSecurities({
        fetchText: async () =>
          directory(etfLine("QQQM", "Invesco NASDAQ 100 ETF"), stockLine("AAPL", "Apple Inc.")),
        seenAt: "2026-06-26T00:00:00Z",
      });
      expect(resolveUsHolding({ ticker: "QQQM" })?.securityType).toBe("etf");
      expect(resolveUsHolding({ ticker: "AAPL" })?.securityType).toBe("stock");
      // Case-insensitive lookup, same as the rest of the resolver.
      expect(resolveUsHolding({ ticker: "aapl" })?.securityType).toBe("stock");
      // An uncatalogued ticker still resolves to null (no chip, not a guess).
      expect(resolveUsHolding({ ticker: "NOPE" })).toBeNull();
    });
  });
});
