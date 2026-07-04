// Shared range → start-date helper. Client-safe (no server-only, no DB).
//
// The same "range to a YYYY-MM-DD lower bound" mapping is used by the market
// cache, the portfolio series query, and the demo benchmark branch. This is the
// canonical copy for new callers; older inline copies (cache.ts, series.ts)
// predate it and stay as-is to avoid churning owner-mode behaviour.

import type { SeriesRange } from "./providers/types";

const RANGE_DAYS: Record<SeriesRange, number> = {
  "1mo": 31,
  "3mo": 92,
  "6mo": 183,
  "1y": 366,
  "5y": 5 * 366,
  max: 365 * 50,
};

/** ISO YYYY-MM-DD lower bound for `range`, counted back from today (UTC). */
export function benchmarkRangeStart(range: SeriesRange): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - RANGE_DAYS[range]);
  return d.toISOString().slice(0, 10);
}
