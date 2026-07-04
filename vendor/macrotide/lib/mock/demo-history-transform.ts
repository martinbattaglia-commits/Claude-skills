// Pure, deterministic transforms that turn a real index series into a
// realistic per-holding NAV history for DEMO MODE.
//
// No DB, no network, no Math.random / Date.now — everything here is a pure
// function of its inputs so the generated fixture (lib/mock/demo-history.ts) is
// reproducible and the read path that consumes it is testable. The actual real
// index pull lives in scripts/refresh-demo-history.ts; this module is shared by
// that script (at generation time) and the unit tests.
//
// Why a transform at all: the demo holdings are Thai mutual funds (brand /
// personal-data reasons forbid committing their real NAVs), so we synthesise
// each fund's history from a PUBLIC index it tracks, then make it *trail* that
// index slightly — applying the fund's TER as a compounding fee drag plus a
// small deterministic tracking wobble. The blended portfolio then visibly
// diverges from any single benchmark, which is the whole point of the overlay.

/** A single (date, value) point. `date` is ISO YYYY-MM-DD. */
export interface HistoryPoint {
  date: string;
  value: number;
}

/**
 * Variable-resolution downsample of a daily (date, value) series:
 *   - DAILY for the most recent `dailyDays` calendar days (covers 1M/3M/6M/1Y
 *     crisply — real weekend/holiday gaps are kept as-is), and
 *   - WEEKLY before that (keeping the last observation per ISO week), since at
 *     full "All" zoom the far-back density is visually irrelevant.
 *
 * This is the size/quality tradeoff that keeps the committed fixture small while
 * every UI range stays dense. Input may be in any date order; output is
 * ascending by date and de-duplicated. `maxDays` caps the total span (e.g.
 * 5 * 366 ≈ 5 years) before bucketing.
 */
export function downsampleVariable(
  daily: { date: string; value: number }[],
  opts: { maxDays: number; dailyDays: number },
): HistoryPoint[] {
  if (daily.length === 0) return [];
  const sorted = [...daily].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Span cap: drop points older than maxDays before the latest observation.
  const latest = new Date(`${sorted[sorted.length - 1].date}T00:00:00Z`);
  const spanCut = new Date(latest);
  spanCut.setUTCDate(spanCut.getUTCDate() - opts.maxDays);
  const spanCutIso = spanCut.toISOString().slice(0, 10);

  // Daily window boundary: keep every trading day on/after this date.
  const dailyCut = new Date(latest);
  dailyCut.setUTCDate(dailyCut.getUTCDate() - opts.dailyDays);
  const dailyCutIso = dailyCut.toISOString().slice(0, 10);

  const recent = sorted.filter((p) => p.date >= dailyCutIso && p.date >= spanCutIso);
  const older = sorted.filter((p) => p.date < dailyCutIso && p.date >= spanCutIso);

  // Weekly bucket for the older portion: keep the last point per ISO week.
  const byWeek = new Map<string, { date: string; value: number }>();
  for (const p of older) byWeek.set(isoWeekKey(p.date), p);
  const weekly = Array.from(byWeek.values());

  const merged = [...weekly, ...recent]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((p) => ({ date: p.date, value: p.value }));

  // De-dup any date that survived in both halves (boundary day).
  const out: HistoryPoint[] = [];
  let prevDate = "";
  for (const p of merged) {
    if (p.date === prevDate) out[out.length - 1] = p;
    else out.push(p);
    prevDate = p.date;
  }
  return out;
}

/** ISO `YYYY-Www` key for weekly bucketing. */
function isoWeekKey(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  // ISO week: Thursday-anchored.
  const day = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((d.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Deterministic, bounded tracking wobble in the range (-amp, +amp). Seeded only
 * by the holding key + the point index, so the same fixture regenerates
 * identically and two funds tracking the same index still diverge from each
 * other. A cheap hash → fractional sine; no RNG, no time.
 */
export function trackingWobble(seedKey: string, index: number, amp: number): number {
  let h = 2166136261 >>> 0; // FNV-1a over the key
  for (let i = 0; i < seedKey.length; i++) {
    h ^= seedKey.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // Mix the point index in so each point differs but stays a pure function.
  const x = Math.sin((h % 1000) + index * (1 + (h % 7) * 0.13));
  return x * amp;
}

/**
 * Transform a real index series (daily or mixed daily/weekly resolution) into a
 * holding's NAV series.
 *
 * Steps, in order:
 *   1. Rebase the index to a growth multiplier off its first point (so absolute
 *      index level / currency is irrelevant — only relative performance maps in).
 *   2. Apply the fund's TER as a COMPOUNDING fee drag, computed over ELAPSED TIME
 *      (years since the first point), not step count — so the drag is correct
 *      whether points are spaced daily or weekly: factor = (1 - ter)^yearsElapsed.
 *      A higher-fee fund trails its index more over time.
 *   3. Add a small deterministic tracking wobble (active funds wobble more than
 *      index funds — caller passes the amplitude), keyed on the point index.
 *   4. SCALE the whole series so its LAST point equals `currentValue` (the
 *      holding's seeded present value), making the demo chart end exactly where
 *      the seeded portfolio says it is.
 *
 * Result values are integer THB (demo funds are THB; no FX is applied here).
 */
export function buildHoldingSeries(opts: {
  /** Stable key, e.g. `${quoteSource}:${ticker}` — seeds the wobble. */
  seedKey: string;
  /** Real index series (ascending by date; daily or daily+weekly). */
  index: HistoryPoint[];
  /** Annual total expense ratio as a PERCENT (e.g. 1.4 for 1.40%). */
  terPct: number;
  /** The holding's seeded current value; the last output point equals this. */
  currentValue: number;
  /** Tracking-wobble amplitude (fraction, e.g. 0.01 = ±1%). */
  wobbleAmp: number;
}): HistoryPoint[] {
  const { seedKey, index, terPct, currentValue, wobbleAmp } = opts;
  if (index.length === 0) return [];
  const base = index[0].value;
  if (!base) return [];

  const t0 = Date.parse(`${index[0].date}T00:00:00Z`);
  const terFrac = terPct / 100;

  // Pre-scale series (growth multiplier × time-based fee drag × wobble), then
  // normalise so the last point becomes `currentValue`.
  const raw = index.map((p, k) => {
    const growth = p.value / base;
    const yearsElapsed = (Date.parse(`${p.date}T00:00:00Z`) - t0) / (365.25 * 86400_000);
    const feeFactor = (1 - terFrac) ** yearsElapsed;
    const wobble = 1 + trackingWobble(seedKey, k, wobbleAmp);
    return Math.max(growth * feeFactor * wobble, 1e-9);
  });

  const last = raw[raw.length - 1];
  const scale = currentValue / last;
  return index.map((p, k) => ({
    date: p.date,
    value: Math.round(raw[k] * scale),
  }));
}
