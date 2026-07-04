import { describe, expect, it } from "vitest";
import {
  type CandidateIndex,
  dominantSectorShare,
  pickTrackedIndex,
  type TrackingHolding,
  weightCoverage,
} from "./etf-tracking";

const set = (...xs: string[]) => new Set(xs);
const hold = (symbol: string, weightPct: number | null = 1): TrackingHolding => ({
  symbol,
  weightPct,
});
const holdS = (
  symbol: string,
  sector: string | null,
  weightPct: number | null = 1,
): TrackingHolding => ({ symbol, weightPct, sector });

// Synthetic universe: sp500 = S1..S10 (size 10); nasdaq100 = the 5 "megacaps"
// (all also in sp500); a tech sector slice = 3 names. Mirrors the real nesting.
const sp500 = set("S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10");
const nasdaq100 = set("S1", "S2", "S3", "S4", "S5");
const sectorTech = set("S1", "S2", "S6");
const candidates: CandidateIndex[] = [
  { key: "sp500", members: sp500 },
  { key: "nasdaq100", members: nasdaq100 },
  { key: "sector:tech", members: sectorTech },
];

// Stored (top-N) holdings for a fund — the megacaps, which every broad fund holds.
const topHoldings = [hold("S1"), hold("S2"), hold("S3"), hold("S4"), hold("S5")];

describe("weightCoverage", () => {
  it("is the share of resolved weight inside the index", () => {
    const holdings = [hold("S1", 40), hold("S2", 40), hold("X1", 20)];
    expect(weightCoverage(holdings, sp500)).toBeCloseTo(0.8, 5);
  });

  it("falls back to a count ratio when weights are unpublished", () => {
    const holdings = [hold("S1", null), hold("S2", null), hold("X1", null)];
    expect(weightCoverage(holdings, sp500)).toBeCloseTo(2 / 3, 5);
  });
});

describe("pickTrackedIndex", () => {
  it("matches a full-replication S&P 500 ETF (count ≈ index size)", () => {
    // Same megacap top holdings, total count = the S&P size.
    expect(pickTrackedIndex(topHoldings, 10, candidates)?.key).toBe("sp500");
  });

  it("rejects a total-market ETF: identical top holdings but far more of them", () => {
    // The stored top holdings look exactly like the S&P fund's — only the total
    // count (40 ≫ 10) tells them apart. No covered index has ~40 members → null.
    expect(pickTrackedIndex(topHoldings, 40, candidates)).toBeNull();
  });

  it("matches a Nasdaq-100 ETF to nasdaq100, not the broader sp500", () => {
    // Count 5 fits nasdaq100 (5) tightly; sp500's ratio 0.5 also passes the band
    // but the tighter size fit wins.
    const m = pickTrackedIndex(topHoldings, 5, candidates);
    expect(m?.key).toBe("nasdaq100");
    expect(m?.countRatio).toBe(1);
  });

  it("matches a sector ETF by its sector slice", () => {
    const xlk = [hold("S1"), hold("S2"), hold("S6")];
    expect(pickTrackedIndex(xlk, 3, candidates)?.key).toBe("sector:tech");
  });

  it("rejects when coverage is low (holdings aren't in the index)", () => {
    const offIndex = [hold("X1"), hold("X2"), hold("X3"), hold("X4"), hold("S1")];
    expect(pickTrackedIndex(offIndex, 10, candidates)).toBeNull();
  });

  it("is null with no holdings or an unknown count", () => {
    expect(pickTrackedIndex([], 10, candidates)).toBeNull();
    expect(pickTrackedIndex(topHoldings, 0, candidates)).toBeNull();
  });

  it("vetoes a broad match for a single-sector fund (a Vanguard sector ETF ≠ S&P 500)", () => {
    // All holdings are one sector, total count 7 fits the sp500 band (7/10=0.7) —
    // without the guard this would wrongly resolve to sp500 (its names are all S&P
    // members). The concentration guard rejects broad candidates; no sector index
    // has ~7 members, so it correctly resolves to nothing (the VTI→NULL principle).
    const techFund = [holdS("S1", "Tech"), holdS("S2", "Tech"), holdS("S6", "Tech")];
    expect(pickTrackedIndex(techFund, 7, candidates)).toBeNull();
  });

  it("still matches a sector fund to its own sector slice under the guard", () => {
    const xlk = [holdS("S1", "Tech"), holdS("S2", "Tech"), holdS("S6", "Tech")];
    expect(pickTrackedIndex(xlk, 3, candidates)?.key).toBe("sector:tech");
  });

  it("does not veto a broad fund whose holdings span sectors", () => {
    const broad = [
      holdS("S1", "Tech"),
      holdS("S2", "Tech"),
      holdS("S3", "Health"),
      holdS("S4", "Energy"),
      holdS("S5", "Financials"),
    ];
    expect(pickTrackedIndex(broad, 10, candidates)?.key).toBe("sp500");
  });
});

describe("dominantSectorShare", () => {
  it("is ~1 for a single-sector fund and lower for a diversified one", () => {
    expect(dominantSectorShare([holdS("S1", "Tech"), holdS("S2", "Tech")])).toBe(1);
    const mixed = [holdS("S1", "Tech", 30), holdS("S2", "Health", 30), holdS("S3", "Energy", 40)];
    expect(dominantSectorShare(mixed)).toBeCloseTo(0.4, 5);
  });

  it("is 0 when no holding carries a sector", () => {
    expect(dominantSectorShare([hold("S1"), hold("S2")])).toBe(0);
  });
});
