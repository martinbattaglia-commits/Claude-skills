import { describe, expect, it } from "vitest";
import type { Holding, MixSlice } from "@/lib/static/types";
import { buildChatSuggestions } from "./chat-suggestions";
import { computeHealth } from "./health";

// Synthetic placeholders only — never real fund codes (AGENTS.md § Personal data).
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
    ter: partial.ter ?? 0,
    source: partial.source ?? "",
  };
}

describe("buildChatSuggestions", () => {
  it("falls back to evergreen prompts when there are no holdings", () => {
    const out = buildChatSuggestions({ hasHoldings: false });
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("What's a 3-fund portfolio?");
    // Nothing should claim to be about the user's book.
    expect(out.some((s) => /my book|my mix|my portfolio/i.test(s))).toBe(false);
  });

  it("leads with screen-flavored prompts for an empty portfolio on a screen", () => {
    const out = buildChatSuggestions({ screen: "explore", hasHoldings: false });
    expect(out[0]).toBe("How do I compare two index funds?");
  });

  it("surfaces a concentration prompt naming the user's top holding", () => {
    const holdings: Holding[] = [
      holding({ ticker: "EXAMPLE-FUND-A", value: 900 }),
      holding({ ticker: "EXAMPLE-FUND-B", value: 100 }),
    ];
    const health = computeHealth(holdings, 1000, null, null);
    const out = buildChatSuggestions({ screen: "portfolio", health, hasHoldings: true });
    expect(out.some((s) => s.includes("EXAMPLE-FUND-A") && s.includes("90%"))).toBe(true);
  });

  it("surfaces a cash-drag prompt when cash is heavy", () => {
    const holdings: Holding[] = [
      holding({ ticker: "EXAMPLE-FUND-A", value: 700, class: "equity" }),
      holding({ ticker: "EXAMPLE-CASH", value: 300, class: "cash" }),
    ];
    const health = computeHealth(holdings, 1000, null, null);
    const out = buildChatSuggestions({ health, hasHoldings: true });
    expect(out.some((s) => /cash/i.test(s) && s.includes("30%"))).toBe(true);
  });

  it("surfaces a drift prompt naming the target model when off target", () => {
    const holdings: Holding[] = [
      holding({ ticker: "EXAMPLE-FUND-A", value: 800 }),
      holding({ ticker: "EXAMPLE-FUND-B", value: 200, class: "bond" }),
    ];
    const targetMix: MixSlice[] = [
      { label: "Stocks", pct: 50, ticker: "EXAMPLE-FUND-A", color: "var(--accent)" },
      { label: "Bonds", pct: 50, ticker: "EXAMPLE-FUND-B", color: "#F4A434" },
    ];
    const health = computeHealth(holdings, 1000, targetMix, 0.2);
    const out = buildChatSuggestions({
      health,
      targetName: "Example Target",
      hasHoldings: true,
    });
    expect(out.some((s) => s.includes("Example Target") && /rebalance/i.test(s))).toBe(true);
  });

  it("still returns portfolio-specific chips for an on-track book", () => {
    const holdings: Holding[] = [
      holding({ ticker: "EXAMPLE-FUND-A", value: 500 }),
      holding({ ticker: "EXAMPLE-FUND-B", value: 500, class: "bond" }),
    ];
    const health = computeHealth(holdings, 1000, null, null);
    const out = buildChatSuggestions({ health, hasHoldings: true });
    expect(out).toContain("How am I doing vs my target?");
  });

  it("de-duplicates and respects the limit", () => {
    const holdings: Holding[] = [holding({ ticker: "EXAMPLE-FUND-A", value: 1000 })];
    const health = computeHealth(holdings, 1000, null, null);
    const out = buildChatSuggestions({ screen: "portfolio", health, hasHoldings: true }, 4);
    expect(out.length).toBeLessThanOrEqual(4);
    expect(new Set(out).size).toBe(out.length);
  });
});
