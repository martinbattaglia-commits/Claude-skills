// Small hand-drawn SVG chart primitives (sparklines, mini line/bars, model
// donuts). These are intentionally NOT interactive — for full charts with
// hover + tooltips see components/InteractiveCharts.tsx (recharts).

import { useId } from "react";
import { formatSeriesDate } from "@/lib/portfolio/adapter";
import { rebaseBenchmark } from "@/lib/portfolio/rebase";
import type { MixSlice, SeriesPoint } from "@/lib/static/types";

// ===== Sparkline =====
export function Sparkline({
  data,
  color = "currentColor",
  height = 36,
  width = 80,
  showFill = true,
}: {
  data: (number | SeriesPoint)[];
  color?: string;
  height?: number;
  width?: number;
  showFill?: boolean;
}) {
  if (!data || data.length === 0) return null;
  const vals = data.map((d) => (typeof d === "number" ? d : d.v));
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return [x, y] as const;
  });
  const path = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(" ");
  const fillPath = `${path} L${width},${height} L0,${height} Z`;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ overflow: "visible" }}
    >
      {showFill && <path d={fillPath} fill={color} opacity="0.10"></path>}
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      ></path>
    </svg>
  );
}

// ===== Big performance chart =====
export function PerfChart({
  data,
  height = 160,
  accent = "var(--accent)",
  benchmarkData = null,
  benchmarkLabel = null,
  emptyHint = null,
}: {
  data: SeriesPoint[];
  height?: number;
  accent?: string;
  benchmarkData?: SeriesPoint[] | null;
  benchmarkLabel?: string | null;
  /** Sub-line shown under "NO HISTORY YET" — explains what's needed. */
  emptyHint?: string | null;
}) {
  const W = 400;
  const padLeft = 0,
    padRight = 0,
    padTop = 12,
    padBottom = 24;
  const innerH = height - padTop - padBottom;

  if (!data || data.length === 0) {
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
          NO HISTORY YET
        </div>
        {emptyHint && (
          <div style={{ fontSize: 11, maxWidth: 320, lineHeight: 1.5 }}>{emptyHint}</div>
        )}
      </div>
    );
  }

  // Align + rebase the benchmark onto the portfolio's first common date so both
  // lines share a scale. The old `length === length` gate dropped the line
  // whenever the two series differed in length (almost always, given TH vs US
  // trading calendars); intersecting by date renders it whenever data overlaps.
  // The SVG path needs numbers, so pre-anchor nulls hold flat at the rebased
  // start (the first non-null value) — that keeps them from distorting the scale.
  const rebased = rebaseBenchmark(data, benchmarkData);
  const benchAnchorV = rebased?.find((p) => p.v != null)?.v ?? null;
  const benchSeries: SeriesPoint[] | null =
    rebased && benchAnchorV != null
      ? rebased.map((p) => ({ d: p.d, v: p.v ?? benchAnchorV }))
      : null;

  const allVals = [...data.map((d) => d.v), ...(benchSeries ? benchSeries.map((d) => d.v) : [])];
  const min = Math.min(...allVals);
  const max = Math.max(...allVals);
  const range = max - min || 1;

  const toPts = (arr: SeriesPoint[]) =>
    arr.map((d, i) => {
      const x = padLeft + (i / (arr.length - 1)) * (W - padLeft - padRight);
      const y = padTop + innerH - ((d.v - min) / range) * innerH;
      return [x, y, d] as const;
    });

  const pts = toPts(data);
  const linePath = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(" ");
  const fillPath =
    linePath +
    ` L${pts[pts.length - 1][0]},${height - padBottom} L${pts[0][0]},${height - padBottom} Z`;

  const benchPts = benchSeries ? toPts(benchSeries) : null;
  const benchPath = benchPts
    ? benchPts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(" ")
    : null;

  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      style={{ overflow: "visible" }}
    >
      <defs>
        <linearGradient id="perfGrad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={accent} stopOpacity="0.22"></stop>
          <stop offset="100%" stopColor={accent} stopOpacity="0"></stop>
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((t) => (
        <line
          key={t}
          x1="0"
          x2={W}
          y1={padTop + innerH * t}
          y2={padTop + innerH * t}
          className="chart-grid"
          strokeDasharray="2 4"
        ></line>
      ))}
      <path d={fillPath} fill="url(#perfGrad)"></path>
      <path
        d={linePath}
        fill="none"
        stroke={accent}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      ></path>
      {benchPath && (
        <path
          d={benchPath}
          fill="none"
          stroke="var(--benchmark)"
          strokeWidth="1.5"
          strokeDasharray="4 3"
          strokeLinejoin="round"
          strokeLinecap="round"
        ></path>
      )}
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="4" fill={accent}></circle>
      <circle
        cx={pts[pts.length - 1][0]}
        cy={pts[pts.length - 1][1]}
        r="8"
        fill={accent}
        opacity="0.2"
      ></circle>
      {(() => {
        // Spread ~6 evenly-spaced labels across the x-axis regardless of how
        // many points the series has. With raw daily NAV history (100+ pts)
        // labeling every-other point would render as overlapping text.
        const labelCount = Math.min(pts.length, 6);
        if (labelCount < 2) return null;
        const step = (pts.length - 1) / (labelCount - 1);
        return Array.from({ length: labelCount }, (_, k) => {
          const i = Math.round(k * step);
          const p = pts[i];
          return (
            <text key={i} x={p[0]} y={height - 6} textAnchor="middle" className="chart-axis">
              {formatSeriesDate(p[2].d)}
            </text>
          );
        });
      })()}
      {benchmarkLabel && benchPts && (
        <text
          x={W - 4}
          y={benchPts[benchPts.length - 1][1] - 6}
          textAnchor="end"
          fontSize="10"
          fill="var(--muted)"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {benchmarkLabel}
        </text>
      )}
    </svg>
  );
}

// ===== Donut allocation chart =====
export function Donut({
  data,
  size = 140,
  thickness = 18,
}: {
  data: { label: string; value: number; color: string }[];
  size?: number;
  thickness?: number;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const cx = size / 2,
    cy = size / 2;
  const r = (size - thickness) / 2;
  let start = -Math.PI / 2;
  const arcs =
    total > 0
      ? data.map((d, i) => {
          const angle = (d.value / total) * Math.PI * 2;
          const end = start + angle;
          const large = angle > Math.PI ? 1 : 0;
          const x1 = cx + r * Math.cos(start);
          const y1 = cy + r * Math.sin(start);
          const x2 = cx + r * Math.cos(end);
          const y2 = cy + r * Math.sin(end);
          const path = `M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2}`;
          const out = { path, color: d.color, key: i };
          start = end;
          return out;
        })
      : [];
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke="var(--line-soft)"
        strokeWidth={thickness}
      ></circle>
      {arcs.map((a) => (
        <path
          key={a.key}
          d={a.path}
          fill="none"
          stroke={a.color}
          strokeWidth={thickness}
          strokeLinecap="butt"
        ></path>
      ))}
    </svg>
  );
}

// ===== Mini line (no axes — for small chart cards) =====
export function MiniLine({
  data,
  accent = "currentColor",
  height = 48,
  width = 240,
}: {
  data: (number | SeriesPoint)[];
  accent?: string;
  height?: number;
  width?: number;
}) {
  // useId() gives a stable id across SSR + hydration (no Math.random in render).
  // Must be called before any early return to satisfy rules of hooks.
  const rawId = useId();
  if (!data || data.length === 0) return null;
  const vals = data.map((d) => (typeof d === "number" ? d : d.v));
  const min = Math.min(...vals),
    max = Math.max(...vals);
  const range = max - min || 1;
  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return [x, y] as const;
  });
  const path = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(" ");
  const fillPath = `${path} L${width},${height} L0,${height} Z`;
  const gid = `mg-${rawId.replace(/:/g, "")}`;
  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ display: "block" }}
    >
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={accent} stopOpacity="0.22"></stop>
          <stop offset="100%" stopColor={accent} stopOpacity="0"></stop>
        </linearGradient>
      </defs>
      <path d={fillPath} fill={`url(#${gid})`}></path>
      <path
        d={path}
        fill="none"
        stroke={accent}
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      ></path>
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="3" fill={accent}></circle>
    </svg>
  );
}

// ===== Mini bars (vertical) =====
export function MiniBars({
  data,
  accent = "currentColor",
  height = 48,
  width = 240,
}: {
  data: (number | SeriesPoint)[];
  accent?: string;
  height?: number;
  width?: number;
}) {
  if (!data || data.length === 0) return null;
  const vals = data.map((d) => (typeof d === "number" ? d : d.v));
  const max = Math.max(...vals, 1);
  const barW = (width - (data.length - 1) * 4) / data.length;
  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ display: "block" }}
    >
      {vals.map((v, i) => {
        const h = v === 0 ? 2 : (v / max) * (height - 4);
        return (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: bare numbers have no identity; bars are positional and the list fully re-renders
            key={i}
            x={i * (barW + 4)}
            y={height - h - 1}
            width={barW}
            height={h}
            fill={v === 0 ? "var(--line)" : accent}
            opacity={v === 0 ? 0.5 : 1}
            rx="2"
          />
        );
      })}
    </svg>
  );
}

// ===== Donut sized for model portfolio cards =====
export function ModelDonut({
  mix,
  size = 56,
  thickness = 9,
}: {
  mix: MixSlice[];
  size?: number;
  thickness?: number;
}) {
  const cx = size / 2,
    cy = size / 2;
  const r = (size - thickness) / 2;
  let start = -Math.PI / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {mix.map((m) => {
        const angle = (m.pct / 100) * Math.PI * 2;
        const end = start + angle;
        const large = angle > Math.PI ? 1 : 0;
        const x1 = cx + r * Math.cos(start);
        const y1 = cy + r * Math.sin(start);
        const x2 = cx + r * Math.cos(end);
        const y2 = cy + r * Math.sin(end);
        const path = `M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2}`;
        const out = (
          <path
            key={m.label}
            d={path}
            fill="none"
            stroke={m.color}
            strokeWidth={thickness}
            strokeLinecap="butt"
          ></path>
        );
        start = end;
        return out;
      })}
    </svg>
  );
}
