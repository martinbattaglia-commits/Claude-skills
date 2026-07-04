import type { SeriesPoint } from "@/lib/static/types";

// Pure, DB/network-free chart helper: align a benchmark series onto a
// portfolio's date labels and rebase it so both lines start from the same base.
//
// TH and US trading calendars rarely produce equal-length series, so a
// `length === length` gate silently dropped the benchmark whenever they
// differed (almost always). Instead we intersect by date: forward-fill the
// benchmark across the portfolio's points, find the FIRST date where both have
// a value (the common anchor), and rebase the benchmark to the portfolio's
// value on that date. The benchmark then shares the portfolio's scale and
// renders whenever any overlap exists.

/** A benchmark point whose value may be absent before the first common date. */
export interface RebasedPoint {
  d: string;
  /** Rebased value; `null` before the first overlapping date. */
  v: number | null;
}

/** Benchmark forward-filled onto the portfolio's dates, plus the anchor index. */
interface AlignedBenchmark {
  /** One value per portfolio point: forward-filled benchmark price, `null` before its first point. */
  aligned: (number | null)[];
  /** Index of the first portfolio point that has a benchmark value (the common anchor). */
  anchor: number;
}

/**
 * Align a benchmark series onto a portfolio's date labels by intersecting on
 * dates: forward-fill the benchmark across the portfolio's points and find the
 * FIRST date both cover. TH and US trading calendars rarely produce equal-length
 * series, so a `length === length` gate would silently drop the benchmark whenever
 * they differed (almost always); intersecting renders it whenever any overlap
 * exists. Shared by both rebasers so their alignment can't drift apart.
 *
 * Returns `null` when there's nothing to align (no portfolio points, empty
 * benchmark, or no overlapping date).
 */
function alignBenchmark(
  portfolio: SeriesPoint[],
  benchmark: SeriesPoint[] | null | undefined,
): AlignedBenchmark | null {
  if (!portfolio || portfolio.length === 0) return null;
  if (!benchmark || benchmark.length === 0) return null;

  const byLabel = new Map(benchmark.map((b) => [b.d, b.v]));
  let lastBench: number | null = null;
  const aligned = portfolio.map((p) => {
    const bv = byLabel.get(p.d);
    if (bv !== undefined) lastBench = bv;
    return lastBench;
  });

  const anchor = aligned.findIndex((b) => b != null);
  if (anchor < 0) return null;
  return { aligned, anchor };
}

/**
 * Rebase `benchmark` onto `portfolio`'s date space. Returns one point per
 * portfolio point (so the two arrays index-align for plotting):
 * - at/after the first common date, the rebased benchmark value;
 * - before it (no benchmark data yet), `null` — callers either render a gap
 *   (recharts) or hold the value flat at the rebased start (SVG).
 *
 * This is the LUMP-SUM view: it models putting the portfolio's value at the
 * anchor into the benchmark once and holding. For the contribution-matched view
 * used by the portfolio wealth chart, see `rebaseBenchmarkContrib`.
 *
 * Returns `null` when there's nothing to draw (no portfolio points, empty
 * benchmark, no overlapping date, or a zero base).
 */
export function rebaseBenchmark(
  portfolio: SeriesPoint[],
  benchmark: SeriesPoint[] | null | undefined,
): RebasedPoint[] | null {
  const a = alignBenchmark(portfolio, benchmark);
  if (!a) return null;
  const { aligned, anchor } = a;

  const portfolioStart = portfolio[anchor].v;
  const benchStart = aligned[anchor] as number;
  if (!benchStart) return null;

  return portfolio.map((p, i) => ({
    d: p.d,
    v: aligned[i] != null ? ((aligned[i] as number) / benchStart) * portfolioStart : null,
  }));
}

/**
 * Contribution-matched (money-weighted) rebase: instead of one lump held from
 * the anchor, simulate investing the SAME external cash flows into the benchmark
 * on the same dates. The portfolio's value at the anchor is the starting lump;
 * each later contribution buys benchmark units at that date's price (a withdrawal
 * sells units, naturally proportional since it's priced at the same date). The
 * line then answers "what if I'd put the same money into the index at the same
 * times" — so adding money no longer makes the benchmark look flat by comparison.
 *
 * `contribDeltas` maps a portfolio date label → the signed change in cumulative
 * net invested on that date (> 0 deposit, < 0 withdrawal). Deltas at or before
 * the anchor are ignored: the anchor lump (the portfolio value on that date)
 * already reflects every prior contribution. With an empty/all-zero map this is
 * identical to `rebaseBenchmark`.
 *
 * Returns one point per portfolio point on the same ABSOLUTE scale as
 * `rebaseBenchmark` (so the chart's windowing shift is unchanged); `null` before
 * the anchor. Returns `null` when there's nothing to draw or the anchor price is
 * zero.
 */
export function rebaseBenchmarkContrib(
  portfolio: SeriesPoint[],
  benchmark: SeriesPoint[] | null | undefined,
  contribDeltas: ReadonlyMap<string, number>,
): RebasedPoint[] | null {
  const a = alignBenchmark(portfolio, benchmark);
  if (!a) return null;
  const { aligned, anchor } = a;

  const anchorPrice = aligned[anchor] as number;
  if (!anchorPrice) return null;

  // Starting lump: the portfolio's value at the anchor, bought at the anchor price.
  let units = portfolio[anchor].v / anchorPrice;

  const out: RebasedPoint[] = [];
  for (let i = 0; i < portfolio.length; i++) {
    const p = portfolio[i];
    const price = aligned[i];
    if (i < anchor || price == null) {
      out.push({ d: p.d, v: null });
      continue;
    }
    // Apply this date's external flow at its own price (the anchor's lump is
    // already in `units`). A zero price can't price new units — skip the flow.
    if (i > anchor && price > 0) {
      const delta = contribDeltas.get(p.d);
      if (delta) units += delta / price;
    }
    out.push({ d: p.d, v: units * price });
  }
  return out;
}
