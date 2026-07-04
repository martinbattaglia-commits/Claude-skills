"use client";

// Interactive charts (recharts) — hover + tooltips, styled to the app's CSS
// variables. recharts must run client-side, hence the directive. Tiny inline
// sparklines stay hand-drawn SVG in components/charts.tsx; these are the
// charts where hovering to read an exact value is genuinely useful.

import { useId } from "react";
import {
  Area,
  Bar,
  BarChart,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtTHBClean, fmtTHBSigned } from "@/lib/format";
import {
  formatDay,
  formatMonthYear,
  formatTooltipDate,
  NAV_CHART_HEIGHT,
  pickAxisTicks,
} from "@/lib/portfolio/adapter";
import { isFullyOut } from "@/lib/portfolio/chart-scale";
import type { AllocationSlice, SleeveDrift } from "@/lib/portfolio/health";
import { rebaseBenchmark, rebaseBenchmarkContrib } from "@/lib/portfolio/rebase";
import type { SeriesPoint } from "@/lib/static/types";

const TOOLTIP_STYLE: React.CSSProperties = {
  background: "var(--card-soft)",
  border: "1px solid var(--line)",
  borderRadius: 8,
  padding: "7px 10px",
  fontSize: 12,
  boxShadow: "0 4px 14px rgba(0,0,0,0.12)",
  // Cap the width so a long line (e.g. a drift row, or a "฿X · +Y%" value) wraps
  // instead of running off the chart and past the container on a narrow phone.
  // whiteSpace override is needed because recharts' built-in tooltip defaults its
  // content to `nowrap`, which would otherwise defeat the maxWidth and clip.
  maxWidth: "min(260px, 78vw)",
  whiteSpace: "normal",
};
const TOOLTIP_LABEL: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.04em",
  color: "var(--muted)",
  marginBottom: 4,
};

// Grouped x-axis tick: the first tick of each month renders a brighter
// "MMM 'yy"; in-between ticks render just a muted day number — so multi-month /
// multi-year ranges stay readable without repeating the year on every label.
// Ticks are inset from the edges (see pickAxisTicks), so all anchor "middle"
// with even gaps and nothing clips. `ticks` is the full ordered list (so we can
// compare against the previous tick for month grouping); recharts supplies
// `index` as the position within it.
function AxisTick({
  x,
  y,
  payload,
  index = 0,
  ticks,
}: {
  x?: number | string;
  y?: number | string;
  payload?: { value?: string | number };
  index?: number;
  ticks: string[];
}) {
  if (x == null || y == null || payload?.value == null) return null;
  const iso = String(payload.value);
  const isMonthStart = index === 0 || iso.slice(0, 7) !== ticks[index - 1]?.slice(0, 7);
  return (
    <text
      x={Number(x)}
      y={Number(y)}
      dy={9}
      textAnchor="middle"
      fontSize={10}
      fontFamily="var(--font-mono)"
      fill="var(--muted)"
      opacity={isMonthStart ? 1 : 0.55}
    >
      {isMonthStart ? formatMonthYear(iso) : formatDay(iso)}
    </text>
  );
}

// Reserved height for the x-axis band. recharts hands the tick a `y` already
// offset ~6px below the axis line, then our label adds dy=9 + descent, so the
// band must cover ~21px or the date clips at the SVG edge. 22 trims the old 30px
// default (the plot gains the difference) while keeping a small margin. Both
// NavChart return paths share it, and the two-line label/dot geometry derives the
// plot bottom from it.
const NAV_AXIS_H = 22;

function EmptyState({
  height,
  title = "NO HISTORY YET",
  emptyHint,
}: {
  height: number;
  title?: string;
  emptyHint?: string | null;
}) {
  return (
    <div
      style={{
        width: "100%",
        height,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        alignItems: "center",
        justifyContent: "center",
        color: "var(--muted)",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 12, fontFamily: "var(--font-mono)", letterSpacing: "0.04em" }}>
        {title}
      </div>
      {emptyHint && <div style={{ fontSize: 11, maxWidth: 320, lineHeight: 1.5 }}>{emptyHint}</div>}
    </div>
  );
}

// ===== NAV / performance chart (interactive line + optional benchmark) =====

interface TwoLinePoint {
  d: string;
  // null on a fully-out-of-market date (value ~฿0): every plotted field breaks so
  // the line + wedge gap there, keeping a log axis valid (see lib/portfolio/chart-scale).
  v: number | null;
  inv: number | null;
  bench: number | null;
  cash: number;
  lower: number | null;
  gainUp: number | null;
  gainDown: number | null;
  // Range-area bands for the LOG wedge: filled between the two values so they map
  // through the (log) y-scale directly — unlike the additive stacked wedge above,
  // which only composes in linear pixel space. gBand tints value-above-invested
  // (gain), rBand tints underwater (loss); the off-side band is zero-height.
  gBand: [number, number] | null;
  rBand: [number, number] | null;
}

export function NavChart({
  data,
  height = NAV_CHART_HEIGHT,
  accent = "var(--accent)",
  benchmarkData = null,
  benchmarkLabel = null,
  emptyHint = null,
  emptyTitle = "NO HISTORY YET",
  valueFormatter = fmtTHBClean,
  seriesLabel = "Portfolio",
  showReturnInTooltip = false,
  investedData = null,
  cashData = null,
  valuesHidden = false,
  baselineValue = 0,
  baselineInvested = 0,
  scaleMode = "linear",
  baselineRef = null,
}: {
  data: SeriesPoint[];
  height?: number;
  accent?: string;
  benchmarkData?: SeriesPoint[] | null;
  benchmarkLabel?: string | null;
  emptyHint?: string | null;
  /** Empty-state headline. Defaults to "NO HISTORY YET"; pass "NO HOLDINGS YET"
   *  when the portfolio is empty so the headline matches the "Add holdings" hint. */
  emptyTitle?: string;
  /** Formats the main line's value in the tooltip. Defaults to whole-baht. */
  valueFormatter?: (n: number) => string;
  /** Tooltip label for the main series. Defaults to "Portfolio". */
  seriesLabel?: string;
  /**
   * Append the cumulative % change since the window's first point to the main
   * series' tooltip — so a single line reads as both an absolute value and a
   * return (the two are the same curve, just rescaled). Off for the portfolio.
   */
  showReturnInTooltip?: boolean;
  /**
   * Cumulative net-invested series on the same dates as `data`. When given the
   * chart renders the two-line wealth view: value line + a muted contribution
   * line, with the gap tinted as gain (accent) or loss. Dashed stroke stays
   * reserved for the benchmark overlay.
   */
  investedData?: SeriesPoint[] | null;
  /** In-transit settlement cash per date — disclosed in the tooltip when > 0. */
  cashData?: SeriesPoint[] | null;
  /** Privacy toggle: mask every ฿ figure in the tooltip (gain % stays). */
  valuesHidden?: boolean;
  /**
   * Window rebase: subtract these from value/benchmark and net-invested so a
   * clipped range answers "how did I do this period" from 0. The benchmark is
   * rebased onto the ABSOLUTE series first, then shifted by the same baseline,
   * so both treatments stay coherent. 0 = absolute (the lifetime story).
   */
  baselineValue?: number;
  baselineInvested?: number;
  /**
   * Y-axis transform. "log" draws the value line on a ratio (log10) axis so equal
   * % moves take equal height — only valid when every plotted value is positive,
   * so the caller passes it on absolute (un-rebased) wealth and the chart falls
   * back to linear if any point is ≤ 0. Scale changes only HOW the series is
   * drawn, never what it means (framing ⊥ scale).
   */
  scaleMode?: "linear" | "log";
  /**
   * Single-series sign reference (Return mode passes 1 = the 0%-return growth
   * factor). When set, the area fills green above it / red below, and the line
   * takes the gain/loss color of the latest point. Absent for absolute-value
   * single-series charts (fund price, cash balance), which keep the plain fill.
   */
  baselineRef?: number | null;
}) {
  const gradId = `nav-grad-${useId().replace(/:/g, "")}`;

  if (!data || data.length === 0) {
    return <EmptyState height={height} title={emptyTitle} emptyHint={emptyHint} />;
  }

  // First finite value, for the "% since start" reading in the tooltip.
  const baseline = data.find((d) => Number.isFinite(d.v))?.v;

  // Overlay the benchmark aligned to the portfolio's own date labels, then
  // rebase it onto the portfolio's value at their first common date so both
  // lines share a scale. Tolerant of different lengths / non-overlapping trading
  // days (an exact-length check would drop the line whenever the two series
  // differed, which is almost always). This LUMP-SUM rebase drives the single-line
  // view below (and PerfChart); the wealth view overrides it with a
  // contribution-matched series — see there.
  const rebased = rebaseBenchmark(data, benchmarkData);
  const benchByLabel = rebased ? new Map(rebased.map((b) => [b.d, b.v])) : null;

  // ── Two-line wealth view (value + net invested + signed gain wedge) ──
  if (investedData && investedData.length > 0) {
    const investedByLabel = new Map(investedData.map((p) => [p.d, p.v]));
    const cashByLabel = cashData ? new Map(cashData.map((p) => [p.d, p.v])) : null;
    const windowed = baselineValue !== 0 || baselineInvested !== 0;

    // Contribution-matched benchmark: instead of a single lump held from the
    // window start, mirror the user's own cash flows into the index. The per-date
    // deltas are the change in the cumulative net-invested line we already plot
    // (`investedData`), so the benchmark tracks the exact "Net invested" curve
    // shown here — adding money no longer makes the benchmark look flat.
    const contribDeltas = new Map<string, number>();
    let prevInv: number | null = null;
    for (const p of investedData) {
      if (prevInv !== null) contribDeltas.set(p.d, p.v - prevInv);
      prevInv = p.v;
    }
    const matched = rebaseBenchmarkContrib(data, benchmarkData, contribDeltas);
    const benchMatchedByLabel = matched ? new Map(matched.map((b) => [b.d, b.v])) : null;

    // Domain stats, accumulated over PLOTTED (non-gap) points only — `vMin`/`vMax`
    // for the value line (and the log-axis floor), `yMin`/`yMax` across both lines
    // + the wedge for the linear domain.
    let yMin = Number.POSITIVE_INFINITY;
    let yMax = Number.NEGATIVE_INFINITY;
    let vMin = Number.POSITIVE_INFINITY;
    let vMax = Number.NEGATIVE_INFINITY;
    const merged: TwoLinePoint[] = data.map((p) => {
      // Fully out of the market (value ~฿0) → emit a gap so the line + wedge break
      // here on BOTH scales: a log axis can't place a 0, and a break honestly reads
      // as "not invested" rather than "held ฿0 of funds".
      if (isFullyOut(p.v)) {
        return {
          d: p.d,
          v: null,
          inv: null,
          bench: null,
          cash: 0,
          lower: null,
          gainUp: null,
          gainDown: null,
          gBand: null,
          rBand: null,
        };
      }
      const v = p.v - baselineValue;
      const rawBench = benchMatchedByLabel?.get(p.d);
      const inv = (investedByLabel.get(p.d) ?? baselineInvested) - baselineInvested;
      const gain = v - inv;
      const bench = rawBench == null ? null : rawBench - baselineValue;
      const lower = Math.min(v, inv);
      vMin = Math.min(vMin, v);
      vMax = Math.max(vMax, v);
      yMin = Math.min(yMin, lower, bench ?? lower);
      yMax = Math.max(yMax, v, inv, bench ?? v);
      return {
        d: p.d,
        v,
        inv,
        bench,
        cash: cashByLabel?.get(p.d) ?? 0,
        // The gain wedge as stacked areas: an invisible base up to the lower
        // line, then the |gap| tinted by sign — green above the invested line,
        // loss-red when the value dips underwater.
        lower,
        gainUp: Math.max(0, gain),
        gainDown: Math.max(0, -gain),
        // Same wedge for the log axis, expressed as value-pair bands (see type).
        gBand: [inv, Math.max(v, inv)],
        rBand: [Math.min(v, inv), inv],
      };
    });
    const axisTicks = pickAxisTicks(merged);

    // Y domain (`yMin`/`yMax`) and the value-line range (`vMin`/`vMax`) are computed
    // in the map above, over plotted points only — the wedge's stacked helper series
    // carry small gap-sized values that would otherwise drag the auto-domain toward 0.

    const renderTooltip = (props: {
      active?: boolean;
      label?: string | number;
      payload?: readonly { payload?: TwoLinePoint }[];
    }) => {
      if (!props.active || !props.payload?.[0]?.payload) return null;
      const p = props.payload[0].payload;
      // A gap point (fully out of the market) has no value to report.
      if (p.v == null || p.inv == null) return null;
      const gain = p.v - p.inv;
      // Windowed: gain relative to the wealth you started the window with.
      // Absolute: gain relative to everything you've put in.
      const denom = windowed ? baselineValue : p.inv;
      const pct = denom > 0 ? (gain / denom) * 100 : null;
      // The benchmark is contribution-matched, so its line carries the same
      // contributions as the portfolio — comparing GAIN (value − net invested),
      // not raw value, is the like-for-like read (a contribution lifts both lines
      // equally and must not look like benchmark outperformance). Same formula as
      // the portfolio's Gain above.
      const benchGain = p.bench == null ? null : p.bench - p.inv;
      const benchPct = benchGain != null && denom > 0 ? (benchGain / denom) * 100 : null;
      const row = (label: string, text: string, color = "var(--ink)") => (
        <div style={{ display: "flex", gap: 10, justifyContent: "space-between" }}>
          <span style={{ color: "var(--muted)" }}>{label}</span>
          <span style={{ color, fontVariantNumeric: "tabular-nums" }}>{text}</span>
        </div>
      );
      // A signed ฿ with the % after a middot — "฿X · +Y%" — matching the hero
      // scorecard. Under the privacy toggle the ฿ is masked, leaving just the %.
      const gainText = (amount: number, percent: number | null) => {
        const pctStr = percent === null ? null : `${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%`;
        if (valuesHidden) return pctStr ?? "—";
        const amtStr = fmtTHBSigned(amount);
        return pctStr === null ? amtStr : `${amtStr} · ${pctStr}`;
      };
      return (
        <div style={TOOLTIP_STYLE}>
          <div style={TOOLTIP_LABEL}>{formatTooltipDate(String(props.label ?? p.d))}</div>
          {!valuesHidden &&
            row(
              windowed ? "Change" : "Value",
              windowed ? fmtTHBSigned(p.v) : fmtTHBClean(p.v),
              accent,
            )}
          {!valuesHidden &&
            row("Net invested", windowed ? fmtTHBSigned(p.inv) : fmtTHBClean(p.inv))}
          {row("Gain", gainText(gain, pct), gain >= 0 ? "var(--gain)" : "var(--loss)")}
          {benchGain != null &&
            row(benchmarkLabel ?? "Benchmark", gainText(benchGain, benchPct), "var(--benchmark)")}
          {p.cash > 0 && !valuesHidden && (
            <div style={{ color: "var(--muted)", marginTop: 3, fontSize: 11 }}>
              incl. {fmtTHBClean(p.cash)} awaiting reinvestment
            </div>
          )}
        </div>
      );
    };

    const last = merged.at(-1);
    // The last point is never a gap in practice (you hold something now); default
    // to "above" if it somehow is, so the value line keeps its gain colour.
    const valueAbove = !last || last.v == null || last.inv == null || last.v >= last.inv;
    // The value line takes the gain/loss color of the CURRENT state (value vs
    // invested) — green in gain, red underwater — like the hero ▲/▼. A single
    // color (not segmented): the crossover with the sloped invested line happens
    // at varying heights, which a stroke gradient can't follow; the wedge area
    // already carries the per-segment sign.
    const valueLineColor = valueAbove ? accent : "var(--loss)";
    const n = merged.length;

    // Geometry of the plot area (top margin 10, x-axis band NAV_AXIS_H).
    const plotTop = 10;
    const plotH = height - plotTop - NAV_AXIS_H;
    const range = yMax - yMin;
    // Inset the y-domain by ~the active-dot radius (data units) so a line sitting
    // on the extreme — a flat cost-basis floor, or a ceiling — isn't flush with
    // the plot edge, where its hover dot would be clipped in half.
    const pad = range > 0 ? (5 / plotH) * range : Math.max(1, Math.abs(yMax) * 0.02);
    const domMin = yMin - pad;
    const domMax = yMax + pad;
    const yOf = (val: number) => plotTop + (domMax - val) * (plotH / (domMax - domMin));

    // Log scale: draw on a ratio axis so equal % moves take equal height. The
    // domain is clamped to the VALUE series (`vMin`/`vMax` from the map), and
    // fully-out ฿0 dates are already gapped, so `vMin` is the smallest REAL value
    // and stays positive; fall back to linear only if nothing positive plotted. The
    // signed gain wedge is rendered differently per scale (stacked areas on linear,
    // value-pair bands on log — see the Area block); the dotted net-invested line
    // and its end-label stay on both.
    const logScale = scaleMode === "log" && Number.isFinite(vMin) && vMin > 0;
    // Dot-radius pad for the LOG domain, in log space (a flat % pad clips the
    // active dot at the peak/floor) — mirrors `pad` for the linear domain below.
    const vLogSpan = logScale ? Math.log(vMax) - Math.log(vMin) : 0;
    const vLogK = plotH > 0 && vLogSpan > 0 ? Math.exp((5 / plotH) * vLogSpan) : 1.02;

    // The end-label hugs the invested line's last point and stays clear of the
    // line WITHIN THE LABEL'S OWN WIDTH — so a step-up under the text is avoided,
    // but one further left (where no text sits) is ignored. The clearance window
    // is the label's pixel width converted to data points, so it's the same
    // physical width at every range (not a fraction of the series). It also flips
    // to the side with room when the line is pinned to the floor or the ceiling.
    // SVG text grows UP from its baseline → a below-label needs more gap.
    const GAP_BELOW = 12;
    const GAP_ABOVE = 7;
    const LABEL_H = 9;
    const LABEL_W = 55; // ~ "INVESTED" at 9px mono + letter-spacing
    const BOTTOM_EDGE = height - NAV_AXIS_H;
    const investedEndLabel = (props: {
      x?: number | string;
      y?: number | string;
      index?: number;
    }) => {
      if (props.index !== n - 1 || props.x == null || props.y == null) return null;
      const lastX = Number(props.x);
      // px between category points → trailing points the label text spans.
      const pxPerPoint = n > 1 ? (lastX - 4) / (n - 1) : 0;
      const span = pxPerPoint > 0 ? Math.min(n, Math.max(2, Math.ceil(LABEL_W / pxPerPoint))) : n;
      // Clear against the INVESTED line only — the label belongs to it and must
      // hug it on whichever side, never jump across the wedge to the value line.
      const windowPts = merged.slice(n - span);
      // Trailing window is recent (never a gap), but filter nulls for safety.
      const invs = windowPts.map((p) => p.inv).filter((x): x is number => x != null);
      const invLow = invs.length ? Math.min(...invs) : 0;
      const invHigh = invs.length ? Math.max(...invs) : 0;
      const yBelow = yOf(invLow) + GAP_BELOW;
      const yAbove = yOf(invHigh) - GAP_ABOVE;
      // Prefer the side away from the value line; flip only if it spills past an edge.
      let below = valueAbove;
      const belowFits = yBelow <= BOTTOM_EDGE;
      const aboveFits = yAbove - LABEL_H >= plotTop;
      if (below && !belowFits && aboveFits) below = false;
      else if (!below && !aboveFits && belowFits) below = true;
      const y = Math.min(height - 4, Math.max(LABEL_H, below ? yBelow : yAbove));
      return (
        <text
          x={lastX - 4}
          y={y}
          textAnchor="end"
          fontSize={9}
          fontFamily="var(--font-mono)"
          letterSpacing="0.06em"
          fill="var(--muted-2)"
        >
          INVESTED
        </text>
      );
    };

    // Log variant: the linear placement above derives y from `yOf` (a linear
    // pixel map), which floats off the line on a log axis. Here we use the point's
    // ACTUAL rendered y (recharts hands it to the label callback under whichever
    // scale is active) and just offset to the side away from the value line.
    const investedEndLabelLog = (props: {
      x?: number | string;
      y?: number | string;
      index?: number;
    }) => {
      if (props.index !== n - 1 || props.x == null || props.y == null) return null;
      const lastX = Number(props.x);
      const lastY = Number(props.y);
      const y = Math.min(
        height - 4,
        Math.max(LABEL_H, valueAbove ? lastY + GAP_BELOW : lastY - GAP_ABOVE),
      );
      return (
        <text
          x={lastX - 4}
          y={y}
          textAnchor="end"
          fontSize={9}
          fontFamily="var(--font-mono)"
          letterSpacing="0.06em"
          fill="var(--muted-2)"
        >
          INVESTED
        </text>
      );
    };

    return (
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={merged} margin={{ top: 10, right: 6, bottom: 0, left: 4 }}>
          <XAxis
            dataKey="d"
            ticks={axisTicks}
            interval={0}
            height={NAV_AXIS_H}
            tickLine={false}
            axisLine={false}
            tick={(props) => <AxisTick {...props} ticks={axisTicks} />}
          />
          {/* allowDataOverflow honors this explicit domain — the wedge's stacked
              helper areas would otherwise drag the auto-domain down to the 0
              stack baseline and squash both lines into the top of the plot. */}
          {logScale ? (
            <YAxis hide scale="log" domain={[vMin / vLogK, vMax * vLogK]} allowDataOverflow />
          ) : (
            <YAxis hide domain={[domMin, domMax]} allowDataOverflow />
          )}
          <Tooltip cursor={{ stroke: "var(--line)", strokeWidth: 1 }} content={renderTooltip} />
          {/* Signed gain wedge between the two lines. Linear: an invisible base
              (lower) + the |gap| as a stacked area — composes only in linear pixel
              space. Log: the same wedge drawn as value-pair bands (gBand/rBand) so
              each edge maps through the log scale; here the gap's HEIGHT reads as
              the return ratio (log V − log I = log V/I), not baht. */}
          {logScale ? (
            <>
              <Area
                type="monotone"
                dataKey="gBand"
                stroke="none"
                fill={accent}
                fillOpacity={benchmarkData ? 0.07 : 0.16}
                isAnimationActive={false}
                tooltipType="none"
                activeDot={false}
              />
              <Area
                type="monotone"
                dataKey="rBand"
                stroke="none"
                fill="var(--loss)"
                fillOpacity={benchmarkData ? 0.06 : 0.14}
                isAnimationActive={false}
                tooltipType="none"
                activeDot={false}
              />
            </>
          ) : (
            <>
              <Area
                type="monotone"
                dataKey="lower"
                stackId="up"
                stroke="none"
                fill="transparent"
                isAnimationActive={false}
                tooltipType="none"
                activeDot={false}
              />
              <Area
                type="monotone"
                dataKey="gainUp"
                stackId="up"
                stroke="none"
                fill={accent}
                fillOpacity={benchmarkData ? 0.07 : 0.16}
                isAnimationActive={false}
                tooltipType="none"
                activeDot={false}
              />
              <Area
                type="monotone"
                dataKey="lower"
                stackId="down"
                stroke="none"
                fill="transparent"
                isAnimationActive={false}
                tooltipType="none"
                activeDot={false}
              />
              <Area
                type="monotone"
                dataKey="gainDown"
                stackId="down"
                stroke="none"
                fill="var(--loss)"
                fillOpacity={benchmarkData ? 0.06 : 0.14}
                isAnimationActive={false}
                tooltipType="none"
                activeDot={false}
              />
            </>
          )}
          <Line
            type="monotone"
            dataKey="v"
            stroke={valueLineColor}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: valueLineColor }}
            isAnimationActive={false}
          />
          {/* Contribution line: thin, faint (muted-2), and DOTTED so it reads as
              a quiet reference baseline — distinct from the value line (solid)
              and the benchmark (dashed). */}
          <Line
            type="monotone"
            dataKey="inv"
            stroke="var(--muted-2)"
            strokeWidth={1.25}
            strokeDasharray="1 4"
            strokeLinecap="round"
            dot={false}
            activeDot={{ r: 3, fill: "var(--muted-2)" }}
            isAnimationActive={false}
            label={logScale ? investedEndLabelLog : investedEndLabel}
          />
          {benchmarkData && (
            <Line
              type="monotone"
              dataKey="bench"
              stroke="var(--benchmark)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              activeDot={{ r: 3.5, fill: "var(--benchmark)" }}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    );
  }

  // Sign-aware fill (Return mode): green above the 0%-return reference, red below.
  // `baselineRef` is the growth factor at 0% (1.0); absent for absolute-value
  // single-series charts (fund price, cash balance), which keep the plain fill.
  const signed = baselineRef != null;
  const sBase = baselineRef ?? 0;
  const merged = data.map((d) => ({ d: d.d, v: d.v, bench: benchByLabel?.get(d.d) ?? null }));
  const axisTicks = pickAxisTicks(merged);
  // Log on the single-series (Performance) view: the line is a growth factor (or
  // an absolute value), always positive, so a log axis is valid; fall back to
  // linear if anything is ≤ 0. The benchmark, rebased onto the same series above,
  // shares the scale.
  let sMin = Number.POSITIVE_INFINITY;
  let lineMin = Number.POSITIVE_INFINITY;
  let lineMax = Number.NEGATIVE_INFINITY;
  for (const p of merged) {
    if (p.v < sMin) sMin = p.v;
    if (p.bench != null && p.bench < sMin) sMin = p.bench;
    lineMin = Math.min(lineMin, p.v, p.bench ?? p.v);
    lineMax = Math.max(lineMax, p.v, p.bench ?? p.v);
  }
  const logScaleSingle = scaleMode === "log" && Number.isFinite(sMin) && sMin > 0;
  // Whole-line color by the CURRENT gain/loss (latest point vs the reference) —
  // green in gain, red at a loss, matching the hero ▲/▼.
  const singleCurrentlyUp = (merged.at(-1)?.v ?? sBase) >= sBase;
  const singleLineColor = signed && !singleCurrentlyUp ? "var(--loss)" : accent;
  // Inset the domain by ~the active-dot radius (in data units) so a dot sitting on
  // the extreme isn't clipped in half at the plot edge.
  const sPlotH = height - 10 - NAV_AXIS_H;
  const sPad = sPlotH > 0 && lineMax > lineMin ? (5 / sPlotH) * (lineMax - lineMin) : 0;
  // Log: pad by the dot radius IN LOG SPACE (a flat % pad is too small near the
  // extremes, clipping the active dot at the peak/floor in half). A factor that
  // maps ~5px through the log scale; falls back to a small factor on a flat line.
  const sLogSpan = lineMin > 0 ? Math.log(lineMax) - Math.log(lineMin) : 0;
  const sLogK = sPlotH > 0 && sLogSpan > 0 ? Math.exp((5 / sPlotH) * sLogSpan) : 1.02;
  const sDomMin = logScaleSingle ? lineMin / sLogK : lineMin - sPad;
  const sDomMax = logScaleSingle ? lineMax * sLogK : lineMax + sPad;
  // One continuous area from the line to a baseline clamped INTO the visible domain
  // (so the gradient maps to what's on screen, and crossovers taper with no gap).
  // `zeroFrac` = where 0% sits in the area's bounding box (0 = top, 1 = bottom;
  // log-space on a log axis). The fill is solid from the line, fades over the SPAN
  // fraction of the band nearest 0%, hits fully transparent AT 0%, and flips
  // green→red there.
  const fAt = (val: number) => (logScaleSingle ? Math.log(val) : val);
  const SPAN = 0.5;
  const signedBase = signed ? Math.min(sDomMax, Math.max(sDomMin, sBase)) : sBase;
  const bboxTop = Math.max(lineMax, signedBase);
  const bboxBottom = Math.min(lineMin, signedBase);
  const zeroFrac =
    signed && fAt(bboxTop) > fAt(bboxBottom)
      ? Math.min(1, Math.max(0, (fAt(bboxTop) - fAt(sBase)) / (fAt(bboxTop) - fAt(bboxBottom))))
      : 1;
  const greenFadeStart = zeroFrac * (1 - SPAN);
  const redFadeEnd = zeroFrac + (1 - zeroFrac) * SPAN;

  // Custom tooltip matching the two-line wealth view (muted label left, value
  // right, no colon, no color dots) so Return mode and the other single-series
  // charts read identically — recharts' default content uses a "name: value"
  // layout that looks foreign next to the two-line view.
  const renderSingleTooltip = (props: {
    active?: boolean;
    label?: string | number;
    payload?: readonly { payload?: { d: string; v: number; bench: number | null } }[];
  }) => {
    if (!props.active || !props.payload?.[0]?.payload) return null;
    const p = props.payload[0].payload;
    const row = (label: string, text: string, color = "var(--ink)") => (
      <div style={{ display: "flex", gap: 10, justifyContent: "space-between" }}>
        <span style={{ color: "var(--muted)" }}>{label}</span>
        <span style={{ color, fontVariantNumeric: "tabular-nums" }}>{text}</span>
      </div>
    );
    let seriesText = valueFormatter(p.v);
    // Sign-aware colour for a return series (Return mode): a loss reads red, a
    // gain accent — matching the line colour and the hero scorecard. Non-signed
    // single-series charts (fund price, cash balance) stay accent.
    let seriesColor = accent;
    if (showReturnInTooltip && baseline) {
      const pct = (p.v / baseline - 1) * 100;
      seriesText = `${seriesText} · ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
      seriesColor = pct >= 0 ? accent : "var(--loss)";
    } else if (signed) {
      seriesColor = p.v >= sBase ? accent : "var(--loss)";
    }
    return (
      <div style={TOOLTIP_STYLE}>
        <div style={TOOLTIP_LABEL}>{formatTooltipDate(String(props.label ?? p.d))}</div>
        {row(seriesLabel, seriesText, seriesColor)}
        {p.bench != null &&
          row(benchmarkLabel ?? "Benchmark", valueFormatter(p.bench), "var(--benchmark)")}
      </div>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={merged} margin={{ top: 10, right: 4, bottom: 0, left: 4 }}>
        <defs>
          {/* Plain fill for non-signed charts (fund price, cash balance): opaque
              at the line, fully transparent at the bottom. */}
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity={0.22} />
            <stop offset="100%" stopColor={accent} stopOpacity={0} />
          </linearGradient>
          {/* Signed fade (Return): one area, green above the 0% offset / red below.
              Solid from the line, fading over the SPAN fraction of the band nearest
              0% to fully transparent AT 0% on both sides. */}
          {signed && (
            <linearGradient id={`${gradId}-signed`} x1="0" y1="0" x2="0" y2="1">
              <stop offset={0} stopColor={accent} stopOpacity={0.32} />
              <stop offset={greenFadeStart} stopColor={accent} stopOpacity={0.32} />
              <stop offset={zeroFrac} stopColor={accent} stopOpacity={0} />
              <stop offset={zeroFrac} stopColor="var(--loss)" stopOpacity={0} />
              <stop offset={redFadeEnd} stopColor="var(--loss)" stopOpacity={0.32} />
              <stop offset={1} stopColor="var(--loss)" stopOpacity={0.32} />
            </linearGradient>
          )}
        </defs>
        <XAxis
          dataKey="d"
          ticks={axisTicks}
          interval={0}
          height={NAV_AXIS_H}
          tickLine={false}
          axisLine={false}
          tick={(props) => <AxisTick {...props} ticks={axisTicks} />}
        />
        {/* Explicit, dot-radius-padded domain so the active dot at the extreme isn't
            clipped at the plot edge (matches the two-line view). */}
        {logScaleSingle ? (
          <YAxis hide scale="log" domain={[sDomMin, sDomMax]} allowDataOverflow />
        ) : (
          <YAxis hide domain={[sDomMin, sDomMax]} allowDataOverflow />
        )}
        <Tooltip cursor={{ stroke: "var(--line)", strokeWidth: 1 }} content={renderSingleTooltip} />
        {signed ? (
          <>
            {/* One continuous area from the line to the 0%-anchored baseline (no gap
                at crossovers); the gradient splits green/red at 0% and fades. The
                line carries the current gain/loss color. */}
            <Area
              type="monotone"
              dataKey="v"
              baseValue={signedBase}
              stroke="none"
              fill={`url(#${gradId}-signed)`}
              isAnimationActive={false}
              tooltipType="none"
              activeDot={false}
            />
            <Line
              type="monotone"
              dataKey="v"
              stroke={singleLineColor}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: singleLineColor }}
              isAnimationActive={false}
            />
          </>
        ) : (
          <Area
            type="monotone"
            dataKey="v"
            stroke={accent}
            strokeWidth={2}
            fill={`url(#${gradId})`}
            dot={false}
            activeDot={{ r: 4, fill: accent }}
            isAnimationActive={false}
          />
        )}
        {benchmarkData && (
          <Line
            type="monotone"
            dataKey="bench"
            stroke="var(--benchmark)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
            activeDot={{ r: 3.5, fill: "var(--benchmark)" }}
            isAnimationActive={false}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ===== Breakdown (composition over time): funds vs cash, stacked =====
// Zero-based by construction (height from 0 IS the quantity). `normalized` shows
// share-of-100% (the default — it strips the deposit-driven height jumps so true
// composition reads clearly); otherwise absolute ฿ with the total = stack height.
export function BreakdownChart({
  value,
  cash,
  normalized = true,
  height = NAV_CHART_HEIGHT,
  valuesHidden = false,
  emptyHint = null,
  emptyTitle = "NO HISTORY YET",
}: {
  /** Total net worth per date (funds + cash). */
  value: SeriesPoint[];
  /** Cash portion per date; funds = value − cash. */
  cash: SeriesPoint[];
  normalized?: boolean;
  height?: number;
  valuesHidden?: boolean;
  emptyHint?: string | null;
  emptyTitle?: string;
}) {
  if (!value || value.length === 0)
    return <EmptyState height={height} title={emptyTitle} emptyHint={emptyHint} />;

  const cashByLabel = new Map(cash.map((p) => [p.d, p.v]));
  const merged = value.map((p) => {
    const total = p.v;
    // Fully out of the market (value ~฿0): there's no composition to draw — the
    // Share split is 0/0 (undefined) and the Amount stack is zero-height. Emit a
    // gap (null) so the areas break, matching the Value line, rather than drawing
    // a misleading "0% of everything" band through a period that held nothing.
    if (isFullyOut(total)) {
      return { d: p.d, v: 0, funds: null, cash: null, fAbs: 0, cAbs: 0, total: 0 };
    }
    const c = Math.max(0, Math.min(total, cashByLabel.get(p.d) ?? 0));
    const f = Math.max(0, total - c);
    if (normalized) {
      const t = total > 0 ? total : 1;
      return {
        d: p.d,
        v: total,
        funds: (f / t) * 100,
        cash: (c / t) * 100,
        fAbs: f,
        cAbs: c,
        total,
      };
    }
    return { d: p.d, v: total, funds: f, cash: c, fAbs: f, cAbs: c, total };
  });
  const axisTicks = pickAxisTicks(merged);
  // Top of the stack (100% normalized, else the largest total) + a dot-radius pad
  // at BOTH ends (domain `[-bPad, top+bPad]`) so the active dot on the top line
  // (at the peak) and on a series sitting near the ฿0 floor aren't clipped in half.
  const bTopMax = normalized ? 100 : Math.max(0, ...merged.map((p) => p.total));
  const bPlotH = height - 10 - NAV_AXIS_H;
  const bPad = bPlotH > 0 ? (5 / bPlotH) * bTopMax : 0;

  const renderTooltip = (props: {
    active?: boolean;
    label?: string | number;
    payload?: readonly { payload?: (typeof merged)[number] }[];
  }) => {
    if (!props.active || !props.payload?.[0]?.payload) return null;
    const p = props.payload[0].payload;
    // Gap point (fully out of the market) — nothing to compose, no tooltip.
    if (p.funds == null) return null;
    const pct = (x: number) => (p.total > 0 ? `${((x / p.total) * 100).toFixed(0)}%` : "—");
    const row = (label: string, abs: number, color: string) => (
      <div style={{ display: "flex", gap: 10, justifyContent: "space-between" }}>
        <span style={{ color: "var(--muted)" }}>{label}</span>
        <span style={{ color, fontVariantNumeric: "tabular-nums" }}>
          {valuesHidden ? pct(abs) : `${fmtTHBClean(abs)} · ${pct(abs)}`}
        </span>
      </div>
    );
    return (
      <div style={TOOLTIP_STYLE}>
        <div style={TOOLTIP_LABEL}>{formatTooltipDate(String(props.label ?? p.d))}</div>
        {row("Funds", p.fAbs, "var(--accent)")}
        {row("Cash", p.cAbs, "var(--benchmark)")}
      </div>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={merged} margin={{ top: 10, right: 6, bottom: 0, left: 4 }}>
        <XAxis
          dataKey="d"
          ticks={axisTicks}
          interval={0}
          height={NAV_AXIS_H}
          tickLine={false}
          axisLine={false}
          tick={(props) => <AxisTick {...props} ticks={axisTicks} />}
        />
        <YAxis hide domain={[-bPad, bTopMax + bPad]} allowDataOverflow />
        <Tooltip cursor={{ stroke: "var(--line)", strokeWidth: 1 }} content={renderTooltip} />
        <Area
          type="monotone"
          dataKey="funds"
          stackId="mix"
          stroke="var(--accent)"
          strokeWidth={1}
          fill="var(--accent)"
          fillOpacity={0.5}
          isAnimationActive={false}
          activeDot={{ r: 3 }}
        />
        <Area
          type="monotone"
          dataKey="cash"
          stackId="mix"
          stroke="var(--benchmark)"
          strokeWidth={1}
          fill="var(--benchmark)"
          fillOpacity={0.35}
          isAnimationActive={false}
          activeDot={{ r: 3 }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ===== Allocation donut (interactive — hover a slice for value + weight) =====
export function AllocationDonut({
  data,
  height = 150,
  innerRadius = 46,
  outerRadius = 66,
}: {
  data: AllocationSlice[];
  height?: number;
  innerRadius?: number;
  outerRadius?: number;
}) {
  if (!data || data.length === 0) {
    return (
      <EmptyState
        height={height}
        title="NO HOLDINGS YET"
        emptyHint="Add holdings to see your allocation."
      />
    );
  }
  // Custom content so each value tints to its slice color (entry.color), with a
  // theme-safe ink fallback if a slice ever lacks one — readable in either theme.
  const renderTooltip = (props: {
    active?: boolean;
    payload?: readonly { payload?: AllocationSlice }[];
  }) => {
    const slice = props.payload?.[0]?.payload;
    if (!props.active || !slice) return null;
    return (
      <div style={TOOLTIP_STYLE}>
        <div style={TOOLTIP_LABEL}>{slice.label}</div>
        <div style={{ color: slice.color || "var(--ink)", fontVariantNumeric: "tabular-nums" }}>
          {`${fmtTHBClean(slice.value)} · ${slice.pct.toFixed(1)}%`}
        </div>
      </div>
    );
  };
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="label"
          innerRadius={innerRadius}
          outerRadius={outerRadius}
          paddingAngle={1.5}
          stroke="var(--bg)"
          strokeWidth={2}
          isAnimationActive={false}
        >
          {data.map((slice) => (
            <Cell key={slice.key} fill={slice.color} />
          ))}
        </Pie>
        <Tooltip content={renderTooltip} />
      </PieChart>
    </ResponsiveContainer>
  );
}

// ===== Drift bars (diverging — over/underweight vs target, hover for detail) =====
export function DriftBars({
  data,
  height = 150,
  tolerancePp = 1.5,
  maxRows = 6,
}: {
  data: SleeveDrift[];
  height?: number;
  /** Drift within ±tolerance is treated as "on target" (green). */
  tolerancePp?: number;
  maxRows?: number;
}) {
  if (!data || data.length === 0) {
    return (
      <EmptyState
        height={height}
        title="NO TARGET SET"
        emptyHint="Set a target model to see allocation drift."
      />
    );
  }
  const rows = data.slice(0, maxRows);
  const maxAbs = Math.max(2, ...rows.map((r) => Math.abs(r.drift)));
  const colorFor = (drift: number) => {
    if (Math.abs(drift) <= tolerancePp) return "var(--gain)";
    return drift > 0 ? "var(--amber)" : "var(--info)";
  };
  // Custom content so the detail line tints to the bar's own color (the
  // over/under/on-target hue), with a theme-safe ink fallback. recharts' default
  // tooltip can't do this: the color lives on per-Cell fills, so it would fall
  // back to near-black instead.
  const renderTooltip = (props: {
    active?: boolean;
    payload?: readonly { payload?: SleeveDrift }[];
  }) => {
    const p = props.payload?.[0]?.payload;
    if (!props.active || !p) return null;
    const sign = p.drift > 0 ? "+" : "";
    return (
      <div style={TOOLTIP_STYLE}>
        <div style={TOOLTIP_LABEL}>{p.label}</div>
        <div
          style={{ color: colorFor(p.drift) || "var(--ink)", fontVariantNumeric: "tabular-nums" }}
        >
          {`${p.current.toFixed(1)}% now vs ${p.target.toFixed(1)}% target (${sign}${p.drift.toFixed(1)}pp)`}
        </div>
      </div>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
        <XAxis type="number" domain={[-maxAbs, maxAbs]} hide />
        <YAxis
          type="category"
          dataKey="ticker"
          tick={{ fontSize: 10, fill: "var(--muted)", fontFamily: "var(--font-mono)" }}
          tickLine={false}
          axisLine={false}
          width={70}
        />
        <ReferenceLine x={0} stroke="var(--line)" />
        <Tooltip cursor={{ fill: "var(--line-soft)" }} content={renderTooltip} />
        <Bar dataKey="drift" radius={[2, 2, 2, 2]} isAnimationActive={false}>
          {rows.map((r) => (
            <Cell key={r.ticker} fill={colorFor(r.drift)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
