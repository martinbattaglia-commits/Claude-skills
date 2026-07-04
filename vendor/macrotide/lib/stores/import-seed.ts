"use client";

// Typed external store that lets the Advisor's in-chat holdings table open the
// unified Add modal (RecordSheet) pre-seeded with rows. ChatScreen (in the chat
// tree) and RecordSheet (lifted in App.tsx, above the mobile↔wide swap) share no
// provider subtree, so — exactly like lib/stores/chat-ui.ts — they coordinate
// through one module singleton read via useSyncExternalStore.
//
// `seedRows` + `openNonce` are a CONSUMABLE intent, not durable state: ChatScreen
// publishes rows via requestImportWithRows(); App reacts to the nonce change,
// copies the rows into the sheet, and calls consumeImportSeed() to clear them.

import { useSyncExternalStore } from "react";
import type { QuoteSource } from "@/lib/market/sources";
import type { ExtractedTxnRow } from "@/lib/portfolio/ocr";

/**
 * One extracted holding row handed to the importer. Structurally matches the
 * `DerivedRow` the image-import API returns (lib/portfolio/ocr.ts) and the
 * `ImportedRow` the sheet already consumes — declared here as a plain interface
 * because the store is client-side and DerivedRow lives in a `server-only` module.
 */
export interface ImportSeedRow {
  ticker: string;
  englishName?: string;
  units?: number;
  nav?: number;
  avgCost?: number;
  value?: number;
  pl?: number;
  /** Invested ฿ cost-basis TOTAL (a fact); the per-unit avg cost derives at the fold. */
  costTotal?: number;
  quoteSource?: QuoteSource;
  estimated?: boolean;
  needsUnits?: boolean;
  /** Snapshot as-of date (ISO), when the Advisor read one — dates the Balance. */
  asOf?: string;
}

export interface ImportSeedState {
  /** Holdings rows to seed into the importer, or null when none pending. */
  seedRows: ImportSeedRow[] | null;
  /** Bumped per holdings request so the same rows can re-open the sheet. */
  openNonce: number;
  /** Transaction rows to seed (→ trade rows), or null when none pending. */
  txnRows: ExtractedTxnRow[] | null;
  /** Bumped per transaction request, separate from the holdings nonce. */
  txnNonce: number;
}

let state: ImportSeedState = { seedRows: null, openNonce: 0, txnRows: null, txnNonce: 0 };

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function setState(patch: Partial<ImportSeedState>) {
  state = { ...state, ...patch };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ImportSeedState {
  return state;
}

// ── Actions ──────────────────────────────────────────────────────────────────

/** ChatScreen asks App to open the importer pre-filled with these rows. */
export function requestImportWithRows(rows: ImportSeedRow[]) {
  setState({ seedRows: rows, openNonce: state.openNonce + 1 });
}

/** App calls this after handling a request so the intent fires exactly once. */
export function consumeImportSeed() {
  if (state.seedRows !== null) setState({ seedRows: null });
}

/** ChatScreen asks App to open the importer pre-filled with these TRANSACTIONS. */
export function requestTxnImportWithRows(rows: ExtractedTxnRow[]) {
  setState({ txnRows: rows, txnNonce: state.txnNonce + 1 });
}

/** App calls this after handling a transaction request so it fires exactly once. */
export function consumeTxnImportSeed() {
  if (state.txnRows !== null) setState({ txnRows: null });
}

// ── React binding ──────────────────────────────────────────────────────────

export function useImportSeed() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    ...snapshot,
    requestImportWithRows,
    consumeImportSeed,
    requestTxnImportWithRows,
    consumeTxnImportSeed,
  };
}
