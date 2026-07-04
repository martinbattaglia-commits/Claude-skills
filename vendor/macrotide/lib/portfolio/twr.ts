// Time-Weighted Return (#236) — pure, the period pill's performance number.
//
// The pill answers "how did this window perform", independent of when money was
// added. A single-snapshot `gain ÷ base` can't: a big deposit mid-window lands
// in the wealth but not the gain, so dividing by the tiny start wealth blows the
// % up (start ฿11k, +฿800k mid, +฿8k gain → 73% instead of ~1%). TWR fixes it by
// chaining DAILY returns, each measured on the wealth held that day, so a flow
// just rebases the next day rather than inflating the whole window.
//
// EXTERNAL vs INTERNAL is already classified for us: `netInvested` (cumulative
// contributions) moves ONLY on external flows — cash deposit/withdraw, a
// Set-balance delta, a buy's un-funded shortfall. Internal moves (buy/sell funds,
// cash↔fund) leave total wealth unchanged and never touch it. So the day-over-day
// change in `netInvested` IS the external flow to strip out.

import type { SeriesPoint } from "@/lib/static/types";

/**
 * Daily-linked Time-Weighted Return over `series` (the value line), netting out
 * external flows read from `netInvested` (the cumulative-contribution line). Both
 * share the server's daily timeline; flows are looked up by date so a misalignment
 * can't manufacture a phantom flow. Returns the chained return as a percent, or
 * `null` when there's nothing to compute (< 2 finite points, or no sub-period ever
 * linked — e.g. a book that's empty until its final inflow).
 *
 * Day `i` return = `(Vᵢ − Fᵢ) / Vᵢ₋₁`, where `Fᵢ` is the external flow since the
 * previous day (end-of-day-flow convention — negligible at daily granularity, when
 * a deposit and its later growth fall on separate days). When `Vᵢ₋₁ ≤ 0` (book
 * empty before the first inflow, or fully divested) the ratio is undefined: that
 * step doesn't link, and the post-flow value starts a fresh sub-period base.
 */
export function periodTwr(series: SeriesPoint[], netInvested: SeriesPoint[]): number | null {
  const finite = series.filter((p) => Number.isFinite(p.v));
  if (finite.length < 2) return null;

  const contribByDate = new Map(netInvested.map((p) => [p.d, p.v]));

  let growth = 1; // ∏(1 + rᵢ)
  let linked = false; // did any valid sub-period contribute a return?
  let prevV: number | null = null;
  let prevContrib = 0;

  for (const { d, v } of finite) {
    // No contribution point for this date → cumulative unchanged since the last,
    // so the flow is zero (carry forward, never default to 0 mid-stream).
    const contrib = contribByDate.get(d) ?? prevContrib;
    if (prevV === null) {
      // First point sets the opening base; its contribution is pre-window wealth,
      // not a flow, so it never enters the chain.
      prevV = v;
      prevContrib = contrib;
      continue;
    }
    if (prevV > 0) {
      const flow = contrib - prevContrib;
      growth *= (v - flow) / prevV;
      linked = true;
    }
    // prevV ≤ 0: undefined ratio — skip linking; `v` (post-flow) becomes the base.
    prevV = v;
    prevContrib = contrib;
  }

  return linked ? (growth - 1) * 100 : null;
}

/**
 * Running Time-Weighted Return as a dated curve — the Performance mode's line.
 * Same daily flow-netting as {@link periodTwr}, but instead of collapsing to the
 * final scalar it emits the cumulative growth factor at every date.
 *
 * `v` is the **growth factor** ∏(1 + rᵢ), starting at `1` on the first point and
 * always positive — so the line is valid on a log axis, and the caller renders it
 * as a percent via `(v − 1) × 100` (the endpoint then equals {@link periodTwr}).
 * Keeping one positive series for both linear and log honours "scale ⊥ framing":
 * linear and log are two drawings of the same curve, not two different curves.
 *
 * A day with `prevV ≤ 0` doesn't link (its post-flow value reopens the base), so
 * the factor carries flat across an empty/fully-divested stretch. Returns `[]`
 * when there are fewer than 2 finite points.
 */
export function twrSeries(series: SeriesPoint[], netInvested: SeriesPoint[]): SeriesPoint[] {
  const finite = series.filter((p) => Number.isFinite(p.v));
  if (finite.length < 2) return [];

  const contribByDate = new Map(netInvested.map((p) => [p.d, p.v]));

  const out: SeriesPoint[] = [];
  let growth = 1;
  let prevV: number | null = null;
  let prevContrib = 0;

  for (const { d, v } of finite) {
    const contrib = contribByDate.get(d) ?? prevContrib;
    if (prevV === null) {
      prevV = v;
      prevContrib = contrib;
      out.push({ d, v: 1 });
      continue;
    }
    if (prevV > 0) {
      const flow = contrib - prevContrib;
      growth *= (v - flow) / prevV;
    }
    prevV = v;
    prevContrib = contrib;
    out.push({ d, v: growth });
  }

  return out;
}
