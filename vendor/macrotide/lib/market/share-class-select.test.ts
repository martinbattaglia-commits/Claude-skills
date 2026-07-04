import { describe, expect, it } from "vitest";
import { compareClassesForList, pickDefaultClass, type RankableClass } from "./share-class-select";

const cls = (over: Partial<RankableClass> & { ticker: string }): RankableClass => ({
  className: over.ticker,
  investorType: "retail",
  distributionPolicy: null,
  aum: null,
  ...over,
});

/** Sort a copy with the comparator and return the resulting ticker order. */
const order = (list: RankableClass[], abbr?: string | null) =>
  [...list].sort(compareClassesForList(abbr)).map((c) => c.ticker);

describe("compareClassesForList", () => {
  it("ranks retail classes ahead of non-retail", () => {
    const list = [
      cls({ ticker: "F-I", investorType: "institutional", aum: 9_999 }),
      cls({ ticker: "F-A", investorType: "retail", aum: 1 }),
    ];
    // Retail wins despite far smaller AUM — a tiny retail class still outranks a
    // huge institutional one.
    expect(order(list)).toEqual(["F-A", "F-I"]);
  });

  it("ranks audience tiers: retail > unknown(null) > restricted", () => {
    // Big AUM must not let a restricted class jump above a retail/unknown one —
    // the tier dominates AUM.
    const list = [
      cls({ ticker: "F-RESTR", investorType: "restricted", aum: 9_999 }),
      cls({ ticker: "F-NULL", investorType: null, aum: 1 }),
      cls({ ticker: "F-RETAIL", investorType: "retail", aum: 1 }),
    ];
    expect(order(list)).toEqual(["F-RETAIL", "F-NULL", "F-RESTR"]);
  });

  it("orders by AUM descending within the same tier (most popular first)", () => {
    const list = [
      cls({ ticker: "F-A", aum: 100 }),
      cls({ ticker: "F-D", aum: 500 }),
      cls({ ticker: "F-R", aum: 250 }),
    ];
    expect(order(list)).toEqual(["F-D", "F-R", "F-A"]);
  });

  it("sorts classes with AUM ahead of classes still missing it (nulls last)", () => {
    const list = [cls({ ticker: "F-A", aum: null }), cls({ ticker: "F-D", aum: 10 })];
    expect(order(list)).toEqual(["F-D", "F-A"]);
  });

  it("falls back to the flagship heuristic when AUM is equal across siblings (per-fund net_asset)", () => {
    // Same AUM on every class == the per-fund (not per-class) case → AUM no-ops,
    // and the flagship heuristic governs: ticker==abbr first, then accumulating.
    const list = [
      cls({ ticker: "FUND-D", aum: 1000, distributionPolicy: "dividend" }),
      cls({ ticker: "FUND-A", aum: 1000, distributionPolicy: "accumulating" }),
      cls({ ticker: "FUND", aum: 1000, distributionPolicy: "dividend" }),
    ];
    expect(order(list, "FUND")).toEqual(["FUND", "FUND-A", "FUND-D"]);
  });

  it("falls back to the flagship heuristic when no class has AUM yet", () => {
    const list = [
      cls({ ticker: "FUND-D", distributionPolicy: "dividend" }),
      cls({ ticker: "FUND-A", distributionPolicy: "accumulating" }),
      cls({ ticker: "FUND", distributionPolicy: "dividend" }),
    ];
    expect(order(list, "FUND")).toEqual(["FUND", "FUND-A", "FUND-D"]);
  });

  it("is deterministic on a full tie (ticker ascending)", () => {
    const list = [cls({ ticker: "F-C" }), cls({ ticker: "F-A" }), cls({ ticker: "F-B" })];
    expect(order(list)).toEqual(["F-A", "F-B", "F-C"]);
  });
});

describe("pickDefaultClass (unchanged)", () => {
  it("prefers a retail accumulating class", () => {
    const list = [
      cls({ ticker: "F-D", investorType: "retail", distributionPolicy: "dividend" }),
      cls({ ticker: "F-A", investorType: "retail", distributionPolicy: "accumulating" }),
    ];
    expect(pickDefaultClass(list)?.ticker).toBe("F-A");
  });

  it("prefers the class whose ticker is the parent abbr", () => {
    const list = [
      cls({ ticker: "F-A", distributionPolicy: "accumulating" }),
      cls({ ticker: "FUND", distributionPolicy: "dividend" }),
    ];
    expect(pickDefaultClass(list, "FUND")?.ticker).toBe("FUND");
  });
});
