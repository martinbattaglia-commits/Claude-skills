// Stable-key derivation for action items. The contract: keys are deterministic,
// built from IDENTITY inputs only (never magnitudes), so a dismissal survives a
// NAV tick but a materially different finding gets a different key.

import { describe, expect, it } from "vitest";
import { feeCreepKey, headlineKey, rebalanceKey } from "./action-item-key";

describe("feeCreepKey", () => {
  it("keys by held ticker only", () => {
    expect(feeCreepKey("VWRA")).toBe("fee_creep:VWRA");
  });

  it("is stable across calls (deterministic)", () => {
    expect(feeCreepKey("EXAMPLE-FUND-A")).toBe(feeCreepKey("EXAMPLE-FUND-A"));
  });

  it("differs by ticker so a different fund gets a different key", () => {
    expect(feeCreepKey("FUND-A")).not.toBe(feeCreepKey("FUND-B"));
  });
});

describe("headlineKey", () => {
  it("combines branch and subject", () => {
    expect(headlineKey("concentration", "VWRA")).toBe("headline:concentration:VWRA");
  });

  it("defaults subject to empty string", () => {
    expect(headlineKey("ontrack")).toBe("headline:ontrack:");
  });
});

describe("rebalanceKey", () => {
  it("sorts the add/trim pair so input order doesn't change the key", () => {
    expect(rebalanceKey("BNDX", "VWRA")).toBe(rebalanceKey("BNDX", "VWRA"));
    // ADD~BNDX sorts before TRIM~VWRA.
    expect(rebalanceKey("BNDX", "VWRA")).toBe("rebalance:ADD~BNDX|TRIM~VWRA");
  });

  it("differs when the move pair differs", () => {
    expect(rebalanceKey("BNDX", "VWRA")).not.toBe(rebalanceKey("BNDX", "FUND-C"));
  });
});
