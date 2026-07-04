// Log-scale helpers for the value chart — pure, DB/network-free.
//
// A log axis (the `Log` toggle) can't place a zero (`log(0) = −∞`). The value line hits
// exactly ฿0 whenever the book is fully out of the market — every position sold,
// no held or in-transit cash — which can happen for a stretch in a long history.
// Rather than silently dropping back to linear (a dead toggle), the chart draws
// those dates as a GAP (a line break, on both scales): honest — you held nothing —
// and it keeps the log axis valid because the plotted points are all positive.

/** Below this (THB) the book holds nothing — treat the value as ฿0 (fully out). */
export const FULLY_OUT_THB = 0.5;

/** A date whose portfolio value is ~฿0 → fully out of the market → render a gap. */
export function isFullyOut(valueThb: number): boolean {
  return Math.abs(valueThb) < FULLY_OUT_THB;
}

/**
 * Whether a log axis can be drawn for `values`: it needs at least one real
 * positive point (the ฿0 fully-out dates become gaps, not plotted points). All-zero
 * or empty → no log axis (fall back to linear). Drives both the chart's own guard
 * and the screen's caption, so they can't disagree.
 */
export function canLogScale(values: readonly number[]): boolean {
  return values.some((v) => !isFullyOut(v) && v > 0);
}
