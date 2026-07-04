"use client";

/**
 * Per-screen scroll-position memory.
 *
 * Screens are swapped in place inside a single persistent scroll container
 * (see App.tsx) rather than being separate routes, so the container keeps its
 * `scrollTop` across a swap. We use that single root to emulate per-route
 * scroll restoration: as the user switches screens we remember where they were
 * on each one and restore it when they come back.
 *
 * Behavior:
 *   - Switching to a screen restores the scrollTop the user last left it at,
 *     within the current session.
 *   - A screen not yet visited this session opens at the top (default 0) — this
 *     is what fixes the original bug where opening Templates from Portfolio
 *     inherited the Portfolio scroll offset.
 *   - The map is in-memory (module-level), so a full page reload starts a fresh
 *     session: every screen opens at the top again. (Deliberately NOT
 *     session/localStorage.)
 *
 * The scroll root differs by POINTER, mirroring useScrollHide:
 *   - custom scroll (mouse): the OverlayScrollbars-generated viewport inside the
 *     active host — `.ra-main` (wide) or `.app-scroll` (mobile). The host's own
 *     scrollTop stays 0 — the generated child scrolls.
 *   - native scroll (touch): the `window`; no OverlayScrollbars host exists.
 *
 * `doc`/`win` are injectable so the root-selection logic is testable without a
 * real browser.
 */

// Direct-child (`>`): matches exactly the PAGE scroller's generated viewport
// (OverlayScrollbars puts it as a direct child of the init target), never a
// nested instance like ChatScreen's message list. Only one host exists at a
// time, so first-match is unambiguous. Mirrors useScrollHide.
const VIEWPORT_SELECTOR =
  ".ra-main > [data-overlayscrollbars-viewport], .app-scroll > [data-overlayscrollbars-viewport]";

// Minimal duck-typed roots so the read/write helpers work against either the
// OverlayScrollbars viewport element or the window, and stay testable.
type DocLike = Pick<Document, "querySelector">;
type WinLike = Pick<Window, "scrollTo" | "scrollY">;

/**
 * The scroll root the rest of the app uses: the OverlayScrollbars viewport on
 * tablet/desktop, else the window. Returned as a uniform getter/setter so
 * callers don't branch on which one they got. `null` when neither exists (SSR /
 * node env without injected fakes).
 */
function getScrollRoot(
  doc: DocLike | undefined = typeof document !== "undefined" ? document : undefined,
  win: WinLike | undefined = typeof window !== "undefined" ? window : undefined,
): { get: () => number; set: (top: number) => void } | null {
  // Custom scroll (mouse): the OverlayScrollbars viewport. Native scroll (touch)
  // has no host, so this is null and we fall back to the window.
  const viewport = doc?.querySelector?.<HTMLElement>(VIEWPORT_SELECTOR) ?? null;
  if (viewport) {
    return {
      get: () => viewport.scrollTop,
      set: (top) => {
        viewport.scrollTop = top;
      },
    };
  }
  if (win) {
    return {
      get: () => win.scrollY ?? 0,
      set: (top) => win.scrollTo?.(0, top),
    };
  }
  return null;
}

/**
 * Pure save/restore over a `screen → scrollTop` map. Separated from the DOM so
 * the map behavior is unit-testable: `saveScrollPosition` records the current
 * top; `restoreScrollPosition` returns what was saved, or 0 for an unvisited
 * screen.
 */
export function saveScrollPosition(
  memory: Map<string, number>,
  screen: string,
  scrollTop: number,
): void {
  memory.set(screen, scrollTop);
}

export function restoreScrollPosition(memory: Map<string, number>, screen: string): number {
  return memory.get(screen) ?? 0;
}

/**
 * Read the live scroll root and remember `screen`'s current position. No-op if
 * there's no root (SSR).
 *
 * Called continuously from App.tsx's capture-phase scroll listener (rAF
 * throttled), keyed by the *current* screen. Tracking the position live — rather
 * than reading it once when the screen is torn down — is what fixes the desktop
 * bug: on a screen swap the new (often shorter) content makes the
 * OverlayScrollbars viewport CLAMP its scrollTop before any teardown code could
 * read it, so a cleanup-time read saved a wrong/0 offset for the screen being
 * left. The live value is captured before the swap, so it's always correct.
 */
export function saveScreenScroll(
  memory: Map<string, number>,
  screen: string,
  doc?: DocLike,
  win?: WinLike,
): void {
  const root = getScrollRoot(doc, win);
  if (!root) return;
  saveScrollPosition(memory, screen, root.get());
}

/**
 * Restore `screen`'s remembered scroll position onto the live scroll root,
 * defaulting to the top for a never-visited screen. Clamps gracefully: if the
 * entering screen is shorter than the saved offset, the browser/element pins
 * scrollTop to its own max, so we never scroll past the content.
 *
 * Idempotent: restoring the same value twice is harmless, so App.tsx can call
 * this both pre-paint (useLayoutEffect) and on a requestAnimationFrame fallback
 * for the desktop case where the OverlayScrollbars viewport isn't measured yet
 * at layout time.
 */
export function restoreScreenScroll(
  memory: Map<string, number>,
  screen: string,
  doc?: DocLike,
  win?: WinLike,
): void {
  const root = getScrollRoot(doc, win);
  if (!root) return;
  root.set(restoreScrollPosition(memory, screen));
}

export { getScrollRoot };
