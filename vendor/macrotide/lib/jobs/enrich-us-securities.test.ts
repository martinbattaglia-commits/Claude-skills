import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithDbContext } from "@/lib/db/context";
import { getUsSecurity } from "@/lib/db/queries/us-securities";
import type { UsFundamentals, UsProfile } from "@/lib/market/edgar";
import { makeTestDbContext } from "@/tests/db-helpers";
import { enrichUsSecurities, toEnrichmentPatch } from "./enrich-us-securities";
import { refreshUsSecurities } from "./refresh-us-securities";

const PROFILE: UsProfile = {
  cik: "0000320193",
  name: "Apple Inc.",
  exchange: "Nasdaq",
  sic: "3571",
  sicDescription: "Electronic Computers",
  stateOfIncorporation: "CA",
  fiscalYearEnd: "0926",
  tickers: ["AAPL"],
};

const FUNDAMENTALS: UsFundamentals = {
  epsDiluted: 6.08,
  netIncome: 93_736_000_000,
  revenue: 391_035_000_000,
  equity: 56_950_000_000,
  sharesOutstanding: 15_115_823_000,
  asOf: "2024-10-18",
};

describe("toEnrichmentPatch (pure)", () => {
  it("folds profile + fundamentals + our price into a full patch", () => {
    const p = toEnrichmentPatch("AAPL", "0000320193", PROFILE, FUNDAMENTALS, 230);
    expect(p.cik).toBe("0000320193");
    expect(p.industry).toBe("Electronic Computers");
    expect(p.sic).toBe("3571");
    expect(p.epsDiluted).toBe(6.08);
    expect(p.sharesOutstanding).toBe(15_115_823_000);
    expect(p.marketCap).toBeCloseTo(230 * 15_115_823_000, 0);
    expect(p.peRatio).toBeCloseTo(230 / 6.08, 2);
    expect(p.fundamentalsAsOf).toBe("2024-10-18");
  });

  it("stamps a bare patch (symbol+cik only) when SEC has no match", () => {
    expect(toEnrichmentPatch("ZZZZ", null, null, null, null)).toEqual({
      symbol: "ZZZZ",
      cik: null,
    });
  });
});

// ── integration: real market.db via the test context ──

const dirLine = (symbol: string, name: string) =>
  `Y|${symbol}|${name}|Q| |N|100|N||${symbol}|${symbol}|N`;
const HEADER =
  "Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares";
const directory = (...lines: string[]) => [HEADER, ...lines].join("\n");

const hoisted = vi.hoisted(() => ({ ctx: null as ReturnType<typeof makeTestDbContext> | null }));
function run<T>(fn: () => T | Promise<T>): Promise<T> {
  if (!hoisted.ctx) throw new Error("no ctx");
  return runWithDbContext(hoisted.ctx, fn) as Promise<T>;
}

beforeEach(() => {
  hoisted.ctx = makeTestDbContext();
});

describe("enrichUsSecurities", () => {
  it("writes profile + fundamentals + ratios onto the catalog row", async () => {
    await run(async () => {
      await refreshUsSecurities({
        fetchText: async () => directory(dirLine("AAPL", "Apple Inc - Common Stock")),
        seenAt: "2026-06-26T00:00:00Z",
      });

      const res = await enrichUsSecurities({
        symbols: ["AAPL"],
        enrichedAt: "2026-06-26T01:00:00Z",
        resolveCik: async () => ({ cik: "0000320193" }),
        getProfile: async () => PROFILE,
        getFundamentals: async () => FUNDAMENTALS,
        priceFor: () => 230,
      });
      expect(res).toEqual({
        selected: 1,
        enriched: 1,
        withProfile: 1,
        withFundamentals: 1,
        gicsApplied: 0,
        indicesApplied: 0,
      });

      const row = getUsSecurity("AAPL");
      expect(row?.industry).toBe("Electronic Computers");
      expect(row?.epsDiluted).toBe(6.08);
      expect(row?.marketCap).toBeCloseTo(230 * 15_115_823_000, 0);
      expect(row?.peRatio).toBeCloseTo(230 / 6.08, 2);
      expect(row?.lastEnrichedAt).toBe("2026-06-26T01:00:00Z");
    });
  });

  it("bulk-applies GICS sectors + index membership without stamping last_enriched_at", async () => {
    await run(async () => {
      await refreshUsSecurities({
        fetchText: async () => directory(dirLine("AAPL", "Apple Inc - Common Stock")),
        seenAt: "2026-06-26T00:00:00Z",
      });
      const res = await enrichUsSecurities({
        symbols: [], // no per-symbol enrichment, datasets only
        applyGics: true,
        applyIndices: true,
        enrichedAt: "2026-06-26T02:00:00Z",
        getGics: async () => [
          {
            symbol: "AAPL",
            gicsSector: "Information Technology",
            gicsSubIndustry: "Technology Hardware",
          },
          { symbol: "NOTLISTED", gicsSector: "Energy", gicsSubIndustry: "" },
        ],
        getIndices: async () => [
          { symbol: "AAPL", indices: ["sp500", "nasdaq100"] },
          { symbol: "NOTLISTED", indices: ["dow"] },
        ],
      });
      expect(res.gicsApplied).toBe(1); // only the catalogued AAPL matched
      expect(res.indicesApplied).toBe(1);
      const row = getUsSecurity("AAPL");
      expect(row?.gicsSector).toBe("Information Technology");
      expect(row?.gicsSubIndustry).toBe("Technology Hardware");
      expect(row?.indices).toBe("sp500,nasdaq100");
      // Datasets must NOT mark the symbol as profile/fundamentals-enriched.
      expect(row?.lastEnrichedAt).toBeNull();
    });
  });

  it("still stamps last_enriched_at for a symbol SEC can't resolve (no retry storm)", async () => {
    await run(async () => {
      await refreshUsSecurities({
        fetchText: async () => directory(dirLine("ZZZZ", "Mystery Co - Common Stock")),
        seenAt: "2026-06-26T00:00:00Z",
      });
      const res = await enrichUsSecurities({
        symbols: ["ZZZZ"],
        enrichedAt: "2026-06-26T01:00:00Z",
        resolveCik: async () => null,
        getProfile: async () => PROFILE, // never called
        getFundamentals: async () => FUNDAMENTALS,
        priceFor: () => null,
      });
      expect(res.withProfile).toBe(0);
      expect(res.enriched).toBe(1);
      const row = getUsSecurity("ZZZZ");
      expect(row?.lastEnrichedAt).toBe("2026-06-26T01:00:00Z");
      expect(row?.industry).toBeNull();
    });
  });
});
