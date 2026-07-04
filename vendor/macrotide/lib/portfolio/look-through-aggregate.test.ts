import { describe, expect, it } from "vitest";
import {
  aggregateLookThrough,
  type FundLookThroughInput,
  normalizeName,
} from "./look-through-aggregate";

function fund(
  ticker: string,
  bookWeight: number,
  underlying: Array<[string, number]> | null,
  isEquity = true,
): FundLookThroughInput {
  return {
    ticker,
    bookWeight,
    isEquity,
    underlying: underlying
      ? underlying.map(([label, weightPct]) => ({ key: normalizeName(label), label, weightPct }))
      : null,
  };
}

describe("normalizeName", () => {
  it("collapses corporate suffixes and punctuation so the same name matches", () => {
    expect(normalizeName("Apple Inc.")).toBe(normalizeName("APPLE INCORPORATED"));
    expect(normalizeName("Microsoft Corp")).toBe(normalizeName("Microsoft Corporation"));
  });
});

describe("aggregateLookThrough", () => {
  it("returns null when no fund has usable underlying data", () => {
    expect(aggregateLookThrough([fund("A", 1, null)])).toBeNull();
    expect(aggregateLookThrough([fund("A", 1, [])])).toBeNull();
  });

  it("sums the same name across funds (book-level, lower bound)", () => {
    // Fund A is 50% of book, holds Apple 10%; Fund B is 50%, holds Apple 6%.
    // Apple book-level = 0.5*10 + 0.5*6 = 8%, across 2 funds.
    const lt = aggregateLookThrough([
      fund("A", 0.5, [["Apple Inc.", 10]]),
      fund("B", 0.5, [["Apple Inc.", 6]]),
    ]);
    expect(lt?.maxName?.label).toBe("Apple Inc.");
    expect(lt?.maxName?.pct).toBeCloseTo(8);
    expect(lt?.maxName?.fundCount).toBe(2);
  });

  it("computes equity coverage over the equity sleeve only", () => {
    // Equity book = 0.6 (A seen) + 0.2 (C unseen) = 0.8; covered = 0.6 → 0.75.
    const lt = aggregateLookThrough([
      fund("A", 0.6, [["Apple Inc.", 5]], true),
      fund("C", 0.2, null, true),
      fund("BOND", 0.2, null, false),
    ]);
    expect(lt?.equityCoverage).toBeCloseTo(0.75);
  });

  it("detects redundant funds sharing ≥4 of their top-5 holdings", () => {
    const five = (extra: string): Array<[string, number]> => [
      ["Apple", 7],
      ["Microsoft", 6],
      ["Nvidia", 5],
      ["Amazon", 4],
      [extra, 3],
    ];
    const lt = aggregateLookThrough([
      fund("SP500-A", 0.5, five("Meta")),
      fund("SP500-B", 0.5, five("Tesla")), // shares 4/5 → redundant
    ]);
    expect(lt?.redundantPairs).toEqual([{ a: "SP500-A", b: "SP500-B" }]);
  });

  it("does not call distinct funds redundant", () => {
    const lt = aggregateLookThrough([
      fund("US", 0.5, [
        ["Apple", 7],
        ["Microsoft", 6],
      ]),
      fund("JAPAN", 0.5, [
        ["Toyota", 7],
        ["Sony", 6],
      ]),
    ]);
    expect(lt?.redundantPairs).toEqual([]);
  });

  it("leaves region divergence null (coarse data, disclosure-only)", () => {
    const lt = aggregateLookThrough([fund("A", 1, [["Apple", 5]])]);
    expect(lt?.regionDivergencePp).toBeNull();
  });
});
