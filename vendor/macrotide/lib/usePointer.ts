"use client";

import { useEffect, useState } from "react";

/**
 * Whether to render custom (OverlayScrollbars) scrollbars instead of native.
 *
 * Gate by INPUT POINTER, not viewport width. A coarse pointer (touch — phone
 * or touch-tablet) keeps native scroll everywhere: the OS auto-hides its bar
 * and momentum/safe-area behavior stays exactly as the device expects. A fine
 * pointer (mouse/trackpad) gets the custom overlay everywhere — including a
 * desktop window narrowed into the mobile shell, where the native scrollbar
 * would otherwise show as a chunky lane.
 *
 * SSR / pre-hydration default is `false` (assume native): the App mounts with
 * ssr: false, so this is only the first client render's value, and defaulting
 * to native means a no-JS / pre-hydrate paint shows plain native scroll —
 * graceful, mirroring useScrollHide's no-JS degradation.
 */
export function usePointer(): boolean {
  const [customScroll, setCustomScroll] = useState<boolean>(() =>
    typeof window !== "undefined" ? !window.matchMedia("(pointer: coarse)").matches : false,
  );

  useEffect(() => {
    const mql = window.matchMedia("(pointer: coarse)");
    // Re-evaluate when the primary pointer changes — e.g. a 2-in-1 docking to a
    // mouse, or a mouse being unplugged from a hybrid device.
    const onChange = () => setCustomScroll(!mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return customScroll;
}
