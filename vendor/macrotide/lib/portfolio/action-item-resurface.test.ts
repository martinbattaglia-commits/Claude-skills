// Contract for the pure resurface decision (#74 Layer 1). Covers the normal vs
// high-bar dials, the ratchet (improvements never resurface), and edge cases
// (no snapshot, durable reasons, free-text-only rejects). No DB, no clock.

import { describe, expect, it } from "vitest";
import {
  isReasonChip,
  REASON_CHIPS,
  RESURFACE_HIGH_BAR_FACTOR,
  RESURFACE_HIGH_BAR_MIN_PP,
  RESURFACE_NORMAL_DELTA_PP,
  type SuppressionState,
  shouldResurface,
} from "./action-item-resurface";

function decide(
  current: number,
  snapshot: number | null,
  state: SuppressionState = "archived",
  reason: string | null = null,
) {
  return shouldResurface({
    currentSavingsPp: current,
    snapshotSavingsPp: snapshot,
    state,
    reason,
  });
}

describe("dial constants", () => {
  it("match the design's starting values", () => {
    expect(RESURFACE_NORMAL_DELTA_PP).toBe(0.2);
    expect(RESURFACE_HIGH_BAR_FACTOR).toBe(2);
    expect(RESURFACE_HIGH_BAR_MIN_PP).toBe(0.5);
  });

  it("exposes the four starter reason chips", () => {
    expect(REASON_CHIPS).toEqual([
      "too_small",
      "tax_switching",
      "prefer_this_fund",
      "already_considered",
    ]);
    expect(isReasonChip("too_small")).toBe(true);
    expect(isReasonChip("nonsense")).toBe(false);
    expect(isReasonChip(null)).toBe(false);
  });
});

describe("normal bar (archive / no-reason reject / too_small)", () => {
  it("resurfaces when the saving grows by ≥ 0.20pp", () => {
    expect(decide(0.5, 0.3)).toBe(true); // +0.20 exactly
    expect(decide(0.51, 0.3)).toBe(true); // +0.21
  });

  it("stays hidden when the growth is below 0.20pp", () => {
    expect(decide(0.49, 0.3)).toBe(false); // +0.19
    expect(decide(0.3, 0.3)).toBe(false); // no change
  });

  it("treats a no-reason reject like archive", () => {
    expect(decide(0.6, 0.3, "not_for_me", null)).toBe(true);
    expect(decide(0.4, 0.3, "not_for_me", null)).toBe(false);
  });

  it("treats a 'too_small' reject on the normal bar", () => {
    expect(decide(0.6, 0.3, "not_for_me", "too_small")).toBe(true);
    expect(decide(0.45, 0.3, "not_for_me", "too_small")).toBe(false);
  });
});

describe("ratchet — improvements never resurface", () => {
  it("does not resurface when the saving shrinks", () => {
    expect(decide(0.1, 0.5)).toBe(false);
    expect(decide(0, 0.5, "not_for_me", "too_small")).toBe(false);
  });
});

describe("high bar (tax_switching)", () => {
  it("requires BOTH ≥ 2× AND ≥ 0.50pp", () => {
    // 2× but below 0.50 absolute → no.
    expect(decide(0.4, 0.2, "not_for_me", "tax_switching")).toBe(false);
    // ≥ 0.50 absolute but below 2× → no.
    expect(decide(0.55, 0.3, "not_for_me", "tax_switching")).toBe(false);
    // Both satisfied → yes.
    expect(decide(0.7, 0.3, "not_for_me", "tax_switching")).toBe(true);
    expect(decide(0.6, 0.3, "not_for_me", "tax_switching")).toBe(true); // 2× exactly, ≥0.50
  });

  it("never fires on a tiny snapshot that can't reach 0.50pp at 2×", () => {
    // 2×0.1 = 0.2 < 0.50, so even doubling stays hidden until ≥0.50 absolute.
    expect(decide(0.2, 0.1, "not_for_me", "tax_switching")).toBe(false);
    expect(decide(0.5, 0.1, "not_for_me", "tax_switching")).toBe(true); // 5× and ≥0.50
  });
});

describe("durable reasons — never resurface in Layer 1", () => {
  it("never resurfaces a preference / already-considered reject", () => {
    expect(decide(99, 0.1, "not_for_me", "prefer_this_fund")).toBe(false);
    expect(decide(99, 0.1, "not_for_me", "already_considered")).toBe(false);
  });

  it("never resurfaces a free-text-only reject (unrecognized reason)", () => {
    expect(decide(99, 0.1, "not_for_me", "this is my own words")).toBe(false);
  });

  it("ignores a reason on an archive (archive carries no reject reason)", () => {
    // Even if a stray reason is present, an archive uses the magnitude policy.
    expect(decide(0.6, 0.3, "archived", "prefer_this_fund")).toBe(true);
  });
});

describe("edge cases", () => {
  it("never resurfaces without a snapshot to compare against", () => {
    expect(decide(5, null)).toBe(false);
    expect(decide(5, null, "not_for_me", "too_small")).toBe(false);
  });
});
