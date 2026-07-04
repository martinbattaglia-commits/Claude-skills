"use client";

import { useEffect, useState } from "react";

export type Viewport = "mobile" | "tablet" | "desktop";

const MOBILE_MAX = 700;
// Side-by-side panel kicks in at 1000px: main ≈ 456px with the compact rail.
// Below 1000, the panel becomes an overlay (.ra-shell.tablet) so main keeps
// its full width.
const TABLET_MAX = 1000;

function widthToViewport(w: number): Viewport {
  if (w < MOBILE_MAX) return "mobile";
  if (w < TABLET_MAX) return "tablet";
  return "desktop";
}

/**
 * Returns the current viewport bucket: mobile (<700) | tablet (700–999) | desktop (≥1000).
 * Safe to call in client components; reads window.innerWidth synchronously since
 * the App is mounted with ssr: false.
 */
export function useViewport(): Viewport {
  const [w, setW] = useState<number>(() =>
    typeof window !== "undefined" ? window.innerWidth : 1280,
  );

  useEffect(() => {
    // Debounce: a rotate/resize fires a burst of `resize` events, and each
    // width change can re-render the whole app. Coalescing to the settled width
    // avoids thrash mid-gesture. (Debounce alone does NOT prevent the
    // breakpoint-crossing remount — the screen subtree is kept mounted via the
    // persistent portal in App.tsx; this just trims redundant renders.)
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => setW(window.innerWidth), 100);
    };
    window.addEventListener("resize", onResize);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return widthToViewport(w);
}
