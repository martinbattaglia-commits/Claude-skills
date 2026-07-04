"use client";

import { type RefObject, useState } from "react";

// Shared dropdown placement: decide whether a list anchored to `ref` should open
// UPWARD because there isn't room below. The floor/ceiling is the nearest scroll
// container — inside a modal the sticky footer's top / header's bottom (the modal
// body uses OverlayScrollbars, which re-parents content so an overflow walk
// misses it); otherwise the nearest scrollable ancestor, then the viewport. So
// the list never hides under a sticky footer or off-screen.
//
// Call `measure()` in the OPEN handler, BEFORE the list renders, so placement is
// correct on first paint (no visible flip-after-open). Returns `up` to drive the
// list's `data-up` attribute (or a bottom/top style).
export function useFlipUp<T extends HTMLElement>(ref: RefObject<T | null>, neededPx = 240) {
  const [up, setUp] = useState(false);

  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let bottomBound = window.innerHeight;
    let topBound = 0;
    const modal = el.closest(".modal");
    const footer = modal?.querySelector(".modal-footer");
    const header = modal?.querySelector(".modal-header");
    if (footer) bottomBound = footer.getBoundingClientRect().top;
    if (header) topBound = header.getBoundingClientRect().bottom;
    if (!footer) {
      for (let node = el.parentElement; node; node = node.parentElement) {
        const oy = getComputedStyle(node).overflowY;
        if (oy === "auto" || oy === "scroll") {
          const r = node.getBoundingClientRect();
          bottomBound = r.bottom;
          topBound = r.top;
          break;
        }
      }
    }
    const spaceBelow = bottomBound - rect.bottom;
    const spaceAbove = rect.top - topBound;
    // Flip up only when below is too tight AND above has more room.
    setUp(spaceBelow < neededPx && spaceAbove > spaceBelow);
  };

  return { up, measure };
}
