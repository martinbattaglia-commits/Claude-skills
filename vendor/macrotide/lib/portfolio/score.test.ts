import { describe, expect, it } from "vitest";
import type { Holding, MixSlice } from "@/lib/static/types";
import { computeHealth } from "./health";
import { scorePortfolio } from "./score";

// ─── Test fixture helpers ────────────────────────────────────────────────────

function holding(partial: Partial<Holding> & { ticker: string; value: number }): Holding {
  return {
    ticker: partial.ticker,
    name: partial.name ?? partial.ticker,
    category: partial.category ?? "Fund",
    class: partial.class ?? "equity",
    region: partial.region ?? "United States",
    value: partial.value,
    cost: partial.cost ?? partial.value,
    units: partial.units ?? 1,
    nav: partial.nav ?? 1,
    d1: 0,
    ytd: 0,
    y1: 0,
    ter: partial.ter === undefined ? 0 : partial.ter,
    source: "",
  };
}

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe("scorePortfolio — empty portfolio", () => {
  it("excludes drift (no target) and renormalises the rest for an empty portfolio", () => {
    // Empty portfolio: no holdings, totalValue = 0, no target.
    const health = computeHealth([], 0, null);
    const score = scorePortfolio(health, false);

    // total should be valid (0..100) and structured correctly
    expect(score.total).toBeGreaterThanOrEqual(0);
    expect(score.total).toBeLessThanOrEqual(100);
    expect(score.components).toHaveLength(4);
    expect(score.hasTarget).toBe(false);

    // Drift: no target → NOT scored (0/30, excluded from total).
    const drift = score.components.find((c) => c.key === "drift");
    expect(drift?.score).toBe(0);
    expect(drift?.detail).toContain("Not scored");

    // Cash: 0% cash → full marks (20)
    const cash = score.components.find((c) => c.key === "cash");
    expect(cash?.score).toBe(20);

    // Concentration: empty book has nothing to penalise → full marks (25)
    const conc = score.components.find((c) => c.key === "concentration");
    expect(conc?.score).toBe(25);

    // Fees: TER = 0 → 25 pts
    const fees = score.components.find((c) => c.key === "fees");
    expect(fees?.score).toBe(25);

    // total = renormalise(fees 25 + conc 25 + cash 20 = 70 of 65 max) → 100.
    // (An empty book has nothing to penalise on the scored axes → 100.)
    expect(score.total).toBe(100);
  });
});

// ─── Perfect alignment scenario ──────────────────────────────────────────────

describe("scorePortfolio — perfect alignment", () => {
  const perfectHoldings: Holding[] = [
    holding({ ticker: "SCBS&P500", value: 500, class: "equity", ter: 0.1 }),
    holding({ ticker: "K-WORLDX", value: 300, class: "equity", ter: 0.1 }),
    holding({ ticker: "K-FIXED-A", value: 200, class: "bond", ter: 0.1 }),
  ];
  const perfectMix: MixSlice[] = [
    { label: "US Equity", pct: 50, ticker: "SCBS&P500", color: "var(--accent)" },
    { label: "Global Equity", pct: 30, ticker: "K-WORLDX", color: "#7C7CFF" },
    { label: "Thai Bonds", pct: 20, ticker: "K-FIXED-A", color: "#F4A434" },
  ];

  it("scores very high when on-target, cheap, diversified, and no cash", () => {
    const health = computeHealth(perfectHoldings, 1000, perfectMix, 0.1);
    const score = scorePortfolio(health, true);

    // Drift: 0pp → 30/30
    expect(score.components.find((c) => c.key === "drift")?.score).toBe(30);

    // Fees: 0.10% TER ≤ 0.20% → 25/25
    expect(score.components.find((c) => c.key === "fees")?.score).toBe(25);

    // Cash: 0% → 20/20
    expect(score.components.find((c) => c.key === "cash")?.score).toBe(20);

    // 3 diversified equity/bond funds, no alt bet, no look-through → concentration
    // reads good (25). drift 30 + fees 25 + conc 25 + cash 20 = 100.
    expect(score.total).toBeGreaterThanOrEqual(80);
  });
});

// ─── Heavy drift ─────────────────────────────────────────────────────────────

describe("scorePortfolio — heavy drift", () => {
  // Holdings heavily overweight equities, underweight bonds
  const holdings: Holding[] = [
    holding({ ticker: "SCBS&P500", value: 900, class: "equity", ter: 0.3 }),
    holding({ ticker: "K-FIXED-A", value: 100, class: "bond", ter: 0.2 }),
  ];
  const target: MixSlice[] = [
    { label: "US Equity", pct: 60, ticker: "SCBS&P500", color: "var(--accent)" },
    { label: "Thai Bonds", pct: 40, ticker: "K-FIXED-A", color: "#F4A434" },
  ];

  it("deducts heavily from drift component when far off target", () => {
    const health = computeHealth(holdings, 1000, target);
    // trackingGapPp = overweight sum = SCBS&P500 +30pp = 30
    expect(health.trackingGapPp).toBeCloseTo(30);

    const score = scorePortfolio(health, true);
    const drift = score.components.find((c) => c.key === "drift");

    // 30pp drift → score = max(0, 30 - 30*2) = 0
    expect(drift?.score).toBe(0);
    expect(drift?.max).toBe(30);
  });

  it("keeps total score valid (0..100) under extreme drift", () => {
    const health = computeHealth(holdings, 1000, target);
    const score = scorePortfolio(health, true);
    expect(score.total).toBeGreaterThanOrEqual(0);
    expect(score.total).toBeLessThanOrEqual(100);
  });
});

// ─── Drift with no target ─────────────────────────────────────────────────────

describe("scorePortfolio — no target (hasTarget = false)", () => {
  const holdings: Holding[] = [
    holding({ ticker: "SCBS&P500", value: 800, class: "equity", ter: 1.5 }),
    holding({ ticker: "K-FIXED-A", value: 200, class: "bond", ter: 0.5 }),
  ];

  it("does NOT score drift when no target is set (0/30, CTA detail)", () => {
    const health = computeHealth(holdings, 1000, null);
    const score = scorePortfolio(health, false);
    const drift = score.components.find((c) => c.key === "drift");
    expect(drift?.score).toBe(0);
    expect(drift?.max).toBe(30);
    expect(drift?.detail).toContain("Not scored");
    expect(drift?.detail).toContain("set a target");
    expect(score.hasTarget).toBe(false);
  });

  it("excludes drift from the total and renormalises fees+conc+cash onto 0–100", () => {
    const health = computeHealth(holdings, 1000, null);
    const score = scorePortfolio(health, false);

    const scored = score.components.filter((c) => c.key !== "drift");
    const scoredSum = scored.reduce((s, c) => s + c.score, 0);
    const scoredMax = scored.reduce((s, c) => s + c.max, 0); // fees 25 + conc 25 + cash 20 = 70

    // total must equal round(scoredSum / scoredMax * 100), and must NOT include
    // any drift points.
    const expected = Math.round((scoredSum / scoredMax) * 100);
    expect(score.total).toBe(expected);

    // Sanity: the renormalised total scales the 70-point sum up onto 0–100,
    // and never exceeds 100.
    expect(score.total).toBeGreaterThanOrEqual(scoredSum);
    expect(score.total).toBeLessThanOrEqual(100);
  });

  it("does not inflate the headline vs the with-target equivalent", () => {
    // Same holdings; once with a perfectly-matched target, once without.
    // The old code auto-awarded drift 30 with no target, which inflated the
    // headline. With renormalisation, the no-target total should NOT exceed
    // the on-target total (which earns real drift points).
    const target: MixSlice[] = [
      { label: "US Equity", pct: 80, ticker: "SCBS&P500", color: "var(--accent)" },
      { label: "Thai Bonds", pct: 20, ticker: "K-FIXED-A", color: "#F4A434" },
    ];
    const withTarget = scorePortfolio(computeHealth(holdings, 1000, target), true);
    const noTarget = scorePortfolio(computeHealth(holdings, 1000, null), false);
    // On-target here is a perfect match → drift 30; no-target renormalises the
    // weaker axes (TER 1.3% blended) up, but must not beat the on-target score.
    expect(noTarget.total).toBeLessThanOrEqual(withTarget.total);
  });
});

// ─── Missing-fee handling ─────────────────────────────────────────────────────

describe("scorePortfolio — unknown TER (null)", () => {
  it("does not let unknown fees inflate the fee sub-score", () => {
    // One expensive known fund + one unknown-fee fund of equal value. The fee
    // score must reflect the known 1.7% rate, NOT a blended ~0.85% that the old
    // `ter ?? 0` would have produced by scoring the unknown as free.
    const holdings: Holding[] = [
      holding({ ticker: "PRICEY", value: 500, ter: 1.7 }),
      holding({ ticker: "MYSTERY", value: 500, ter: null }),
    ];
    const score = scorePortfolio(computeHealth(holdings, 1000, null), false);
    const fees = score.components.find((c) => c.key === "fees");

    // blendedTer over KNOWN only = 1.7% → max(0, round(25*(1-(1.7-0.2)/1.8))) = 4
    expect(fees?.score).toBe(4);
    // and the component flags the incomplete data.
    expect(fees?.detail).toContain("Fee data incomplete for 1 holding");
  });

  it("treats an explicit 0% TER as known (index-grade), not unknown", () => {
    const holdings: Holding[] = [holding({ ticker: "CHEAP", value: 1000, ter: 0 })];
    const score = scorePortfolio(computeHealth(holdings, 1000, null), false);
    const fees = score.components.find((c) => c.key === "fees");
    expect(fees?.score).toBe(25);
    expect(fees?.detail).not.toContain("incomplete");
  });
});

// ─── Fee component rules ──────────────────────────────────────────────────────

describe("scorePortfolio — fee component", () => {
  function healthWithTer(ter: number) {
    return computeHealth([holding({ ticker: "X", value: 1000, ter })], 1000, null);
  }

  it("awards 25 pts at index-grade TER (≤ 0.20%)", () => {
    const score = scorePortfolio(healthWithTer(0.1), false);
    expect(score.components.find((c) => c.key === "fees")?.score).toBe(25);
  });

  it("awards 25 pts exactly at the 0.20% boundary", () => {
    const score = scorePortfolio(healthWithTer(0.2), false);
    expect(score.components.find((c) => c.key === "fees")?.score).toBe(25);
  });

  it("awards 0 pts at TER ≥ 2.0%", () => {
    const score = scorePortfolio(healthWithTer(2.0), false);
    expect(score.components.find((c) => c.key === "fees")?.score).toBe(0);
  });

  it("awards 0 pts at TER > 2.0% (clamped)", () => {
    const score = scorePortfolio(healthWithTer(3.0), false);
    expect(score.components.find((c) => c.key === "fees")?.score).toBe(0);
  });

  it("interpolates linearly at TER = 1.1% (midpoint)", () => {
    // midpoint of [0.20, 2.0]: (0.20 + 2.0) / 2 = 1.10 → 12.5 pts → rounds to 13
    const score = scorePortfolio(healthWithTer(1.1), false);
    const feeScore = score.components.find((c) => c.key === "fees")?.score ?? -1;
    expect(feeScore).toBeGreaterThanOrEqual(12);
    expect(feeScore).toBeLessThanOrEqual(13);
  });
});

// ─── Concentration component rules ───────────────────────────────────────────

describe("scorePortfolio — concentration component", () => {
  const conc = (h: ReturnType<typeof computeHealth>) =>
    scorePortfolio(h, false).components.find((c) => c.key === "concentration");

  it("awards full marks for a well-spread portfolio", () => {
    const tenFunds = Array.from({ length: 10 }, (_, i) =>
      holding({ ticker: `FUND${i}`, value: 100 }),
    );
    expect(conc(computeHealth(tenFunds, 1000, null))?.score).toBe(25);
  });

  it("does NOT punish a single broad-index equity fund (the acid test)", () => {
    // The old HHI scored this 0; the new metric treats a single diversified
    // equity fund as fine when there's no look-through to say otherwise.
    const single = [holding({ ticker: "WORLD-EQ", value: 1000 })];
    expect(conc(computeHealth(single, 1000, null))?.score).toBe(25);
  });

  it("reads a clean world-equity + bond book as good", () => {
    const book = [
      holding({ ticker: "WORLD-EQ", class: "equity", value: 600 }),
      holding({ ticker: "BOND-FUND", class: "bond", value: 400 }),
    ];
    expect(conc(computeHealth(book, 1000, null))?.score).toBe(25);
  });

  it("flags a large single ALTERNATIVE position (act → ~4 pts)", () => {
    const book = [
      holding({ ticker: "WORLD-EQ", class: "equity", value: 600 }),
      holding({ ticker: "ONE-CRYPTO", class: "alternative", value: 400 }),
    ];
    // 40% in one alternative → act → round(25 * 0.15) = 4
    expect(conc(computeHealth(book, 1000, null))?.score).toBe(4);
  });

  it("subtracts to act when high-coverage look-through finds a dominant name", () => {
    const book = [holding({ ticker: "WORLD-EQ", value: 1000 })];
    const lookThrough = {
      maxName: { label: "Apple Inc.", pct: 12, fundCount: 1 },
      redundantPairs: [],
      equityCoverage: 0.85,
      regionDivergencePp: null,
    };
    // ≥10% at ≥0.6 coverage → act → 4
    expect(conc(computeHealth(book, 1000, null, null, lookThrough))?.score).toBe(4);
  });

  it("caps a partial-coverage finding at watch (~13 pts), never act", () => {
    const book = [holding({ ticker: "WORLD-EQ", value: 1000 })];
    const lookThrough = {
      maxName: { label: "Apple Inc.", pct: 18, fundCount: 1 },
      redundantPairs: [],
      equityCoverage: 0.45, // partial
      regionDivergencePp: null,
    };
    // even an 18% name caps at watch on partial coverage → round(25 * 0.5) = 13
    expect(conc(computeHealth(book, 1000, null, null, lookThrough))?.score).toBe(13);
  });

  it("ignores a low-coverage finding (stays good — absence never certifies, but neither does a sliver)", () => {
    const book = [holding({ ticker: "WORLD-EQ", value: 1000 })];
    const lookThrough = {
      maxName: { label: "Apple Inc.", pct: 30, fundCount: 1 },
      redundantPairs: [],
      equityCoverage: 0.2, // below the partial floor
      regionDivergencePp: null,
    };
    expect(conc(computeHealth(book, 1000, null, null, lookThrough))?.score).toBe(25);
  });

  it("flags redundant funds at watch regardless of coverage", () => {
    const book = [
      holding({ ticker: "SP500-A", value: 500 }),
      holding({ ticker: "SP500-B", value: 500 }),
    ];
    const lookThrough = {
      maxName: null,
      redundantPairs: [{ a: "SP500-A", b: "SP500-B" }],
      equityCoverage: 0.3,
      regionDivergencePp: null,
    };
    expect(conc(computeHealth(book, 1000, null, null, lookThrough))?.score).toBe(13);
  });

  it("scores an empty portfolio's concentration at full marks (nothing to penalise)", () => {
    expect(conc(computeHealth([], 0, null))?.score).toBe(25);
  });
});

// ─── Cash drag component rules ────────────────────────────────────────────────

describe("scorePortfolio — cash drag component", () => {
  function healthWithCash(cashPct: number) {
    const cashValue = cashPct * 10; // total = 1000
    const equityValue = 1000 - cashValue;
    const hlds = [
      holding({ ticker: "SCBS&P500", value: equityValue, class: "equity" }),
      holding({ ticker: "KFCASH-A", value: cashValue, class: "cash" }),
    ].filter((h) => h.value > 0);
    return computeHealth(hlds, 1000, null);
  }

  it("awards 20 pts when cash ≤ 2%", () => {
    const score = scorePortfolio(healthWithCash(1), false);
    expect(score.components.find((c) => c.key === "cash")?.score).toBe(20);
  });

  it("awards 20 pts exactly at the 2% boundary", () => {
    const score = scorePortfolio(healthWithCash(2), false);
    expect(score.components.find((c) => c.key === "cash")?.score).toBe(20);
  });

  it("awards 0 pts at cash ≥ 20%", () => {
    const score = scorePortfolio(healthWithCash(20), false);
    expect(score.components.find((c) => c.key === "cash")?.score).toBe(0);
  });

  it("awards 0 pts at cash > 20% (clamped)", () => {
    const score = scorePortfolio(healthWithCash(50), false);
    expect(score.components.find((c) => c.key === "cash")?.score).toBe(0);
  });
});

// ─── Component structure invariants ──────────────────────────────────────────

describe("scorePortfolio — structural invariants", () => {
  const someHoldings: Holding[] = [
    holding({ ticker: "SCBS&P500", value: 600, class: "equity", ter: 0.4 }),
    holding({ ticker: "K-FIXED-A", value: 300, class: "bond", ter: 0.2 }),
    holding({ ticker: "KFCASH-A", value: 100, class: "cash", ter: 0.1 }),
  ];

  it("total equals the simple sum of all components WHEN a target is set", () => {
    const target: MixSlice[] = [
      { label: "US Equity", pct: 60, ticker: "SCBS&P500", color: "var(--accent)" },
      { label: "Thai Bonds", pct: 30, ticker: "K-FIXED-A", color: "#F4A434" },
      { label: "Cash", pct: 10, ticker: "KFCASH-A", color: "#9E9EA8" },
    ];
    const health = computeHealth(someHoldings, 1000, target);
    const score = scorePortfolio(health, true);
    const componentSum = score.components.reduce((s, c) => s + c.score, 0);
    expect(score.total).toBe(componentSum);
  });

  it("total renormalises (excludes drift) WHEN no target is set", () => {
    const health = computeHealth(someHoldings, 1000, null);
    const score = scorePortfolio(health, false);
    const scored = score.components.filter((c) => c.key !== "drift");
    const scoredSum = scored.reduce((s, c) => s + c.score, 0);
    const scoredMax = scored.reduce((s, c) => s + c.max, 0); // 70
    expect(score.total).toBe(Math.round((scoredSum / scoredMax) * 100));
    // and the raw 4-way sum (which includes a 0 drift) is NOT the total.
    const rawSum = score.components.reduce((s, c) => s + c.score, 0);
    expect(score.total).toBeGreaterThanOrEqual(rawSum);
  });

  it("component maxes sum to 100", () => {
    const health = computeHealth(someHoldings, 1000, null);
    const score = scorePortfolio(health, false);
    const maxSum = score.components.reduce((s, c) => s + c.max, 0);
    expect(maxSum).toBe(100);
  });

  it("all component scores are within [0, max]", () => {
    const health = computeHealth(someHoldings, 1000, null);
    const score = scorePortfolio(health, false);
    for (const c of score.components) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(c.max);
    }
  });

  it("returns exactly 4 components with expected keys", () => {
    const health = computeHealth(someHoldings, 1000, null);
    const score = scorePortfolio(health, false);
    const keys = score.components.map((c) => c.key);
    expect(keys).toEqual(["drift", "fees", "concentration", "cash"]);
  });

  it("total is always an integer in [0, 100]", () => {
    const health = computeHealth(someHoldings, 1000, null);
    const score = scorePortfolio(health, false);
    expect(score.total).toBeGreaterThanOrEqual(0);
    expect(score.total).toBeLessThanOrEqual(100);
    expect(Number.isInteger(score.total)).toBe(true);
  });
});
