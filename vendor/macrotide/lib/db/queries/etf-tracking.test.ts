import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMarketDb, runWithDbContext } from "@/lib/db/context";
import { usEtfHoldings } from "@/lib/db/schema";
import { refreshUsSecurities } from "@/lib/jobs/refresh-us-securities";
import { makeTestDbContext } from "@/tests/db-helpers";
import { buildCandidateSets, deriveEtfTracking, getEtfsTrackingIndex } from "./etf-tracking";
import { setEtfHoldings } from "./us-etf-holdings";
import { applyIndexMembership, getUsSecurity } from "./us-securities";

describe("buildCandidateSets (pure)", () => {
  const rows = [
    { symbol: "AAPL", indices: "sp500,nasdaq100", gicsSector: "Information Technology" },
    { symbol: "MSFT", indices: "sp500,nasdaq100", gicsSector: "Information Technology" },
    { symbol: "XOM", indices: "sp500", gicsSector: "Energy" },
    { symbol: "IBM", indices: "sp500,dow", gicsSector: "Information Technology" },
    { symbol: "VOO", indices: null, gicsSector: null }, // an ETF — contributes nothing
    { symbol: "FOO", indices: "russell2000", gicsSector: null }, // uncovered index ignored
  ];

  it("groups broad indices and S&P sector slices, uppercased", () => {
    const byKey = new Map(buildCandidateSets(rows).map((c) => [c.key, c.members]));
    expect([...(byKey.get("sp500") ?? [])].sort()).toEqual(["AAPL", "IBM", "MSFT", "XOM"]);
    expect([...(byKey.get("nasdaq100") ?? [])].sort()).toEqual(["AAPL", "MSFT"]);
    expect([...(byKey.get("dow") ?? [])].sort()).toEqual(["IBM"]);
    // Sector sets come from gics_sector (S&P 500 members only).
    expect([...(byKey.get("sector:it") ?? [])].sort()).toEqual(["AAPL", "IBM", "MSFT"]);
    expect([...(byKey.get("sector:energy") ?? [])].sort()).toEqual(["XOM"]);
    // An uncovered index key (russell2000) produces no candidate set.
    expect(byKey.has("russell2000")).toBe(false);
  });
});

// ── integration: derive tracks_index from real holdings + membership ──

const HEADER =
  "Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares";
const line = (symbol: string, name: string, isEtf: boolean) =>
  `Y|${symbol}|${name}|Q| |${isEtf ? "Y" : "N"}|100|N||${symbol}|${symbol}|N`;
const directory = (...lines: string[]) => [HEADER, ...lines].join("\n");

const hoisted = vi.hoisted(() => ({ ctx: null as ReturnType<typeof makeTestDbContext> | null }));
function run<T>(fn: () => T | Promise<T>): Promise<T> {
  if (!hoisted.ctx) throw new Error("no ctx");
  return runWithDbContext(hoisted.ctx, fn) as Promise<T>;
}
beforeEach(() => {
  hoisted.ctx = makeTestDbContext();
});

describe("deriveEtfTracking (integration)", () => {
  it("matches a full-replication S&P 500 ETF to sp500 and powers the reverse lookup", async () => {
    await run(async () => {
      await refreshUsSecurities({
        fetchText: async () =>
          directory(
            line("AAPL", "Apple Inc.", false),
            line("MSFT", "Microsoft Corp", false),
            line("NVDA", "NVIDIA Corp", false),
            line("VOO", "Vanguard S&P 500 ETF", true),
            line("VTI", "Vanguard Total Stock Market ETF", true),
            line("BND", "Vanguard Total Bond ETF", true),
          ),
        seenAt: "2026-06-26T00:00:00Z",
      });
      applyIndexMembership([
        { symbol: "AAPL", indices: ["sp500"] },
        { symbol: "MSFT", indices: ["sp500"] },
        { symbol: "NVDA", indices: ["sp500"] },
      ]);

      // VOO holds exactly the S&P constituents (resolved); BND holds none of them.
      const stampHolding = (etf: string, resolved: string) =>
        getMarketDb()
          .update(usEtfHoldings)
          .set({ resolvedSymbol: resolved })
          .where(sql`${usEtfHoldings.symbol} = ${etf} AND ${usEtfHoldings.name} = ${resolved}`)
          .run();
      const megacaps = ["AAPL", "MSFT", "NVDA"].map((n, i) => ({
        name: n,
        ticker: null,
        assetClass: "Equity (common)",
        isin: null,
        cusip: null,
        weightPct: 10 - i,
        country: "US",
      }));
      // VOO's top holdings ARE the whole index (total count 3 ≈ index size 3).
      setEtfHoldings("VOO", megacaps, "2026-03-31", "2026-06-26T01:00:00Z", 3);
      // VTI holds the SAME megacaps at the top, but ~10× as many in total — the
      // count is the only thing that says it isn't the S&P 500.
      setEtfHoldings("VTI", megacaps, "2026-03-31", "2026-06-26T01:00:00Z", 30);
      for (const etf of ["VOO", "VTI"])
        for (const s of ["AAPL", "MSFT", "NVDA"]) stampHolding(etf, s);

      const res = deriveEtfTracking();
      expect(res.tracked).toBe(1);
      expect(getUsSecurity("VOO")?.tracksIndex).toBe("sp500");
      // Same top holdings, but 30 total ≫ index size → NOT the S&P 500.
      expect(getUsSecurity("VTI")?.tracksIndex).toBeNull();
      expect(getUsSecurity("BND")?.tracksIndex).toBeNull();
      expect(getEtfsTrackingIndex("sp500").map((e) => e.symbol)).toEqual(["VOO"]);

      // Idempotent: a second pass keeps the same result.
      deriveEtfTracking();
      expect(getUsSecurity("VOO")?.tracksIndex).toBe("sp500");
    });
  });
});
