import { describe, expect, it } from "vitest";
import { deriveUnits } from "./value-ledger";

describe("deriveUnits — money-facts → units (#130)", () => {
  it("prefers units when read, ignoring total/price/nav", () => {
    expect(deriveUnits({ units: 12.5, total: 99999, price: 5, navOnDate: 7 })).toEqual({
      units: 12.5,
      basis: "units",
    });
  });

  it("units only — passes through", () => {
    expect(deriveUnits({ units: 100, total: null, price: null, navOnDate: null })).toEqual({
      units: 100,
      basis: "units",
    });
  });

  it("total + price — units = total ÷ price (Total mode)", () => {
    expect(deriveUnits({ units: null, total: 1000, price: 25, navOnDate: 999 })).toEqual({
      units: 40,
      basis: "price",
    });
  });

  it("total only, no price, NAV on file — units = total ÷ NAV(date) [core case]", () => {
    expect(deriveUnits({ units: null, total: 200000, price: null, navOnDate: 12.5 })).toEqual({
      units: 16000,
      basis: "nav",
    });
  });

  it("prefers the row's own price over NAV when both are present", () => {
    // price wins → 1000 ÷ 20 = 50 (not 1000 ÷ 10 = 100)
    expect(deriveUnits({ units: null, total: 1000, price: 20, navOnDate: 10 }).units).toBe(50);
  });

  it("total only, no price, no NAV — unresolved (flag needs-units)", () => {
    expect(deriveUnits({ units: null, total: 200000, price: null, navOnDate: null })).toEqual({
      units: null,
      basis: "none",
    });
  });

  it("nothing usable — unresolved", () => {
    expect(deriveUnits({ units: null, total: null, price: null, navOnDate: null }).basis).toBe(
      "none",
    );
  });

  it("never divides value by avg-cost: avg-cost is simply not an input it sees", () => {
    // The helper only knows current price / NAV. A caller passing avgCost as `price`
    // would be the bug — this test documents that the divisor is current-priced.
    // value 200000, NAV 12.5 → 16000 units; a (wrong) value÷avgCost(40) = 5000.
    const r = deriveUnits({ units: null, total: 200000, price: null, navOnDate: 12.5 });
    expect(r.units).toBe(16000);
    expect(r.units).not.toBe(5000);
  });

  it("treats zero / non-finite values as absent", () => {
    expect(deriveUnits({ units: 0, total: 1000, price: 20, navOnDate: null }).basis).toBe("price");
    expect(deriveUnits({ units: null, total: 0, price: 20, navOnDate: 10 }).basis).toBe("none");
    expect(deriveUnits({ units: null, total: 1000, price: Number.NaN, navOnDate: 10 }).basis).toBe(
      "nav",
    );
    expect(
      deriveUnits({ units: Number.POSITIVE_INFINITY, total: 1000, price: 20, navOnDate: null })
        .basis,
    ).toBe("price");
  });
});
