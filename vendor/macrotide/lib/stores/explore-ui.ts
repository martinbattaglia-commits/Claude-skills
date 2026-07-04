"use client";

// Shared Explore search query — a module singleton so the search text is SHARED
// across the asset-type screeners (All / Thai / US ETFs / US stocks), which are
// kept mounted side by side: typing "vanguard" under All carries into US ETFs.
// (Persistence across leaving/returning the screen is handled by the keep-alive
// in App.tsx — the screen stays mounted — so only the cross-screener SHARING
// lives here.) Read via `useSyncExternalStore`, same shape as portfolio-ui.ts.

import { useSyncExternalStore } from "react";

let query = "";

const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
function getSnapshot() {
  return query;
}

export function setExploreQuery(next: string) {
  if (query === next) return;
  query = next;
  for (const l of listeners) l();
}

export function useExploreQuery(): [string, (q: string) => void] {
  const q = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return [q, setExploreQuery];
}
