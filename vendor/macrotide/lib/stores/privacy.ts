"use client";

// Privacy toggle ("Discreet Mode"): when on, the Portfolios screen masks every
// ฿ monetary figure (total balance, all-time P&L amount, per-holding value)
// behind a soft blur while keeping all percentages visible — so the user keeps
// allocation/return signal without exposing absolute amounts to a shoulder-
// surfer or a screen share. The choice persists in localStorage (default:
// visible) and is shared across the trees that render amounts via React's
// built-in `useSyncExternalStore`, mirroring lib/stores/portfolio-ui.ts.

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "macrotide-privacy";

function read(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

// Initialized once from localStorage on client module load; the server snapshot
// is always `false` (visible) so SSR/first-paint matches the default.
let hidden = read();

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return hidden;
}

function getServerSnapshot(): boolean {
  return false;
}

/** Flip privacy on/off and persist the choice. Callable from anywhere. */
export function togglePrivacy() {
  hidden = !hidden;
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, hidden ? "1" : "0");
    }
  } catch {}
  emit();
}

/** Subscribe to the privacy flag. `hidden` true = amounts are masked. */
export function usePrivacy() {
  const isHidden = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { hidden: isHidden, toggle: togglePrivacy };
}
