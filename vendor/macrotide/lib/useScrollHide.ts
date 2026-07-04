"use client";

import { useEffect } from "react";

/**
 * Google-Play-style "hide topbar on scroll-down, show on scroll-up". Sets a
 * `data-topbar-hidden` attribute on `<body>` that CSS reads to translateY
 * the topbar and slide the sub-tabs up to fill its space.
 *
 * Graceful degradation: without JS (or with prefers-reduced-motion), the
 * attribute is never set and the layout stays in its base sticky state —
 * topbar and sub-tabs both pinned, same across every screen.
 *
 * Scroll context varies by POINTER: native scroll (touch) scrolls `window`;
 * custom scroll (mouse) scrolls the OverlayScrollbars viewport inside the
 * active scroll host — `.ra-main` on the wide shell or `.app-scroll` on the
 * mobile shell. OverlayScrollbars takes over the host's overflow and moves the
 * actual scrolling to a generated child carrying `[data-overlayscrollbars-viewport]`,
 * so the host's own scrollTop stays 0 — we read the viewport's scrollTop
 * instead. Scroll events don't bubble, but capture-phase delegation on
 * `document` catches both the window and the viewport scroll.
 */

// Direct-child (`>`): OverlayScrollbars' generated viewport is a direct child of
// the element it's initialized on, so this hits exactly the PAGE scroller and
// never a nested instance (e.g. ChatScreen's own message-list scroller). Only
// one host exists at a time, so first-match is unambiguous.
const VIEWPORT_SELECTOR =
  ".ra-main > [data-overlayscrollbars-viewport], .app-scroll > [data-overlayscrollbars-viewport]";

const HIDE_AFTER_PX = 60; // ignore tiny scrolls at the top
const NOISE_PX = 4; // delta below this is treated as no movement

export function useScrollHide(): void {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let lastY = 0;
    let rafId = 0;

    const update = () => {
      rafId = 0;
      // Custom scroll (mouse): read the OverlayScrollbars viewport (the element
      // that actually scrolls). Native scroll (touch) has no such host, so this
      // is null and we fall back to the window scroll position.
      const viewport = document.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
      const y = viewport ? viewport.scrollTop : window.scrollY;
      const delta = y - lastY;
      if (Math.abs(delta) < NOISE_PX) return;
      if (delta > 0 && y > HIDE_AFTER_PX) {
        document.body.dataset.topbarHidden = "true";
      } else if (delta < 0) {
        document.body.dataset.topbarHidden = "false";
      }
      lastY = y;
    };

    const onScroll = () => {
      if (rafId !== 0) return;
      rafId = window.requestAnimationFrame(update);
    };

    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      if (rafId !== 0) window.cancelAnimationFrame(rafId);
      document.removeEventListener("scroll", onScroll, { capture: true });
      delete document.body.dataset.topbarHidden;
    };
  }, []);
}
