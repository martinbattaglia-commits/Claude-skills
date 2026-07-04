"use client";

import { useOverlayScrollbars } from "overlayscrollbars-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useViewport } from "@/lib/useViewport";

// Width (px) of the opacity fade at a scrollable horizontal edge.
const FADE_PX = 24;

// Which horizontal edges still have hidden content beyond them. Pure so it's
// unit-testable. `left` once scrolled away from the start; `right` while content
// remains to the right. The −1px slack on the right absorbs sub-pixel rounding
// so the fade clears at the true end.
export function computeScrollEdges(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): { left: boolean; right: boolean } {
  return {
    left: scrollLeft > 0,
    right: scrollLeft + clientWidth < scrollWidth - 1,
  };
}

// A theme-agnostic opacity mask that fades whichever edge still hides content.
// It's pure alpha (no color), so it reads identically in light and dark by
// construction — opaque (`#000`) keeps content fully visible, `transparent`
// fades it out. `"none"` when nothing overflows past either edge, so content is
// never dimmed without reason. Pure so it's unit-testable.
export function edgeMask(left: boolean, right: boolean): string {
  if (!left && !right) return "none";
  const l = left ? "transparent" : "#000";
  const r = right ? "transparent" : "#000";
  return `linear-gradient(to right, ${l}, #000 ${FADE_PX}px, #000 calc(100% - ${FADE_PX}px), ${r})`;
}

// Paint the fade mask onto a scrolling element from its live geometry. Works on
// any scroller — the OS viewport (desktop) or the host itself (mobile native).
function paintMask(el: HTMLElement | null | undefined) {
  if (!el) return;
  const { left, right } = computeScrollEdges(el.scrollLeft, el.clientWidth, el.scrollWidth);
  const mask = edgeMask(left, right);
  el.style.setProperty("mask-image", mask);
  el.style.setProperty("-webkit-mask-image", mask);
}

function clearMask(el: HTMLElement | null | undefined) {
  if (!el) return;
  el.style.removeProperty("mask-image");
  el.style.removeProperty("-webkit-mask-image");
}

// Make a scroll region keyboard-reachable and named (WCAG 2.1.1).
function applyA11y(el: HTMLElement, label: string) {
  el.tabIndex = 0;
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", label);
}

/**
 * Horizontal scroll-fade for an overflow-x table scroller. From the live scroll
 * geometry it paints a theme-agnostic opacity mask that fades whichever edge
 * still hides content — a subtle "more to scroll" cue. Because the mask is pure
 * alpha it looks identical in light and dark, so there's no theme token to keep
 * in sync.
 *
 * Two paths, picked by viewport:
 *  • desktop/tablet — wraps the app's custom OverlayScrollbars
 *    (os-theme-macrotide, same options as {@link useOverlayScrollbar}) and masks
 *    the OS-generated viewport (the element that actually scrolls), driven by its
 *    scroll/updated events. Masking the viewport rather than the host leaves the
 *    floating scrollbar untouched.
 *  • mobile — keeps native touch scroll (the OS overlay reads poorly under
 *    touch) and masks the host itself, driven by a scroll listener + a
 *    ResizeObserver since there's no OS instance to emit `updated`.
 *
 * Either way the scroll region is made keyboard-focusable with an accessible
 * name. Returns a callback ref to attach to the element with `overflow-x: auto`;
 * tracking the element as state re-binds the effects when the scroller actually
 * mounts/swaps (e.g. the sheet renders "Loading…" first, then the real table).
 */
export function useScrollFadeX(label: string) {
  const viewport = useViewport();
  const isWide = viewport !== "mobile";
  const [hostEl, setHostEl] = useState<HTMLElement | null>(null);

  // Track the latest label without re-binding effects/events (set once on init).
  const labelRef = useRef(label);
  labelRef.current = label;

  // ── Desktop/tablet: custom scrollbar, mask on the OS viewport ──
  const [initOverlayScrollbars, getInstance] = useOverlayScrollbars({
    defer: true,
    options: {
      scrollbars: { autoHide: "leave", autoHideDelay: 600, theme: "os-theme-macrotide" },
    },
    events: {
      // `initialized` covers first paint + seeds a11y; `scroll` tracks user
      // movement; `updated` covers any content/size change (rows arriving,
      // resize) — together they replace a separate ResizeObserver.
      initialized: (i) => {
        const vp = i.elements().viewport;
        applyA11y(vp, labelRef.current);
        paintMask(vp);
      },
      scroll: (i) => paintMask(i.elements().viewport),
      updated: (i) => paintMask(i.elements().viewport),
    },
  });

  useEffect(() => {
    if (!hostEl || !isWide) return;
    initOverlayScrollbars(hostEl);
    return () => {
      getInstance()?.destroy();
    };
  }, [hostEl, isWide, initOverlayScrollbars, getInstance]);

  // ── Mobile: native touch scroll, mask on the host ──
  useEffect(() => {
    if (!hostEl || isWide) return;
    applyA11y(hostEl, labelRef.current);
    paintMask(hostEl);
    const onScroll = () => paintMask(hostEl);
    hostEl.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => paintMask(hostEl));
    ro.observe(hostEl);
    return () => {
      hostEl.removeEventListener("scroll", onScroll);
      ro.disconnect();
      clearMask(hostEl);
    };
  }, [hostEl, isWide]);

  return useCallback((node: HTMLElement | null) => setHostEl(node), []);
}
