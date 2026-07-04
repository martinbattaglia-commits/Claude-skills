// Contract for the pure fee-check presentation logic (#74 §5): severity order,
// top-N split, the "N more" count, and the calm summary line. No DB, no React.

import { describe, expect, it } from "vitest";
import {
  FEE_CHECK_TOP_N,
  type FeeCheckCardLike,
  feeCheckCardSummary,
  feeCheckInlineIntro,
  feeCheckSummary,
  feeChecksButtonLabel,
  feeSwitchPrompt,
  orderFeeChecks,
  presentFeeChecks,
} from "./fee-creep-presentation";

function f(heldTicker: string, savingsPp: number) {
  return { heldTicker, savingsPp };
}

describe("orderFeeChecks", () => {
  it("orders by biggest saving first (most wasted fee)", () => {
    const out = orderFeeChecks([f("A", 0.1), f("B", 0.9), f("C", 0.5)]);
    expect(out.map((x) => x.heldTicker)).toEqual(["B", "C", "A"]);
  });

  it("breaks ties on ticker for a stable order", () => {
    const out = orderFeeChecks([f("Z", 0.5), f("A", 0.5), f("M", 0.5)]);
    expect(out.map((x) => x.heldTicker)).toEqual(["A", "M", "Z"]);
  });

  it("does not mutate the input", () => {
    const input = [f("A", 0.1), f("B", 0.9)];
    orderFeeChecks(input);
    expect(input.map((x) => x.heldTicker)).toEqual(["A", "B"]);
  });
});

describe("feeCheckSummary", () => {
  it("is empty when there are no findings", () => {
    expect(feeCheckSummary(0)).toBe("");
    expect(feeCheckSummary(-1)).toBe("");
  });

  it("is singular for one and has no deadline language", () => {
    const s = feeCheckSummary(1);
    expect(s).toContain("One fund");
    expect(s).toContain("review when you have time");
    expect(s).not.toMatch(/to-do|deadline|now|urgent/i);
  });

  it("is plural with a count for several", () => {
    expect(feeCheckSummary(4)).toBe(
      "4 funds have cheaper equivalents — review when you have time.",
    );
  });
});

describe("presentFeeChecks", () => {
  it("shows the top N as full cards and tucks the rest behind 'N more'", () => {
    const findings = Array.from(
      { length: 7 },
      (_, i) => f(`T${i}`, (7 - i) / 10), // T0=0.7 … T6=0.1 (already severity-descending)
    );
    const view = presentFeeChecks(findings);
    expect(view.top).toHaveLength(FEE_CHECK_TOP_N);
    expect(view.top.map((x) => x.heldTicker)).toEqual(["T0", "T1", "T2"]);
    expect(view.moreCount).toBe(7 - FEE_CHECK_TOP_N);
    expect(view.rest).toHaveLength(view.moreCount);
    expect(view.summary).toBe(feeCheckSummary(7));
  });

  it("has no tail when findings fit within top N", () => {
    const view = presentFeeChecks([f("A", 0.9), f("B", 0.2)]);
    expect(view.top).toHaveLength(2);
    expect(view.rest).toEqual([]);
    expect(view.moreCount).toBe(0);
  });

  it("respects a custom topN", () => {
    const view = presentFeeChecks([f("A", 0.9), f("B", 0.5), f("C", 0.2)], 1);
    expect(view.top.map((x) => x.heldTicker)).toEqual(["A"]);
    expect(view.moreCount).toBe(2);
  });

  it("returns an empty view for no findings", () => {
    const view = presentFeeChecks([]);
    expect(view.top).toEqual([]);
    expect(view.rest).toEqual([]);
    expect(view.moreCount).toBe(0);
    expect(view.summary).toBe("");
  });
});

describe("feeCheckInlineIntro", () => {
  it("is empty when there are no findings", () => {
    expect(feeCheckInlineIntro(0)).toBe("");
    expect(feeCheckInlineIntro(-2)).toBe("");
  });

  it("is singular for one fund", () => {
    expect(feeCheckInlineIntro(1)).toBe(
      "One of your funds has a cheaper alternative offering comparable exposure.",
    );
  });

  it("reflects the TRUE total when capped (not the shown count)", () => {
    // 10 findings but only the top 3 render — the intro still says 10.
    expect(feeCheckInlineIntro(10)).toBe(
      "10 of your funds have cheaper alternatives offering comparable exposure.",
    );
  });
});

describe("feeChecksButtonLabel", () => {
  it("is the plain 'See details' when nothing is hidden (total <= shown)", () => {
    expect(feeChecksButtonLabel(3, 3)).toBe("See details");
    expect(feeChecksButtonLabel(2, 3)).toBe("See details");
    expect(feeChecksButtonLabel(2, 2)).toBe("See details");
  });

  it("carries the true total when capped (e.g. 'See all 11')", () => {
    expect(feeChecksButtonLabel(11, FEE_CHECK_TOP_N)).toBe("See all 11");
    expect(feeChecksButtonLabel(10, 3)).toBe("See all 10");
  });

  it("has no nag or deadline language", () => {
    expect(feeChecksButtonLabel(9, 3)).not.toMatch(/now|urgent|deadline|must|to-do/i);
  });
});

// A full finding shape for the card-summary + Advisor-prompt helpers.
function finding(overrides: Partial<FeeCheckCardLike> = {}): FeeCheckCardLike {
  return {
    heldTicker: "EXAMPLE-FUND-A",
    heldName: "Example Fund A",
    heldTer: 1.5,
    assetClass: "equity",
    savingsPp: 0.45,
    alternatives: [
      { abbrName: "EXAMPLE-FUND-B", englishName: "Example Fund B", ter: 1.05 },
      { abbrName: "EXAMPLE-FUND-C", englishName: null, ter: 1.2 },
    ],
    ...overrides,
  };
}

describe("feeCheckCardSummary", () => {
  it("renders the saving as a pp/yr figure (no invented baht)", () => {
    expect(feeCheckCardSummary(finding())).toBe("≈0.45pp/yr cheaper available");
  });

  it("is empty when there is no saving", () => {
    expect(feeCheckCardSummary(finding({ savingsPp: 0 }))).toBe("");
    expect(feeCheckCardSummary(finding({ savingsPp: -0.1 }))).toBe("");
  });
});

describe("feeSwitchPrompt", () => {
  it("scopes the prompt to the held fund + its cheapest alternative", () => {
    const p = feeSwitchPrompt(finding());
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.send).toBe(p.display);
    expect(p.send).toContain("EXAMPLE-FUND-A");
    expect(p.send).toContain("1.50% TER");
    // The cheapest alternative (alternatives[0]) drives the comparison.
    expect(p.send).toContain("EXAMPLE-FUND-B");
    expect(p.send).toContain("1.05%");
    expect(p.context).toEqual({
      screen: "portfolio",
      intent: "fee_switch",
      subject: "EXAMPLE-FUND-A",
      signals: {
        heldTer: 1.5,
        alternative: "EXAMPLE-FUND-B",
        altTer: 1.05,
        assetClass: "equity",
      },
    });
  });

  it("falls back to a generic asset class when none is set", () => {
    const p = feeSwitchPrompt(finding({ assetClass: null }));
    expect(p?.context.signals.assetClass).toBe("same-class");
    expect(p?.send).toContain("comparable same-class exposure");
  });

  it("returns null when there is no alternative to switch into", () => {
    expect(feeSwitchPrompt(finding({ alternatives: [] }))).toBeNull();
  });
});

// The Portfolio tab now carries ONE section-level "Ask advisor" for the whole
// fee-check section: it scopes the single prompt to the most material finding
// (biggest annual saving) and its cheapest alternative. These helpers compose to
// that selection, so the screen and tests share one source of truth.
describe("section-level Ask advisor selection", () => {
  it("scopes the section prompt to the most material finding (biggest saving)", () => {
    const findings = [
      finding({ heldTicker: "SMALL", savingsPp: 0.1 }),
      finding({ heldTicker: "BIG", savingsPp: 0.8 }),
      finding({ heldTicker: "MID", savingsPp: 0.4 }),
    ];
    const top = orderFeeChecks(findings)[0];
    expect(top.heldTicker).toBe("BIG");
    const prompt = feeSwitchPrompt(top);
    expect(prompt?.context.subject).toBe("BIG");
  });
});
