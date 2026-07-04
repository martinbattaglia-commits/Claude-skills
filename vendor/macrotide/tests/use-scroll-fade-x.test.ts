// Unit tests for the pure helpers behind useScrollFadeX — the horizontal
// scroll-fade cue on the fund detail tables. We import the REAL exports (not a
// replica) so the tests can't drift from the component logic.

import { describe, expect, it } from "vitest";
import { computeScrollEdges, edgeMask } from "@/lib/useScrollFadeX";

// ─── which edges still hide content ───────────────────────────────────────────

describe("computeScrollEdges", () => {
  // viewport 200px wide showing a 500px-wide table.
  const CLIENT = 200;
  const SCROLL = 500;

  it("flags only the right edge at the start", () => {
    expect(computeScrollEdges(0, CLIENT, SCROLL)).toEqual({ left: false, right: true });
  });

  it("flags both edges while scrolled in the middle", () => {
    expect(computeScrollEdges(150, CLIENT, SCROLL)).toEqual({ left: true, right: true });
  });

  it("flags only the left edge at the end", () => {
    // scrollLeft + clientWidth === scrollWidth ⇒ no more right content.
    expect(computeScrollEdges(SCROLL - CLIENT, CLIENT, SCROLL)).toEqual({
      left: true,
      right: false,
    });
  });

  it("clears the right edge within 1px of the end (sub-pixel slack)", () => {
    expect(computeScrollEdges(SCROLL - CLIENT - 0.5, CLIENT, SCROLL).right).toBe(false);
  });

  it("flags no edge when content fits (no overflow)", () => {
    expect(computeScrollEdges(0, SCROLL, SCROLL)).toEqual({ left: false, right: false });
  });
});

// ─── the theme-agnostic opacity mask ──────────────────────────────────────────

describe("edgeMask", () => {
  it("is `none` when neither edge hides content (no dimming without reason)", () => {
    expect(edgeMask(false, false)).toBe("none");
  });

  it("fades only the left edge (transparent left, opaque right)", () => {
    const mask = edgeMask(true, false);
    expect(mask).toMatch(/^linear-gradient\(to right, transparent,/);
    expect(mask).toMatch(/#000\)$/);
  });

  it("fades only the right edge (opaque left, transparent right)", () => {
    const mask = edgeMask(false, true);
    expect(mask).toMatch(/^linear-gradient\(to right, #000,/);
    expect(mask).toMatch(/transparent\)$/);
  });

  it("fades both edges when content overflows both ways", () => {
    const mask = edgeMask(true, true);
    expect(mask).toMatch(/^linear-gradient\(to right, transparent,/);
    expect(mask).toMatch(/transparent\)$/);
  });

  it("uses pure alpha only — no color/theme token (identical in light & dark)", () => {
    // Only `#000` (opaque) and `transparent` appear; no hsl/var/rgb tint.
    for (const mask of [edgeMask(true, false), edgeMask(false, true), edgeMask(true, true)]) {
      expect(mask).not.toMatch(/var\(|hsl|rgb/);
    }
  });
});
