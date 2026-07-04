import { describe, expect, it, vi } from "vitest";
import {
  getScrollRoot,
  restoreScreenScroll,
  restoreScrollPosition,
  saveScreenScroll,
  saveScrollPosition,
} from "./screenScroll";

// Two testable cores in the node env (the live scroll listener + rAF timing +
// real OverlayScrollbars clamping are NOT unit-testable here — owner verifies in
// a real desktop browser): (1) scroll-root selection — tablet/desktop scroll the
// OverlayScrollbars viewport inside `.ra-main`, mobile (no viewport) falls back
// to the window; (2) the pure save/restore map — save then restore returns the
// saved value, and an unvisited screen restores 0. We inject fake doc/win.

describe("getScrollRoot", () => {
  it("targets the OverlayScrollbars viewport when present (tablet/desktop)", () => {
    const viewport = { scrollTop: 420 } as HTMLElement;
    const doc = { querySelector: () => viewport } as unknown as Document;
    const win = { scrollTo: vi.fn(), scrollY: 0 } as unknown as Window;

    const root = getScrollRoot(doc, win);
    expect(root?.get()).toBe(420);
    root?.set(0);
    expect(viewport.scrollTop).toBe(0);
    // Window is left alone when a viewport owns the scroll.
    expect(win.scrollTo).not.toHaveBeenCalled();
  });

  it("falls back to the window when there is no viewport (mobile)", () => {
    const doc = { querySelector: () => null } as unknown as Document;
    const scrollTo = vi.fn();
    const win = { scrollTo, scrollY: 137 } as unknown as Window;

    const root = getScrollRoot(doc, win);
    expect(root?.get()).toBe(137);
    root?.set(50);
    expect(scrollTo).toHaveBeenCalledWith(0, 50);
  });

  it("returns null when neither root exists (SSR / node)", () => {
    expect(getScrollRoot(undefined, undefined)).toBeNull();
  });
});

describe("save/restore scroll map", () => {
  it("restores the saved position for a visited screen", () => {
    const memory = new Map<string, number>();
    saveScrollPosition(memory, "portfolio", 300);
    expect(restoreScrollPosition(memory, "portfolio")).toBe(300);
  });

  it("restores 0 for a screen never visited this session", () => {
    const memory = new Map<string, number>();
    expect(restoreScrollPosition(memory, "templates")).toBe(0);
  });

  it("overwrites a screen's position on a later save (latest wins)", () => {
    const memory = new Map<string, number>();
    saveScrollPosition(memory, "markets", 100);
    saveScrollPosition(memory, "markets", 250);
    expect(restoreScrollPosition(memory, "markets")).toBe(250);
  });
});

// NOT unit-testable in the node env, hence covered only by the owner's
// real-browser check: the capture-phase scroll listener in App.tsx, its rAF
// throttle, the live current-screen ref, and the real OverlayScrollbars viewport
// clamping a too-large scrollTop. Here we cover the pure pieces those rely on —
// saveScreenScroll reads the live root, restoreScreenScroll writes it back, and
// both no-op without a root.
describe("save/restore against the live root", () => {
  it("save reads the root's scrollTop; restore writes it back on return", () => {
    const memory = new Map<string, number>();
    const viewport = { scrollTop: 0 } as HTMLElement;
    const doc = { querySelector: () => viewport } as unknown as Document;
    const win = { scrollTo: vi.fn(), scrollY: 0 } as unknown as Window;

    // While on Portfolio, the live listener captures its current scrollTop.
    viewport.scrollTop = 480;
    saveScreenScroll(memory, "portfolio", doc, win);

    // Enters an unvisited screen — restores to top.
    restoreScreenScroll(memory, "templates", doc, win);
    expect(viewport.scrollTop).toBe(0);

    // After scrolling Templates (still 0 here), returns to Portfolio — 480.
    saveScreenScroll(memory, "templates", doc, win);
    restoreScreenScroll(memory, "portfolio", doc, win);
    expect(viewport.scrollTop).toBe(480);
  });

  it("restore is idempotent — restoring the same screen twice keeps the value", () => {
    // App.tsx restores both pre-paint (useLayoutEffect) and on a rAF fallback
    // for the desktop OverlayScrollbars timing; a double restore must be safe.
    const memory = new Map<string, number>();
    const viewport = { scrollTop: 0 } as HTMLElement;
    const doc = { querySelector: () => viewport } as unknown as Document;
    const win = { scrollTo: vi.fn(), scrollY: 0 } as unknown as Window;

    saveScrollPosition(memory, "portfolio", 360);
    restoreScreenScroll(memory, "portfolio", doc, win);
    expect(viewport.scrollTop).toBe(360);
    restoreScreenScroll(memory, "portfolio", doc, win);
    expect(viewport.scrollTop).toBe(360);
  });

  it("is a no-op without a root (SSR / node)", () => {
    const memory = new Map<string, number>();
    expect(() => saveScreenScroll(memory, "x", undefined, undefined)).not.toThrow();
    expect(() => restoreScreenScroll(memory, "x", undefined, undefined)).not.toThrow();
    expect(memory.size).toBe(0);
  });
});
