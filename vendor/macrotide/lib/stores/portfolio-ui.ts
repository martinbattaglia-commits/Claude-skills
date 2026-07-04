"use client";

// Typed external store coordinating the Portfolios UI across the three trees
// that aren't in a common provider subtree: the right-rail PortfoliosPanel, the
// PortfolioScreen, and App.tsx (which owns the create/edit sheet). It replaces
// five untyped window CustomEvents (`activate-portfolio`,
// `portfolio-active-changed`, `portfolio-active-request`, `edit-portfolio`,
// `new-portfolio`) and their race-prone mount handshake with one module
// singleton read via React's built-in `useSyncExternalStore` — no context, no
// new dependency.
//
// State model:
//   - `activeId`: which portfolio the screen + panel show ("all" = combined).
//   - edit/new are CONSUMABLE intents, not durable state: App.tsx reads them
//     once and clears them so they fire exactly once and never re-trigger.
//       · `editTarget`: portfolio id to open the edit sheet for, or null.
//       · `newNonce`:   bumped on every "new portfolio" request; App reacts to
//                       the change and records the value it has handled.

import { useSyncExternalStore } from "react";

export interface PortfolioUiState {
  /** Active portfolio id; "all" is the combined view. */
  activeId: string;
  /** Asset-class filter for the holdings list ("all" or an AssetClass). Lives here
   *  so it survives navigating to a position and back, like `activeId`. */
  filter: string;
  /** Pending "open edit sheet for this id" intent, or null when consumed. */
  editTarget: string | null;
  /** Incrementing counter; a change signals a pending "open new sheet" intent. */
  newNonce: number;
}

let state: PortfolioUiState = { activeId: "all", filter: "all", editTarget: null, newNonce: 0 };

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function setState(patch: Partial<PortfolioUiState>) {
  state = { ...state, ...patch };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): PortfolioUiState {
  return state;
}

// ── Actions (callable from anywhere, not just inside React) ──────────────────

/** Select the active portfolio (drives both the panel highlight and the screen). */
export function setActiveId(id: string) {
  if (state.activeId === id) return;
  setState({ activeId: id });
}

/** Set the holdings asset-class filter (persists across position navigation). */
export function setFilter(f: string) {
  if (state.filter === f) return;
  setState({ filter: f });
}

/** Request the create-portfolio sheet. App.tsx consumes this once. */
export function requestNew() {
  setState({ newNonce: state.newNonce + 1 });
}

/** Request the edit sheet for `id`. App.tsx consumes + clears it once. */
export function requestEdit(id: string) {
  setState({ editTarget: id });
}

/** App.tsx calls this after opening the edit sheet so the intent fires once. */
export function consumeEditTarget() {
  if (state.editTarget !== null) setState({ editTarget: null });
}

// ── React binding ────────────────────────────────────────────────────────────

/**
 * Subscribe to the portfolio UI store. Returns the current snapshot plus the
 * action functions. The snapshot is referentially stable between changes, so
 * components only re-render when state they read actually changes.
 */
export function usePortfolioUi() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    ...snapshot,
    setActiveId,
    setFilter,
    requestNew,
    requestEdit,
    consumeEditTarget,
  };
}
