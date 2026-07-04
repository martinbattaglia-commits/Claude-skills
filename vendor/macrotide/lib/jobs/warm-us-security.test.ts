import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithDbContext } from "@/lib/db/context";
import { makeTestDbContext } from "@/tests/db-helpers";
import { refreshUsSecurities } from "./refresh-us-securities";
import { warmUsSecurity } from "./warm-us-security";

const stockLine = (s: string, n: string) => `Y|${s}|${n}|Q| |N|100|N||${s}|${s}|N`;
const etfLine = (s: string, n: string) => `Y|${s}|${n}|P| |Y|100|N||${s}|${s}|N`;
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

function stubs() {
  return {
    enrich: vi.fn(async () => ({
      selected: 1,
      enriched: 1,
      withProfile: 1,
      withFundamentals: 1,
      gicsApplied: 0,
      indicesApplied: 0,
    })),
    ensureHoldings: vi.fn(async () => undefined),
    ensureDivs: vi.fn(async () => undefined),
  };
}

describe("warmUsSecurity", () => {
  it("enriches + ensures dividends + holdings for a never-enriched ETF", async () => {
    await run(async () => {
      await refreshUsSecurities({
        fetchText: async () => directory(etfLine("VOO", "Vanguard S&P 500 ETF")),
        seenAt: "2026-06-26T00:00:00Z",
      });
      const s = stubs();
      await warmUsSecurity("VOO", s);
      expect(s.enrich).toHaveBeenCalledWith({ symbols: ["VOO"] });
      expect(s.ensureDivs).toHaveBeenCalledWith("VOO");
      expect(s.ensureHoldings).toHaveBeenCalledWith("VOO"); // ETF → holdings warmed
    });
  });

  it("skips holdings for a stock", async () => {
    await run(async () => {
      await refreshUsSecurities({
        fetchText: async () => directory(stockLine("AAPL", "Apple Inc - Common Stock")),
        seenAt: "2026-06-26T00:00:00Z",
      });
      const s = stubs();
      await warmUsSecurity("AAPL", s);
      expect(s.ensureHoldings).not.toHaveBeenCalled();
      expect(s.ensureDivs).toHaveBeenCalled();
    });
  });

  it("is a no-op for an uncatalogued symbol", async () => {
    await run(async () => {
      const s = stubs();
      await warmUsSecurity("NOPE", s);
      expect(s.enrich).not.toHaveBeenCalled();
      expect(s.ensureDivs).not.toHaveBeenCalled();
    });
  });
});
