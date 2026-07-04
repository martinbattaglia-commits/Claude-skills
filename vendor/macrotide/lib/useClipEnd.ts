"use client";

import { type RefObject, useCallback, useEffect, useState } from "react";

/**
 * Track whether a single-line input is horizontally clipped AND not yet scrolled
 * to its end — i.e. there's hidden text past the right edge. Drives the shared
 * "there's more →" field fade (`.field-fade`), so the symbol and units/total
 * boxes behave identically: the caller spreads `data-clip-end={clipEnd}` on the
 * field wrapper and wires `recompute` to the input's `onScroll` + `onFocus`. At
 * the rightmost caret the input is fully scrolled, so this goes false and the
 * fade clears, leaving the last character crisp.
 */
export function useClipEnd(ref: RefObject<HTMLInputElement | null>, value: string) {
  const [clipEnd, setClipEnd] = useState(false);
  const recompute = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setClipEnd(max > 1 && el.scrollLeft < max - 1);
  }, [ref]);
  // Recompute once the DOM reflects the new value's width.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is an intentional re-run trigger — the effect measures the DOM, not the value
  useEffect(recompute, [value, recompute]);
  return { clipEnd, recompute };
}
