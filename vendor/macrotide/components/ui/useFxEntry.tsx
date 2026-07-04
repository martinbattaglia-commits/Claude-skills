"use client";

// Shared currency + trade-date-FX entry for the Add/Record modal and the History
// inline editor, so the two surfaces can't drift.
//
// Currency shows as a left-edge SYMBOL prefix ($ / ฿) on the money box — quiet, no codes.
// A SECURITY's currency is DERIVED from its price source + symbol (a US Stock/ETF is $, a
// Thai fund is ฿) and rendered read-only; you change it by flipping the source, not a
// separate toggle. CASH picks its own currency, so it gets an interactive ฿⇄$ pill. THB is
// the base currency — its ฿ is muted (minimal); a non-THB row also gets ONE FX-rate line
// under its first money field. The rate auto-fetches (keyless Frankfurter cache via
// /api/fx, 4 dp, editable, reset-to-market); native money folds to THB for the ledger.

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { fmtTHBClean } from "@/lib/format";
import { inferHoldingCurrency } from "@/lib/market/currency";
import { isCashKind } from "@/lib/portfolio/txn-import";
import { CurrencyPrefix } from "./CurrencyPrefix";

/** The row fields the FX-entry logic reads; a Row (RecordSheet) or Draft (History). */
export interface FxEntryRow {
  kind: string;
  ticker: string;
  quoteSource?: string;
  /** Cash picks its currency; a security infers it from the symbol. */
  currency?: string;
  fxToThb?: string;
  fxManual?: boolean;
  tradeDate: string;
}

export type FxEntryPatch = Partial<{ currency: string; fxToThb: string; fxManual: boolean }>;

/**
 * The row's currency. An EXPLICIT currency wins — cash's chosen one, or the STORED
 * `tradeCurrency` when editing an existing row — so a security saved in THB (legacy /
 * a US symbol entered in baht) stays THB and isn't silently re-read as USD from the
 * symbol (which would double-convert on save). Only a fresh security with no currency
 * yet (the Add flow) infers from the symbol. Pure, so the submit/patch paths can call
 * it while mapping over rows (a hook can't run there).
 */
export function fxCurrency(
  row: Pick<FxEntryRow, "kind" | "currency" | "quoteSource" | "ticker">,
): string {
  const explicit = (row.currency ?? "").trim().toUpperCase();
  if (explicit) return explicit;
  return isCashKind(row.kind)
    ? "THB"
    : inferHoldingCurrency(row.quoteSource ?? "manual", row.ticker);
}

/** A currency's short symbol for the prefix — $ / ฿, else the code (rare, e.g. EUR). */
export function currencySymbol(code: string): string {
  return code === "USD" ? "$" : code === "THB" ? "฿" : code;
}

export interface FxEntry {
  /** The row's currency — cash's chosen one, or the symbol's inferred one. */
  currency: string;
  nonThb: boolean;
  /** native → THB via the trade-date rate (1 for THB); undefined passes through. */
  toThb: (v: number | null | undefined) => number | undefined;
  /** The trade-date rate used by `toThb` (1 for THB / no rate). */
  secRate: number;
  /** The left-edge currency symbol ($ / ฿). */
  sym: string;
  /** The money-box currency prefix ($ / ฿). Pass `onCycle` for the interactive pill
   *  (cash, custom asset); omit it for the read-only derived symbol (Thai fund / ETF). */
  prefix: (onCycle?: () => void) => React.ReactNode;
  /** The one FX line for under the FIRST money field: the ฿ equivalent + the day's
   *  rate + an "adjust" link that reveals the inline editor. Null for THB. */
  fxHint: React.ReactNode;
}

/**
 * @param nativeMoney best-effort native money on the row, for the "≈ ฿X" preview.
 */
export function useFxEntry(
  row: FxEntryRow,
  onChange: (patch: FxEntryPatch) => void,
  nativeMoney: number,
): FxEntry {
  const currency = fxCurrency(row);
  const nonThb = currency !== "THB";
  const sym = currencySymbol(currency);
  const rate = Number(row.fxToThb);
  const fxReady = nonThb && rate > 0;
  const secRate = currency === "THB" ? 1 : rate > 0 ? rate : 1;
  const toThb = (v: number | null | undefined): number | undefined =>
    v == null ? undefined : v * secRate;

  const [adjustRate, setAdjustRate] = useState(false);
  const showRateInput = nonThb && (adjustRate || !fxReady);
  // The auto-fetched reference rate, kept so "reset" can restore it after an override.
  const [autoRate, setAutoRate] = useState<string | null>(null);
  const resetRate = () => onChange({ fxToThb: autoRate ?? "", fxManual: false });
  const canReset = !!row.fxManual && !!autoRate && autoRate !== (row.fxToThb ?? "");

  const fxManual = row.fxManual;
  // biome-ignore lint/correctness/useExhaustiveDependencies: onChange is a stable setter closure.
  useEffect(() => {
    if (!nonThb) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.tradeDate)) return;
    let cancelled = false;
    fetch(`/api/fx?from=${encodeURIComponent(currency)}&on=${row.tradeDate}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { rate: number | null } | null) => {
        if (cancelled || body?.rate == null) return;
        // Round to the precision the collapsed line shows so stored value, text, and
        // editor never disagree; write it only while the user hasn't overridden.
        const r = String(Number(body.rate.toFixed(4)));
        setAutoRate(r);
        if (!fxManual) onChange({ fxToThb: r });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currency, nonThb, fxManual, row.tradeDate]);

  const prefix = (onCycle?: () => void) => <CurrencyPrefix code={sym} onCycle={onCycle} />;

  const rateText = `${sym}1 = ฿${row.fxToThb ?? ""}`;
  const fxHint = nonThb ? (
    <span className="rec-fx">
      {showRateInput ? (
        // Compact inline editor ("฿ [rate]") — the currency is on the prefix above.
        <>
          {"฿"}
          <input
            className="rec-fx__rate"
            value={row.fxToThb ?? ""}
            onChange={(e) => {
              onChange({ fxToThb: e.target.value, fxManual: true });
              setAdjustRate(true);
            }}
            placeholder="rate"
            inputMode="decimal"
            aria-label={`Trade-date FX rate, ${currency} to baht`}
          />
          {canReset ? (
            <button type="button" className="link-btn rec-fx__adjust" onClick={resetRate}>
              Reset
            </button>
          ) : null}
          {fxReady ? (
            <button
              type="button"
              className="link-btn rec-fx__adjust rec-fx__done"
              onClick={() => setAdjustRate(false)}
            >
              Done
            </button>
          ) : null}
        </>
      ) : (
        <>
          {/* The ฿ equivalent once an amount is in; the day's rate before that. */}
          {nativeMoney > 0 ? `≈ ${fmtTHBClean(nativeMoney * rate)}` : rateText}
          <button
            type="button"
            className="link-btn rec-fx__adjust"
            onClick={() => setAdjustRate(true)}
          >
            Adjust
            <Icon name="chevron-right" size={11} />
          </button>
        </>
      )}
    </span>
  ) : null;

  return { currency, nonThb, toThb, secRate, sym, prefix, fxHint };
}
