import { describe, expect, it } from "vitest";
import { withFreshContext } from "@/tests/db-helpers";
import {
  bumpUsSymbolDemand,
  getUsSecurity,
  setPopularityScores,
  type UsSecurityInsert,
  upsertUsSecurities,
} from "../db/queries/us-securities";
import type { MostActive } from "../market/screener";
import { isLeveragedOrInverse, rankCandidates, refreshPopular } from "./refresh-popular";

describe("isLeveragedOrInverse", () => {
  it("flags leveraged/inverse products by name", () => {
    expect(isLeveragedOrInverse("Direxion Daily Semiconductor Bear 3X Shares")).toBe(true);
    expect(isLeveragedOrInverse("ProShares UltraPro QQQ")).toBe(true);
    expect(isLeveragedOrInverse("ProShares UltraPro Short QQQ")).toBe(true);
    expect(isLeveragedOrInverse("Direxion Daily Small Cap Bull 2X")).toBe(true);
  });

  it("leaves plain stocks and ETFs alone", () => {
    expect(isLeveragedOrInverse("Apple Inc. - Common Stock")).toBe(false);
    expect(isLeveragedOrInverse("Vanguard S&P 500 ETF")).toBe(false);
    // does NOT false-positive on a legit short-duration bond fund
    expect(isLeveragedOrInverse("iShares Short Treasury Bond ETF")).toBe(false);
  });
});

describe("rankCandidates", () => {
  it("ranks by dollar volume, drops leveraged/inverse, demotes penny stocks, normalizes to 0–1", () => {
    const ranked = rankCandidates(
      [
        { symbol: "VOO", volume: 1_000_000, close: 675, name: "Vanguard S&P 500 ETF" }, // 675M
        { symbol: "NVDA", volume: 4_000_000, close: 150, name: "NVIDIA Corp" }, // 600M
        { symbol: "AAPL", volume: 2_000_000, close: 275, name: "Apple Inc." }, // 550M
        { symbol: "SOXS", volume: 50_000_000, close: 12, name: "Direxion … Bear 3X Shares" }, // filtered
        { symbol: "PENNY", volume: 100_000_000, close: 0.5, name: "Penny Co" }, // 50M, demoted
      ],
      3,
    );
    expect(ranked.map((r) => r.symbol)).toEqual(["VOO", "NVDA", "AAPL"]);
    expect(ranked[0].score).toBe(1); // max dollar volume normalizes to 1
    expect(ranked[1].score).toBeCloseTo(600 / 675, 5);
    expect(ranked.find((r) => r.symbol === "SOXS")).toBeUndefined();
    expect(ranked.find((r) => r.symbol === "PENNY")).toBeUndefined();
  });
});

const CATALOG: UsSecurityInsert[] = [
  { symbol: "VOO", name: "Vanguard S&P 500 ETF", securityType: "etf" },
  { symbol: "NVDA", name: "NVIDIA Corporation - Common Stock", securityType: "stock" },
  { symbol: "AAPL", name: "Apple Inc. - Common Stock", securityType: "stock" },
  { symbol: "SOXS", name: "Direxion Daily Semiconductor Bear 3X Shares", securityType: "etf" },
  { symbol: "PENNY", name: "Penny Co - Common Stock", securityType: "stock" },
  { symbol: "WATCHED", name: "Watched Inc. - Common Stock", securityType: "stock" },
  { symbol: "OLDPOP", name: "Formerly Popular ETF", securityType: "etf" },
];

const ACTIVES: MostActive[] = [
  { symbol: "VOO", volume: 1_000_000, tradeCount: 10 },
  { symbol: "NVDA", volume: 4_000_000, tradeCount: 10 },
  { symbol: "AAPL", volume: 2_000_000, tradeCount: 10 },
  { symbol: "SOXS", volume: 50_000_000, tradeCount: 10 },
  { symbol: "PENNY", volume: 100_000_000, tradeCount: 10 },
];

const CLOSES: Record<string, number> = {
  VOO: 675,
  NVDA: 150,
  AAPL: 275,
  SOXS: 12,
  PENNY: 0.5,
  WATCHED: 40,
};

describe("refreshPopular", () => {
  it("scores the popular set, warms demand extras, and decays the rest", async () => {
    const warmed: string[] = [];
    await withFreshContext(async () => {
      upsertUsSecurities(CATALOG, "2026-06-25T00:00:00Z");
      // A previously-popular symbol not in today's actives → should decay.
      setPopularityScores([{ symbol: "OLDPOP", score: 0.8 }], "2026-06-20T00:00:00Z");
      // A recently-viewed symbol not in actives → should be demand-warmed.
      bumpUsSymbolDemand("WATCHED", "2026-06-25T12:00:00Z");

      const res = await refreshPopular({
        popularKeep: 3,
        demandKeep: 5,
        decayStep: 0.1,
        seenAt: "2026-06-26T00:00:00Z",
        _fetchActives: async () => ACTIVES,
        _warm: async (symbol) => {
          warmed.push(symbol);
          return CLOSES[symbol] ?? null;
        },
      });

      expect(res.actives).toBe(5);
      expect(res.scored).toBe(3);

      // Popular set scored (VOO top), leveraged + penny excluded (stay 0).
      expect(getUsSecurity("VOO")?.popularityScore).toBe(1);
      expect(getUsSecurity("NVDA")?.popularityScore).toBeCloseTo(600 / 675, 5);
      expect(getUsSecurity("SOXS")?.popularityScore).toBe(0);
      expect(getUsSecurity("PENNY")?.popularityScore).toBe(0);

      // OLDPOP decayed 0.8 → 0.7 (not re-scored this run).
      expect(getUsSecurity("OLDPOP")?.popularityScore).toBeCloseTo(0.7, 5);

      // WATCHED was warmed via the demand half (not in actives).
      expect(res.demandWarmed).toBe(1);
      expect(warmed).toContain("WATCHED");
    });
  });

  it("still warms the demand half when most-actives is empty (no creds)", async () => {
    const warmed: string[] = [];
    await withFreshContext(async () => {
      upsertUsSecurities(CATALOG, "2026-06-25T00:00:00Z");
      bumpUsSymbolDemand("WATCHED", "2026-06-25T12:00:00Z");
      const res = await refreshPopular({
        seenAt: "2026-06-26T00:00:00Z",
        _fetchActives: async () => [],
        _warm: async (symbol) => {
          warmed.push(symbol);
          return CLOSES[symbol] ?? 1;
        },
      });
      expect(res.actives).toBe(0);
      expect(res.scored).toBe(0);
      expect(warmed).toContain("WATCHED");
    });
  });
});
