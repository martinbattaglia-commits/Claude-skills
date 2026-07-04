// Demo-mode read helpers over the committed NAV-history fixture
// (lib/mock/demo-history.ts).
//
// These mirror the SHAPE the live market.db read paths produce, so the demo
// branch in lib/db/queries/series.ts and lib/market/benchmarks.ts can swap in
// fixture data without changing their downstream logic (FX, date alignment,
// aggregation). The fixture stores compact [date, value] tuples at variable
// resolution (daily recent / weekly far-back); these helpers decode them and
// apply the caller's range-start filter, exactly as the DB paths filter
// nav_history rows.
//
// RE-DATING: the committed fixture has fixed absolute dates, but the decode
// helpers SHIFT every point so the latest lands on today (one shared whole-day
// delta across all series). So the demo always looks current — at any future
// date, with no quarterly refresh — and the recent window stays daily-dense.
// Re-running the generator now only refreshes the index SHAPES, never recency.
//
// CARRY-IN: when a range window starts on a date a series has no point exactly
// on, the in-window data alone has nothing to seed the FIRST in-window date. So
// the decode helpers also emit the last point STRICTLY BEFORE `since`, snapped
// forward to the `since` date, as a carry-in. That gives every series a value on
// the window's left edge — but the carry-in date is `since` itself (never the
// real pre-window date), so it does NOT widen the plotted timeline past the
// window start. Mirrors the carry-in the market.db path applies (see
// lib/db/queries/series.ts).

import { DEMO_HOLDING_HISTORY, DEMO_INDEX_HISTORY, type EncodedPoint } from "./demo-history";
import type { HistoryPoint } from "./demo-history-transform";

const MS_PER_DAY = 86_400_000;

/**
 * The date the committed fixture was generated up to — the latest point across
 * every series (they're all built together in one pass, so they share it). This
 * is the "now" the fixture was captured at, and the re-dating anchor.
 */
const FIXTURE_ANCHOR: string = (() => {
  let max = "";
  for (const series of [
    ...Object.values(DEMO_INDEX_HISTORY),
    ...Object.values(DEMO_HOLDING_HISTORY),
  ]) {
    const last = series[series.length - 1]?.[0];
    if (last && last > max) max = last;
  }
  return max;
})();

/** Whole-day offset from the fixture anchor to today (UTC). 0 when no anchor. */
function redateDelta(): number {
  if (!FIXTURE_ANCHOR) return 0;
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((todayUtc - Date.parse(`${FIXTURE_ANCHOR}T00:00:00Z`)) / MS_PER_DAY);
}

/** Shift an ISO `YYYY-MM-DD` by whole days (UTC). */
function addDays(dateIso: string, days: number): string {
  if (days === 0) return dateIso;
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Decode compact tuples → { date, value }[], RE-DATED so the fixture's latest
 * point lands on TODAY (every point shifts by the same whole-day delta). This
 * keeps the demo looking current at ANY date with no quarterly refresh, while
 * preserving each series' spacing/density and cross-series alignment (one shared
 * delta). Only dates move — values are untouched.
 *
 * With no `since`, returns the whole (re-dated) series. With `since`, returns the
 * in-window points PLUS a carry-in: the last point before `since` re-dated to
 * `since`, so the window's first date always has a value. If a real point already
 * lands on `since`, no synthetic carry-in is added.
 */
function decode(points: EncodedPoint[] | undefined, since?: string): HistoryPoint[] {
  if (!points) return [];
  const delta = redateDelta();
  if (!since) return points.map(([date, value]) => ({ date: addDays(date, delta), value }));

  const out: HistoryPoint[] = [];
  let carry: number | null = null;
  for (const [rawDate, value] of points) {
    const date = addDays(rawDate, delta);
    if (date < since) {
      carry = value; // remember the most recent pre-window value
      continue;
    }
    out.push({ date, value });
  }
  // Seed the left edge: if nothing lands exactly on `since`, prepend the carry-in
  // value dated to `since` itself (so it seeds the fill without widening the axis).
  if (carry !== null && (out.length === 0 || out[0].date !== since)) {
    out.unshift({ date: since, value: carry });
  }
  return out;
}

/**
 * Per-holding NAV series for a demo holding, keyed by its runtime cache key
 * `${quoteSource}:${ticker}`. Returns null when the key is unmapped (caller
 * degrades gracefully, exactly as a market.db miss would). `value` here is the
 * holding's TOTAL value (units × NAV) in THB, already scaled to the seeded
 * current value — see demo-history-transform.buildHoldingSeries. Includes a
 * carry-in point on `since` so the window's first date is never partial.
 */
export function demoHoldingSeries(cacheKey: string, since?: string): HistoryPoint[] | null {
  const raw = DEMO_HOLDING_HISTORY[cacheKey];
  if (!raw) return null;
  return decode(raw, since);
}

/**
 * Index series for a fixture index key (e.g. "sp500", "set"). Used by the
 * benchmark overlay's demo branch. Returns [] for an unknown key, matching
 * getBenchmarkSeries' "unavailable" contract. Includes a carry-in point on
 * `since` so the overlay spans the full window from its first date.
 */
export function demoIndexSeries(indexKey: string, since?: string): HistoryPoint[] {
  return decode(DEMO_INDEX_HISTORY[indexKey], since);
}

/** True when the fixture has a series for this holding cache key. */
export function hasDemoHoldingSeries(cacheKey: string): boolean {
  return cacheKey in DEMO_HOLDING_HISTORY;
}
