// Contribution-mode (#149) — pure, the "Incl. cash" ↔ "Funds only" return lever.
//
// The hero BALANCE always shows total wealth (incl. cash); this only adjusts the
// RETURN view (the headline %, the period %, and the chart's value + contribution
// lines so they agree). Two slices come out:
//
//   • RESERVED cash is ALWAYS out of the return (both modes) — money the user set
//     aside for a purpose, never meant to chase a return.
//   • In "Funds only" (mode B) the rest of the HELD cash comes out too, so idle dry
//     powder doesn't drag the figure. "Incl. cash" (mode A, the default) keeps it,
//     the honest money-weighted view.
//
// In-transit settlement cash (a sell→buy switch's proceeds mid-flight) is NEVER
// removed by either mode — it's committed capital, not idle drag, so a routine
// rebalance draws no phantom dip in the return view. Hence "Funds only" subtracts
// `heldCashValue` (held accounts only), not `cashValue` (which also carries the float
// for the Mix composition, where the money really is sitting in cash).
//
// With no cash decomposition (static placeholder data) the inputs pass through
// unchanged, so a book with no cash is byte-identical in either mode.

import type { CashDecomp, SeriesPoint } from "@/lib/static/types";

export type CashMode = "incl" | "funds";

export interface ReturnView {
  /** Value line for the return = full value − the excluded cash slice, by date. */
  series: SeriesPoint[];
  /** Contribution line for the return = full contributions − excluded cash contributions. */
  netInvested: SeriesPoint[];
}

/** The cash VALUE slice a mode removes from the return view. */
function excludedValue(mode: CashMode, decomp: CashDecomp): SeriesPoint[] {
  // "Funds only" removes held cash accounts (idle drag), NOT in-transit settlement
  // float — so a fund switch doesn't crater the line. "Incl." removes only reserved.
  return mode === "funds" ? decomp.heldCashValue : decomp.reservedCashValue;
}

/** The cash CONTRIBUTION slice a mode removes from the return view. */
function excludedContrib(mode: CashMode, decomp: CashDecomp): SeriesPoint[] {
  return mode === "funds" ? decomp.cashContrib : decomp.reservedCashContrib;
}

/** Subtract `b`'s value at each date from `a` (a's dates win; missing b = 0). */
function subtractByDate(a: SeriesPoint[], b: SeriesPoint[]): SeriesPoint[] {
  if (b.length === 0) return a;
  const sub = new Map(b.map((p) => [p.d, p.v]));
  return a.map((p) => ({ d: p.d, v: p.v - (sub.get(p.d) ?? 0) }));
}

/**
 * Adjust the value + contribution lines for the return view under `mode`.
 * `decomp` aligns to `series`' dates. No decomp (static data) → pass through.
 */
export function applyCashMode(
  mode: CashMode,
  series: SeriesPoint[],
  netInvested: SeriesPoint[] | undefined,
  decomp: CashDecomp | undefined,
): ReturnView {
  const contrib = netInvested ?? [];
  if (!decomp) return { series, netInvested: contrib };
  return {
    series: subtractByDate(series, excludedValue(mode, decomp)),
    netInvested: subtractByDate(contrib, excludedContrib(mode, decomp)),
  };
}

/**
 * The hero return's value denominator-mate: total wealth minus the excluded cash
 * slice (latest date). `totalValue` is the full net-worth balance; we remove the
 * same slice the value line drops so the hero % matches the chart.
 */
export function returnValue(
  mode: CashMode,
  totalValue: number,
  decomp: CashDecomp | undefined,
): number {
  if (!decomp) return totalValue;
  return totalValue - (excludedValue(mode, decomp).at(-1)?.v ?? 0);
}

/** Latest idle (non-reserved, held) cash in THB — for the pill's caption. Excludes
 * in-transit settlement float, which isn't idle dry powder but capital mid-switch. */
export function uninvestedCash(decomp: CashDecomp | undefined): number {
  if (!decomp) return 0;
  const held = decomp.heldCashValue.at(-1)?.v ?? 0;
  const reserved = decomp.reservedCashValue.at(-1)?.v ?? 0;
  return Math.max(0, held - reserved);
}
