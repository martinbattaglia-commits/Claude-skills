"use client";

import { useOverlayScrollbars } from "overlayscrollbars-react";
import { useCallback, useEffect, useState } from "react";
import { useViewport } from "@/lib/useViewport";

/**
 * Shared OverlayScrollbars initializer for the docked side-panel scrollers
 * (panel bodies + the in-panel thread list). Mirrors the inits in App.tsx
 * (`.ra-main`) and Modal.tsx (`Modal.Body`): same `os-theme-macrotide` theme,
 * same autoHide feel, and desktop/tablet-only — mobile/touch keeps the native
 * scrollbar (the OS overlay reads poorly under touch).
 *
 * Returns a callback ref to attach to the element that natively has
 * `overflow-y: auto`. A callback ref (over a plain RefObject) is deliberate:
 * it tracks the element as state, so the effect re-binds when the scroller
 * element actually mounts/swaps — e.g. a panel that renders a non-scrolling
 * "Loading…" body first and the real body once data arrives. The instance is
 * destroyed on unmount, on a wide→mobile shell swap, and whenever the attached
 * element changes — which also covers the panel unmounting as the user closes
 * it (the owning component, and this hook, unmount with it).
 *
 * The targeted scrollers (`.ra-panel-body`, `.ra-thread-panel`, `.chat-stream`)
 * live in `.ra-panel`, a SIBLING of `.ra-main` — not inside `.ra-main`'s
 * generated OS viewport — so there's no nested-OverlayScrollbars hazard. The
 * chat view's real scroller is the inner `.chat-stream` (ChatScreen attaches
 * this hook to it); the wrapping `.ra-chat-body` stays native since it never
 * scrolls itself.
 */
export function useOverlayScrollbar(enabled = true) {
  const viewport = useViewport();
  const isWide = viewport !== "mobile";
  const [el, setEl] = useState<HTMLElement | null>(null);

  const [initOverlayScrollbars, getInstance] = useOverlayScrollbars({
    defer: true,
    options: {
      scrollbars: {
        autoHide: "leave",
        autoHideDelay: 600,
        theme: "os-theme-macrotide",
      },
    },
  });

  useEffect(() => {
    if (!el || !isWide || !enabled) return;
    initOverlayScrollbars(el);
    return () => {
      getInstance()?.destroy();
    };
  }, [el, isWide, enabled, initOverlayScrollbars, getInstance]);

  return useCallback((node: HTMLElement | null) => setEl(node), []);
}
