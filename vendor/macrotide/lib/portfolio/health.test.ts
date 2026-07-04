import { describe, expect, it } from "vitest";
import type { Holding, MixSlice } from "@/lib/static/types";
import {
  allocationByClass,
  allocationByRegion,
  assessConcentration,
  blendedTer,
  cashWeight,
  computeDrift,
  computeHealth,
  concentration,
  type LookThrough,
  rebalanceHint,
  summarizeHealth,
  trackingGap,
  unknownTerCount,
} from "./health";

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
    d1: partial.d1 ?? 0,
    ytd: partial.ytd ?? 0,
    y1: partial.y1 ?? 0,
    ter: partial.ter === undefined ? 0 : partial.ter,
    source: partial.source ?? "",
  };
}

const holdings: Holding[] = [
  holding({ ticker: "SCBS&P500", value: 600, class: "equity", region: "United States", ter: 0.4 }),
  holding({ ticker: "K-WORLDX", value: 200, class: "equity", region: "Global", ter: 0.45 }),
  holding({ ticker: "K-FIXED-A", value: 150, class: "bond", region: "Thailand", ter: 0.2 }),
  holding({ ticker: "KFCASH-A", value: 50, class: "cash", region: "Thailand", ter: 0.1 }),
];
const TOTAL = 1000;

const targetMix: MixSlice[] = [
  { label: "US Equity", pct: 50, ticker: "SCBS&P500", color: "var(--accent)" },
  { label: "Global Equity", pct: 30, ticker: "K-WORLDX", color: "#7C7CFF" },
  { label: "Thai Bonds", pct: 20, ticker: "K-FIXED-A", color: "#F4A434" },
];

describe("allocationByClass", () => {
  it("groups by asset class and computes percentages, dropping empties", () => {
    const slices = allocationByClass(holdings, TOTAL);
    const map = Object.fromEntries(slices.map((s) => [s.key, s.pct]));
    expect(map.equity).toBeCloseTo(80);
    expect(map.bond).toBeCloseTo(15);
    expect(map.cash).toBeCloseTo(5);
    expect(map.alternative).toBeUndefined();
  });

  it("returns no slices for an empty/zero portfolio", () => {
    expect(allocationByClass([], 0)).toEqual([]);
  });

  it("surfaces a Mixed sleeve for balanced funds, ordered after Bonds (#267)", () => {
    const withMixed = [...holdings, holding({ ticker: "K-BALANCED", value: 250, class: "mixed" })];
    const slices = allocationByClass(withMixed, TOTAL + 250);
    const mixed = slices.find((s) => s.key === "mixed");
    expect(mixed?.label).toBe("Mixed");
    expect(mixed?.pct).toBeCloseTo(20);
    const keys = slices.map((s) => s.key);
    expect(keys.indexOf("mixed")).toBeGreaterThan(keys.indexOf("bond"));
  });

  it("pulls a RESERVED cash account into its own slice, out of Cash (#149)", () => {
    const slices = allocationByClass(holdings, TOTAL, new Set(["KFCASH-A"]));
    const map = Object.fromEntries(slices.map((s) => [s.key, s.pct]));
    expect(map.cash).toBeUndefined(); // the only cash account is reserved
    expect(map.reserved).toBeCloseTo(5);
    expect(slices.find((s) => s.key === "reserved")?.label).toBe("Reserved");
  });
});

describe("allocationByRegion", () => {
  it("groups by region, sorted by value desc", () => {
    const slices = allocationByRegion(holdings, TOTAL);
    expect(slices[0].label).toBe("United States");
    expect(slices[0].pct).toBeCloseTo(60);
    expect(slices.find((s) => s.label === "Thailand")?.pct).toBeCloseTo(20);
  });
});

describe("computeDrift", () => {
  it("computes per-ticker drift vs target", () => {
    const drift = computeDrift(holdings, TOTAL, targetMix);
    const byTicker = Object.fromEntries(drift.map((d) => [d.ticker, d]));
    expect(byTicker["SCBS&P500"].drift).toBeCloseTo(10); // 60 - 50
    expect(byTicker["K-WORLDX"].drift).toBeCloseTo(-10); // 20 - 30
    expect(byTicker["K-FIXED-A"].drift).toBeCloseTo(-5); // 15 - 20
  });

  it("surfaces holdings with no target (e.g. cash) as full overweight", () => {
    const drift = computeDrift(holdings, TOTAL, targetMix);
    const cash = drift.find((d) => d.ticker === "KFCASH-A");
    expect(cash?.target).toBe(0);
    expect(cash?.drift).toBeCloseTo(5);
  });

  it("sums target slices that share a ticker", () => {
    const splitMix: MixSlice[] = [
      { label: "Long Bonds", pct: 40, ticker: "K-FIXED-A", color: "#F4A434" },
      { label: "Mid Bonds", pct: 15, ticker: "K-FIXED-A", color: "#FFC97A" },
    ];
    const drift = computeDrift(
      [holding({ ticker: "K-FIXED-A", value: 1000, class: "bond" })],
      1000,
      splitMix,
    );
    expect(drift[0].target).toBeCloseTo(55);
    expect(drift[0].drift).toBeCloseTo(45);
  });

  it("sorts by absolute drift magnitude", () => {
    const drift = computeDrift(holdings, TOTAL, targetMix);
    const mags = drift.map((d) => Math.abs(d.drift));
    expect(mags).toEqual([...mags].sort((a, b) => b - a));
  });
});

describe("trackingGap", () => {
  it("equals the sum of overweights (= half the absolute deviation)", () => {
    const drift = computeDrift(holdings, TOTAL, targetMix);
    // overweights: SCBS&P500 +10, KFCASH-A +5 => 15
    expect(trackingGap(drift)).toBeCloseTo(15);
  });

  it("is zero when perfectly on target", () => {
    const onTarget: Holding[] = [
      holding({ ticker: "SCBS&P500", value: 500 }),
      holding({ ticker: "K-WORLDX", value: 300 }),
      holding({ ticker: "K-FIXED-A", value: 200, class: "bond" }),
    ];
    expect(trackingGap(computeDrift(onTarget, 1000, targetMix))).toBeCloseTo(0);
  });
});

describe("blendedTer", () => {
  it("value-weights the expense ratios", () => {
    // (600*0.4 + 200*0.45 + 150*0.2 + 50*0.1)/1000 = 365/1000 = 0.365
    expect(blendedTer(holdings, TOTAL)).toBeCloseTo(0.365);
  });
  it("returns 0 for empty portfolio", () => {
    expect(blendedTer([], 0)).toBe(0);
  });

  it("weights only over holdings with a KNOWN ter — unknowns don't drag it to 0", () => {
    // One cheap known fund + one unknown-fee fund. The blended rate is the
    // known fund's rate (0.40%), NOT diluted toward 0 by the unknown.
    const mixed = [
      holding({ ticker: "KNOWN", value: 500, ter: 0.4 }),
      holding({ ticker: "UNKNOWN", value: 500, ter: null }),
    ];
    expect(blendedTer(mixed, 1000)).toBeCloseTo(0.4);
  });

  it("returns 0 when no holding has a known ter", () => {
    const allUnknown = [
      holding({ ticker: "A", value: 500, ter: null }),
      holding({ ticker: "B", value: 500, ter: null }),
    ];
    expect(blendedTer(allUnknown, 1000)).toBe(0);
  });
});

describe("unknownTerCount", () => {
  it("counts holdings whose ter is null", () => {
    const mixed = [
      holding({ ticker: "A", value: 100, ter: 0.4 }),
      holding({ ticker: "B", value: 100, ter: null }),
      holding({ ticker: "C", value: 100, ter: null }),
    ];
    expect(unknownTerCount(mixed)).toBe(2);
  });
  it("is 0 when every ter is known (including an explicit 0)", () => {
    const known = [
      holding({ ticker: "A", value: 100, ter: 0 }),
      holding({ ticker: "B", value: 100, ter: 0.4 }),
    ];
    expect(unknownTerCount(known)).toBe(0);
  });
});

describe("concentration", () => {
  it("reports largest holding, top-3 and HHI", () => {
    const c = concentration(holdings, TOTAL);
    expect(c.top?.ticker).toBe("SCBS&P500");
    expect(c.top?.pct).toBeCloseTo(60);
    expect(c.top3Pct).toBeCloseTo(95); // 60 + 20 + 15
    expect(c.holdingCount).toBe(4);
    // HHI = 0.6^2 + 0.2^2 + 0.15^2 + 0.05^2 = 0.425
    expect(c.hhi).toBeCloseTo(0.425);
  });
  it("handles empty portfolio", () => {
    const c = concentration([], 0);
    expect(c.top).toBeNull();
    expect(c.hhi).toBe(0);
  });
  it("reports the largest ALTERNATIVE holding as the single-bet, ignoring equity/bond", () => {
    const book = [
      holding({ ticker: "WORLD-EQ", class: "equity", value: 600 }),
      holding({ ticker: "ONE-CRYPTO", class: "alternative", value: 400 }),
    ];
    const c = concentration(book, 1000);
    expect(c.singleBet?.ticker).toBe("ONE-CRYPTO");
    expect(c.singleBet?.pct).toBeCloseTo(40);
  });
  it("has no single-bet when there is no alternative holding", () => {
    const book = [holding({ ticker: "WORLD-EQ", class: "equity", value: 1000 })];
    expect(concentration(book, 1000).singleBet).toBeNull();
  });
  it("carries the injected look-through through computeHealth", () => {
    const lt: LookThrough = {
      maxName: { label: "Apple Inc.", pct: 8, fundCount: 2 },
      redundantPairs: [],
      equityCoverage: 0.7,
      regionDivergencePp: null,
    };
    const h = computeHealth([holding({ ticker: "A", value: 100 })], 100, null, null, lt);
    expect(h.concentration.lookThrough?.maxName?.label).toBe("Apple Inc.");
  });
});

describe("assessConcentration", () => {
  const sig = (over: Partial<LookThrough> | null, singleBetPct = 0) =>
    concentration(
      [
        holding({ ticker: "EQ", class: "equity", value: 1000 - singleBetPct * 10 }),
        ...(singleBetPct > 0
          ? [holding({ ticker: "ALT", class: "alternative", value: singleBetPct * 10 })]
          : []),
      ],
      1000,
      over === null
        ? null
        : {
            maxName: null,
            redundantPairs: [],
            equityCoverage: 0,
            regionDivergencePp: null,
            ...over,
          },
    );

  it("is good for a clean book with no look-through", () => {
    expect(assessConcentration(sig(null)).status).toBe("good");
  });

  it("flags a large single alternative position as act", () => {
    expect(assessConcentration(sig(null, 40)).status).toBe("action");
  });

  it("escalates to act when high-coverage look-through finds a dominant name", () => {
    const a = assessConcentration(
      sig({ maxName: { label: "Apple", pct: 12, fundCount: 1 }, equityCoverage: 0.8 }),
    );
    expect(a.status).toBe("action");
    expect(a.reason).toMatch(/at least 12%/i);
  });

  it("caps a partial-coverage finding at watch and says so", () => {
    const a = assessConcentration(
      sig({ maxName: { label: "Apple", pct: 25, fundCount: 1 }, equityCoverage: 0.45 }),
    );
    expect(a.status).toBe("watch");
    expect(a.reason).toMatch(/we can see/i);
  });

  it("treats a low-coverage finding as disclosure only (stays good)", () => {
    const a = assessConcentration(
      sig({ maxName: { label: "Apple", pct: 30, fundCount: 1 }, equityCoverage: 0.2 }),
    );
    expect(a.status).toBe("good");
  });

  it("flags redundant funds at watch regardless of coverage", () => {
    const a = assessConcentration(
      sig({ redundantPairs: [{ a: "SP500-A", b: "SP500-B" }], equityCoverage: 0.1 }),
    );
    expect(a.status).toBe("watch");
    expect(a.reason).toMatch(/same thing/i);
  });

  it("never certifies on absence — good reason stays hedged about unseen funds", () => {
    expect(assessConcentration(sig(null)).reason).toMatch(/fund mix|see into|don't all publish/i);
  });
});

describe("cashWeight", () => {
  it("sums the cash-class sleeves", () => {
    expect(cashWeight(holdings, TOTAL)).toBeCloseTo(5);
  });
});

describe("computeHealth", () => {
  it("rolls every signal up in one pass", () => {
    const h = computeHealth(holdings, TOTAL, targetMix, 0.35);
    expect(h.trackingGapPp).toBeCloseTo(15);
    expect(h.blendedTer).toBeCloseTo(0.365);
    expect(h.targetTer).toBe(0.35);
    expect(h.cashPct).toBeCloseTo(5);
    expect(h.byClass.length).toBe(3);
    expect(h.concentration.top?.ticker).toBe("SCBS&P500");
  });

  it("omits drift when no target mix is provided", () => {
    const h = computeHealth(holdings, TOTAL, null);
    expect(h.drift).toEqual([]);
    expect(h.trackingGapPp).toBe(0);
  });
});

describe("rebalanceHint", () => {
  it("returns the most over- and under-weight sleeves", () => {
    const drift = computeDrift(holdings, TOTAL, targetMix);
    const hint = rebalanceHint(drift);
    expect(hint.trim?.ticker).toBe("SCBS&P500"); // +10
    expect(hint.add?.ticker).toBe("K-WORLDX"); // -10
  });

  it("ignores drift within tolerance", () => {
    const onTarget = [
      holding({ ticker: "SCBS&P500", value: 500 }),
      holding({ ticker: "K-WORLDX", value: 300 }),
      holding({ ticker: "K-FIXED-A", value: 200, class: "bond" }),
    ];
    const hint = rebalanceHint(computeDrift(onTarget, 1000, targetMix));
    expect(hint.trim).toBeNull();
    expect(hint.add).toBeNull();
  });
});

describe("summarizeHealth", () => {
  it("flags large drift first, with rebalance moves in the body", () => {
    const h = computeHealth(holdings, TOTAL, targetMix);
    const s = summarizeHealth(h, "Balanced");
    expect(s.tone).toBe("watch");
    expect(s.title).toContain("off your Balanced target");
    expect(s.body).toContain("SCBS&P500");
  });

  it("flags concentration when a single fund dominates and drift is small", () => {
    const concentrated = [
      holding({ ticker: "SCBS&P500", value: 800, ter: 0.4 }),
      holding({ ticker: "K-WORLDX", value: 200, ter: 0.4 }),
    ];
    // mix matching weights so drift is ~0, isolating the concentration branch
    const mix: MixSlice[] = [
      { label: "US", pct: 80, ticker: "SCBS&P500", color: "var(--accent)" },
      { label: "Global", pct: 20, ticker: "K-WORLDX", color: "#7C7CFF" },
    ];
    const s = summarizeHealth(computeHealth(concentrated, 1000, mix), "Custom");
    expect(s.tone).toBe("action");
    expect(s.title).toContain("SCBS&P500");
  });

  it("praises a low blended fee when nothing else is wrong", () => {
    // Diversified + on-target + no cash, so drift/concentration/cash all pass.
    const cheap = [
      holding({ ticker: "SCBS&P500", value: 250, ter: 0.4 }),
      holding({ ticker: "K-WORLDX", value: 250, ter: 0.4 }),
      holding({ ticker: "K-FIXED-A", value: 250, class: "bond", ter: 0.4 }),
      holding({ ticker: "K-USA-A", value: 250, ter: 0.4 }),
    ];
    const mix: MixSlice[] = [
      { label: "US", pct: 25, ticker: "SCBS&P500", color: "var(--accent)" },
      { label: "Global", pct: 25, ticker: "K-WORLDX", color: "#7C7CFF" },
      { label: "Bonds", pct: 25, ticker: "K-FIXED-A", color: "#F4A434" },
      { label: "US Value", pct: 25, ticker: "K-USA-A", color: "#5BA7B5" },
    ];
    const s = summarizeHealth(computeHealth(cheap, 1000, mix), "Custom");
    expect(s.tone).toBe("good");
    expect(s.title).toContain("0.40%");
  });
});
