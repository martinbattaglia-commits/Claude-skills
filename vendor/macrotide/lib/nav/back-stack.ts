"use client";

// Browser-history integration so hardware/gesture Back (Android, iOS edge-swipe)
// and the desktop Back button dismiss the top UI layer — an open modal/sheet
// first, then a drill-in screen — the way a native app behaves. The app's
// navigation is otherwise pure React state (components/App.tsx); this maps each
// transient layer onto exactly one browser-history entry without changing the
// URL (pushState with no url keeps the current path).
//
// Model: every open layer pushes ONE history entry and registers a `close`.
//   • Hardware Back        → popstate → pop the top layer, run its close().
//   • Programmatic close   → the registrar's release() reclaims its matching
//     (✕ / overlay / Escape    history entry (history.back) and the resulting
//      / submit / unmount)      popstate is swallowed so no other layer moves.
// History depth therefore tracks the number of open layers, and Back is strict
// LIFO across stacked modals and nested drill-ins alike. Bottom-tab switches
// are roots (they don't stack) — clearBackLayers() drops any open drill-in.

import { useEffect, useRef } from "react";

type Layer = { close: () => void };

const stack: Layer[] = [];
let pendingIgnore = 0; // popstate events to swallow (our own programmatic backs)
let listening = false;

function onPopState() {
  if (pendingIgnore > 0) {
    pendingIgnore -= 1;
    return;
  }
  // Back/forward traversal: close the top layer. An empty stack (e.g. a stale
  // orphan entry, see release()) is a harmless no-op — the browser navigates.
  stack.pop()?.close();
}

function ensureListening() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("popstate", onPopState);
}

// Register an open layer. Pushes a history entry and returns release(), which
// the caller MUST run when the layer closes by any non-Back means so the pushed
// entry is reclaimed. Calling release() after a Back-driven close is a no-op.
export function pushBackLayer(close: () => void): () => void {
  ensureListening();
  if (typeof window === "undefined") return () => {};
  const layer: Layer = { close };
  stack.push(layer);
  window.history.pushState({ mtLayer: stack.length }, "");
  return function release() {
    const idx = stack.lastIndexOf(layer);
    if (idx === -1) return; // already popped by Back
    const wasTop = idx === stack.length - 1;
    stack.splice(idx, 1);
    if (wasTop) {
      pendingIgnore += 1;
      window.history.back(); // reclaim our entry; swallow the echo popstate
    }
    // Not top: a layer was pushed above us (a modal that triggers a screen
    // navigation as it closes). Leave the orphan history entry — a later Back
    // lands on a shorter stack and no-ops harmlessly rather than corrupting the
    // entry that's now on top.
  };
}

// Reclaim every open layer's history entry at once — used by a root-tab switch
// that abandons an open drill-in (tabs are roots; they don't stack). Leaves
// history depth at the pre-layer baseline; the empty-stack popstate(s) no-op.
export function clearBackLayers(): void {
  if (typeof window === "undefined") return;
  const n = stack.length;
  if (n === 0) return;
  stack.length = 0;
  window.history.go(-n);
}

// Reclaim the TOP `n` layers in a single history.go(-n) — for a modal-as-page
// stack closing all its levels at once (the detail-stack ✕). Batching avoids the
// n separate, async history.back() calls the per-layer release() would make, which
// could interleave with a synchronous pushState from a modal opened right after.
// Only the top n are dropped; deeper layers (an underlying screen drill-in) stay.
export function releaseTopLayers(n: number): void {
  if (typeof window === "undefined") return;
  const count = Math.min(n, stack.length);
  if (count <= 0) return;
  stack.length -= count;
  pendingIgnore += count; // swallow the count echo popstates go(-count) fires
  window.history.go(-count);
}

// Hook form for components with an `open` boolean (the Modal primitive). Pushes
// a layer while open; routes Back to the latest onClose via a ref so an inline
// onClose identity change doesn't churn the history entry.
export function useBackDismiss(open: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    return pushBackLayer(() => closeRef.current());
  }, [open]);
}
