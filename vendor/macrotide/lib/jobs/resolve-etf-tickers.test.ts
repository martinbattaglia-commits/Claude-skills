import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithDbContext } from "@/lib/db/context";
import {
  getEtfHoldings,
  getEtfsHoldingSymbol,
  setEtfHoldings,
} from "@/lib/db/queries/us-etf-holdings";
import { refreshUsSecurities } from "@/lib/jobs/refresh-us-securities";
import type { NportHolding } from "@/lib/market/providers/edgar-nport";
import { makeTestDbContext } from "@/tests/db-helpers";
import { inferIdType } from "../db/queries/security-id-map";
import { resolveEtfTickers } from "./resolve-etf-tickers";

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

const etfLine = (symbol: string, name: string) =>
  `Y|${symbol}|${name}|P| |Y|100|N||${symbol}|${symbol}|N`;
const HEADER =
  "Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares";

const hoisted = vi.hoisted(() => ({ ctx: null as ReturnType<typeof makeTestDbContext> | null }));
function run<T>(fn: () => T | Promise<T>): Promise<T> {
  if (!hoisted.ctx) throw new Error("no ctx");
  return runWithDbContext(hoisted.ctx, fn) as Promise<T>;
}
beforeEach(() => {
  hoisted.ctx = makeTestDbContext();
});

describe("inferIdType (pure)", () => {
  it("recognizes a 12-char ISIN vs a 9-char CUSIP", () => {
    expect(inferIdType("US0378331005")).toBe("ID_ISIN");
    expect(inferIdType("037833100")).toBe("ID_CUSIP");
    expect(inferIdType("67066G104")).toBe("ID_CUSIP");
  });
});

describe("resolveEtfTickers", () => {
  async function seedVooHoldings() {
    await refreshUsSecurities({
      fetchText: async () => [HEADER, etfLine("VOO", "Vanguard S&P 500 ETF")].join("\n"),
      seenAt: "2026-06-26T00:00:00Z",
    });
    setEtfHoldings(
      "VOO",
      [
        H({ name: "Apple Inc.", cusip: "037833100", weightPct: 7.5 }),
        H({ name: "Microsoft", isin: "US5949181045", weightPct: 6.4 }),
        H({ name: "US Treasury Bill", cusip: "912796XyZ", weightPct: 1.0 }), // won't resolve
      ],
      "2026-03-31",
      "2026-06-26T01:00:00Z",
    );
  }

  it("resolves CUSIP/ISIN → ticker, caches, and stamps resolved_symbol", async () => {
    await run(async () => {
      await seedVooHoldings();
      const mapIds = vi.fn(
        async () =>
          new Map([
            ["037833100", "AAPL"],
            ["US5949181045", "MSFT"],
          ]),
      );
      const r = await resolveEtfTickers({ mapIds, resolvedAt: "2026-06-30T00:00:00Z" });
      expect(r.candidates).toBe(3);
      expect(r.attempted).toBe(3);
      expect(r.resolved).toBe(2);

      const byName = new Map(getEtfHoldings("VOO").holdings.map((h) => [h.name, h.resolvedSymbol]));
      expect(byName.get("Apple Inc.")).toBe("AAPL");
      expect(byName.get("Microsoft")).toBe("MSFT");
      expect(byName.get("US Treasury Bill")).toBeNull(); // unresolved → null
    });
  });

  it("does not re-hit OpenFIGI for ids already attempted (resolved or unresolvable)", async () => {
    await run(async () => {
      await seedVooHoldings();
      const first = vi.fn(async () => new Map([["037833100", "AAPL"]]));
      await resolveEtfTickers({ mapIds: first, resolvedAt: "2026-06-30T00:00:00Z" });
      expect(first).toHaveBeenCalledTimes(1);

      // Second run: all three ids are now cached (AAPL resolved; MSFT + T-bill recorded
      // as null markers), so nothing new is sent — but resolved_symbol is re-stamped.
      const second = vi.fn(async () => new Map());
      const r = await resolveEtfTickers({ mapIds: second, resolvedAt: "2026-07-01T00:00:00Z" });
      expect(r.candidates).toBe(0);
      expect(r.attempted).toBe(0);
      expect(second).not.toHaveBeenCalled();
      const apple = getEtfHoldings("VOO").holdings.find((h) => h.name === "Apple Inc.");
      expect(apple?.resolvedSymbol).toBe("AAPL");
    });
  });

  it("reverse lookup: getEtfsHoldingSymbol lists the ETFs holding a ticker, heaviest first", async () => {
    await run(async () => {
      await refreshUsSecurities({
        fetchText: async () =>
          [
            HEADER,
            etfLine("VOO", "Vanguard S&P 500 ETF"),
            etfLine("IVV", "iShares Core S&P 500"),
          ].join("\n"),
        seenAt: "2026-06-26T00:00:00Z",
      });
      setEtfHoldings(
        "VOO",
        [H({ name: "Apple Inc.", cusip: "037833100", weightPct: 7.5 })],
        "2026-03-31",
        "2026-06-26T01:00:00Z",
      );
      setEtfHoldings(
        "IVV",
        [H({ name: "Apple Inc.", cusip: "037833100", weightPct: 6.4 })],
        "2026-03-31",
        "2026-06-26T01:00:00Z",
      );
      await resolveEtfTickers({
        mapIds: vi.fn(async () => new Map([["037833100", "AAPL"]])),
        resolvedAt: "2026-06-30T00:00:00Z",
      });

      const heldVia = getEtfsHoldingSymbol("aapl"); // case-insensitive
      expect(heldVia.map((e) => e.symbol)).toEqual(["VOO", "IVV"]); // by weight desc
      expect(heldVia[0].weightPct).toBe(7.5);
      expect(heldVia[0].name).toBe("Vanguard S&P 500 ETF");
      // A ticker no ETF holds → empty.
      expect(getEtfsHoldingSymbol("TSLA")).toEqual([]);
    });
  });
});
