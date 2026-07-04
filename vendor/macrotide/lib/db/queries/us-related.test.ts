import { describe, expect, it } from "vitest";
import { getRelatedByIndex, indexKeysFor, type RelatedDeps, type RelatedFund } from "./us-related";
import type { UsSecurity } from "./us-securities";

const sec = (over: Partial<UsSecurity>): UsSecurity =>
  ({
    symbol: "AAPL",
    name: "Apple Inc.",
    securityType: "stock",
    exchange: "Nasdaq",
    indices: null,
    tracksIndex: null,
    ter: null,
    popularityScore: 0,
    ...over,
  }) as unknown as UsSecurity;

describe("indexKeysFor (pure)", () => {
  it("reads a stock's comma-joined membership keys", () => {
    expect(indexKeysFor(sec({ indices: "sp500,nasdaq100" }))).toEqual(["sp500", "nasdaq100"]);
  });

  it("ignores unknown keys and blank membership", () => {
    expect(indexKeysFor(sec({ indices: "sp500,russell2000" }))).toEqual(["sp500"]);
    expect(indexKeysFor(sec({ indices: null }))).toEqual([]);
  });

  it("appends a stock's GICS sector key after its broad memberships", () => {
    // A tech stock: broad indices first (the cheap default route), then its sector
    // key so sector ETFs (XLK/VGT) surface as their own group.
    expect(
      indexKeysFor(sec({ indices: "sp500,nasdaq100", gicsSector: "Information Technology" })),
    ).toEqual(["sp500", "nasdaq100", "sector:it"]);
    // No sector data → broad only.
    expect(indexKeysFor(sec({ indices: "sp500", gicsSector: null }))).toEqual(["sp500"]);
  });

  it("reads an ETF's derived tracked index (broad or sector), not membership", () => {
    expect(indexKeysFor(sec({ symbol: "VOO", securityType: "etf", tracksIndex: "sp500" }))).toEqual(
      ["sp500"],
    );
    expect(
      indexKeysFor(sec({ symbol: "XLK", securityType: "etf", tracksIndex: "sector:it" })),
    ).toEqual(["sector:it"]);
  });

  it("falls back to the ETF name when derivation hasn't resolved a tracked index", () => {
    expect(
      indexKeysFor(
        sec({
          symbol: "SPLW",
          securityType: "etf",
          name: "Invesco S&P 500 fund",
          tracksIndex: null,
        }),
      ),
    ).toEqual(["sp500"]);
    expect(
      indexKeysFor(sec({ symbol: "ZZZZ", securityType: "etf", name: "Some Bond ETF" })),
    ).toEqual([]);
  });
});

describe("getRelatedByIndex", () => {
  const etf = (over: Partial<UsSecurity>) => sec({ securityType: "etf", ...over });
  // VOO and IVV share a TER (0.0003) — VOO's higher popularity breaks the tie.
  const sp500Etfs: UsSecurity[] = [
    etf({ symbol: "VOO", name: "Vanguard S&P 500 ETF", ter: 0.0003, popularityScore: 0.9 }),
    etf({ symbol: "IVV", name: "iShares Core S&P 500 ETF", ter: 0.0003, popularityScore: 0.5 }),
    etf({ symbol: "SPY", name: "SPDR S&P 500 ETF", ter: 0.0945 }),
    etf({ symbol: "SPLG", name: "SPDR Portfolio S&P 500 ETF", ter: 0.0002 }),
  ];
  const techEtfs: UsSecurity[] = [
    etf({
      symbol: "XLK",
      name: "Technology Select Sector SPDR",
      ter: 0.0009,
      popularityScore: 0.8,
    }),
    etf({ symbol: "VGT", name: "Vanguard Information Technology ETF", ter: 0.0009 }),
  ];
  const byKey: Record<string, UsSecurity[]> = { sp500: sp500Etfs, "sector:it": techEtfs };
  const thai: RelatedFund[] = [
    { projId: "P-A", ticker: "FUND-A", name: "Cheap S&P 500 Fund", ter: 0.2 },
    { projId: "P-B", ticker: "FUND-B", name: "Pricey S&P 500 Fund", ter: 0.9 },
  ];
  const deps: RelatedDeps = {
    getEtfsTracking: (key) => byKey[key] ?? [],
    findThaiByFamily: (fam) => (fam === "S&P 500" ? thai : []),
    getFeederWeights: () => new Map(),
  };

  it("returns same-index ETFs cheapest-first and excludes self", () => {
    const r = getRelatedByIndex(sec({ symbol: "AAPL", indices: "sp500" }), deps);
    expect(r.indexNames).toEqual(["S&P 500"]);
    // cheapest TER; the VOO/IVV TER tie breaks on popularity (VOO > IVV)
    expect(r.usEtfs.map((e) => e.symbol)).toEqual(["SPLG", "VOO", "IVV", "SPY"]);
    expect(r.thaiFunds.map((f) => f.projId)).toEqual(["P-A", "P-B"]); // cheapest first
  });

  it("excludes the security itself from its own ETF list", () => {
    const voo = etf({ symbol: "VOO", name: "Vanguard S&P 500 ETF", tracksIndex: "sp500" });
    const r = getRelatedByIndex(voo, deps);
    expect(r.usEtfs.map((e) => e.symbol)).not.toContain("VOO");
    expect(r.usEtfs.map((e) => e.symbol)).toEqual(["SPLG", "IVV", "SPY"]);
  });

  it("labels a sector ETF's index and skips Thai (no Thai sector funds)", () => {
    const xlk = etf({
      symbol: "XLK",
      name: "Technology Select Sector SPDR",
      tracksIndex: "sector:it",
    });
    const r = getRelatedByIndex(xlk, deps);
    expect(r.indexNames).toEqual(["Information Technology sector"]);
    expect(r.usEtfs.map((e) => e.symbol)).toEqual(["VGT"]); // self (XLK) excluded
    expect(r.thaiFunds).toEqual([]);
  });

  it("is empty when the security maps to no tracked index", () => {
    const r = getRelatedByIndex(sec({ symbol: "AAPL", indices: null }), deps);
    expect(r).toEqual({ indexNames: [], usEtfs: [], thaiFunds: [] });
  });

  it("annotates Thai funds with the security's transitive weight (feeder look-through)", () => {
    const r = getRelatedByIndex(sec({ symbol: "AAPL", indices: "sp500" }), {
      ...deps,
      getFeederWeights: (sym) => (sym === "AAPL" ? new Map([["P-A", 6.65]]) : new Map()),
    });
    expect(r.thaiFunds.find((f) => f.projId === "P-A")?.weightPct).toBe(6.65);
    // A fund with no look-through match carries null, not a fabricated 0.
    expect(r.thaiFunds.find((f) => f.projId === "P-B")?.weightPct).toBeNull();
  });

  it("dedups Thai funds across multiple indices", () => {
    const r = getRelatedByIndex(sec({ symbol: "AAPL", indices: "sp500,nasdaq100" }), {
      ...deps,
      findThaiByFamily: () => thai, // same funds returned for every family
    });
    expect(r.thaiFunds.map((f) => f.projId)).toEqual(["P-A", "P-B"]);
  });
});
