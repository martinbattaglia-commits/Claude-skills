import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithDbContext } from "@/lib/db/context";
import { getEtfHoldings } from "@/lib/db/queries/us-etf-holdings";
import { getUsSecurity } from "@/lib/db/queries/us-securities";
import type { EtfHoldingsResult } from "@/lib/market/providers/edgar-nport";
import { makeTestDbContext } from "@/tests/db-helpers";
import { ensureEtfHoldings, refreshEtfHoldings } from "./refresh-etf-holdings";
import { refreshUsSecurities } from "./refresh-us-securities";

const etfLine = (symbol: string, name: string) =>
  `Y|${symbol}|${name}|P| |Y|100|N||${symbol}|${symbol}|N`;
const HEADER =
  "Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares";
const directory = (...lines: string[]) => [HEADER, ...lines].join("\n");

const result = (...names: string[]): EtfHoldingsResult => ({
  status: "ok",
  asOfDate: "2026-03-31",
  totalCount: names.length,
  holdings: names.map((name, i) => ({
    name,
    ticker: null,
    assetClass: "Equity (common)",
    isin: null,
    cusip: null,
    weightPct: 10 - i,
    country: "US",
  })),
});

const hoisted = vi.hoisted(() => ({ ctx: null as ReturnType<typeof makeTestDbContext> | null }));
function run<T>(fn: () => T | Promise<T>): Promise<T> {
  if (!hoisted.ctx) throw new Error("no ctx");
  return runWithDbContext(hoisted.ctx, fn) as Promise<T>;
}
beforeEach(() => {
  hoisted.ctx = makeTestDbContext();
});

async function seedEtf(symbol: string) {
  await refreshUsSecurities({
    fetchText: async () => directory(etfLine(symbol, `${symbol} Test ETF`)),
    seenAt: "2026-06-26T00:00:00Z",
  });
}

describe("refreshEtfHoldings", () => {
  it("fetches + stores holdings for the selected ETFs", async () => {
    await run(async () => {
      await seedEtf("VOO");
      const res = await refreshEtfHoldings({
        symbols: ["VOO"],
        fetchedAt: "2026-06-26T01:00:00Z",
        getHoldings: async () => result("Apple Inc.", "Microsoft"),
        getTer: async () => null,
      });
      expect(res).toEqual({
        selected: 1,
        withHoldings: 1,
        withTer: 0,
        errored: 0,
        tracked: 0,
        classified: 1,
      });
      expect(getEtfHoldings("VOO").holdings.map((h) => h.name)).toEqual([
        "Apple Inc.",
        "Microsoft",
      ]);
      // Derived from the all-equity, all-US look-through (#268).
      expect(getUsSecurity("VOO")?.assetClass).toBe("equity");
      expect(getUsSecurity("VOO")?.exposureRegion).toBe("US");
    });
  });

  it("writes the expense ratio (TER) when the 485BPOS parse returns one", async () => {
    await run(async () => {
      await seedEtf("VOO");
      const res = await refreshEtfHoldings({
        symbols: ["VOO"],
        fetchedAt: "2026-06-26T01:00:00Z",
        getHoldings: async () => result("Apple Inc."),
        getTer: async () => 0.0003,
      });
      expect(res.withTer).toBe(1);
      expect(getUsSecurity("VOO")?.ter).toBe(0.0003);
    });
  });

  it("caches + stamps a genuine empty (SPY/UIT, status=unresolved) so it isn't retried nightly", async () => {
    await run(async () => {
      await seedEtf("SPY");
      const res = await refreshEtfHoldings({
        symbols: ["SPY"],
        fetchedAt: "2026-06-26T01:00:00Z",
        getHoldings: async () => ({
          asOfDate: null,
          holdings: [],
          totalCount: 0,
          status: "unresolved",
        }),
        getTer: async () => null,
      });
      expect(res).toEqual({
        selected: 1,
        withHoldings: 0,
        withTer: 0,
        errored: 0,
        tracked: 0,
        classified: 0,
      });
      expect(getEtfHoldings("SPY").fetchedAt).toBe("2026-06-26T01:00:00Z");
    });
  });

  it("does NOT cache a transient error (status=error) — leaves it stale to retry", async () => {
    await run(async () => {
      await seedEtf("VOO");
      const res = await refreshEtfHoldings({
        symbols: ["VOO"],
        fetchedAt: "2026-06-26T01:00:00Z",
        getHoldings: async () => ({ asOfDate: null, holdings: [], totalCount: 0, status: "error" }),
        getTer: async () => null,
      });
      expect(res).toEqual({
        selected: 1,
        withHoldings: 0,
        withTer: 0,
        errored: 1,
        tracked: 0,
        classified: 0,
      });
      // Never stamped → still cold → will retry on the next run / JIT open.
      expect(getEtfHoldings("VOO").fetchedAt).toBeNull();
    });
  });
});

describe("ensureEtfHoldings (JIT warm-on-open)", () => {
  it("fetches when cold, then no-ops when fresh", async () => {
    await run(async () => {
      await seedEtf("VOO");
      let calls = 0;
      const getHoldings = async (): Promise<EtfHoldingsResult> => {
        calls++;
        return result("Apple Inc.");
      };

      await ensureEtfHoldings("VOO", { getHoldings, getTer: async () => null });
      expect(calls).toBe(1);
      expect(getEtfHoldings("VOO").holdings).toHaveLength(1);

      // Fresh now → second call is a no-op.
      await ensureEtfHoldings("VOO", { getHoldings, getTer: async () => null });
      expect(calls).toBe(1);
    });
  });

  it("refetches when the cached holdings are older than maxAgeDays", async () => {
    await run(async () => {
      await seedEtf("VOO");
      let calls = 0;
      const getHoldings = async (): Promise<EtfHoldingsResult> => {
        calls++;
        return result("Apple Inc.");
      };
      // Seed a stale fetched_at far in the past.
      await ensureEtfHoldings("VOO", {
        getHoldings,
        getTer: async () => null,
        fetchedAt: "2000-01-01T00:00:00Z",
      });
      expect(calls).toBe(1);
      await ensureEtfHoldings("VOO", { getHoldings, getTer: async () => null, maxAgeDays: 30 });
      expect(calls).toBe(2); // stale → refetched
    });
  });
});
