"use client";

import { type CSSProperties, type RefObject, useEffect, useState } from "react";

// Global dropdown / popover placement. Anchors a floating element to a trigger
// with FIXED positioning — so it can never be clipped by an ancestor's overflow
// (e.g. a toolbar's `overflow-x: clip`) — and flips to stay on screen:
//   • opens DOWN + LEFT-aligned to the trigger by default,
//   • flips to RIGHT-aligned when it would overrun the right edge,
//   • flips UP when it would overrun the bottom edge.
// Re-measures on open, scroll, and resize. The returned style keeps the element
// hidden until it's been measured, so it never flashes in the wrong spot.
//
// Vertical-only needs are still served by the lighter `useFlipUp`; reach for this
// when a popover also has to flip horizontally or escape a clipping ancestor.
//
// IMPORTANT: `position: fixed` escapes an ancestor's *overflow clip*, but NOT a
// stacking-context ancestor (a scroll host with `transform`/`contain`, a sticky/
// z-indexed parent, etc.) — a popover trapped there can paint BEHIND a sibling like
// the right detail panel. So render the floating element in a PORTAL to
// `document.body` (`createPortal`), which this style's viewport coords already suit.
export function usePopoverPlacement(
  anchorRef: RefObject<HTMLElement | null>,
  floatingRef: RefObject<HTMLElement | null>,
  { open, gap = 6, margin = 8 }: { open: boolean; gap?: number; margin?: number },
): CSSProperties {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const anchor = anchorRef.current;
      const floating = floatingRef.current;
      if (!anchor || !floating) return;
      const a = anchor.getBoundingClientRect();
      const fw = floating.offsetWidth;
      const fh = floating.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Horizontal: left-aligned to the trigger; flip right-aligned if it'd overrun.
      let left = a.left;
      if (left + fw > vw - margin) left = Math.max(margin, a.right - fw);
      // Vertical: below the trigger; flip above if it'd overrun the bottom.
      let top = a.bottom + gap;
      if (top + fh > vh - margin) top = Math.max(margin, a.top - fh - gap);
      setPos({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, gap, margin, anchorRef, floatingRef]);

  return {
    position: "fixed",
    top: pos?.top ?? 0,
    left: pos?.left ?? 0,
    visibility: pos ? "visible" : "hidden",
  };
}
