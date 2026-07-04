"use client";

import type { CSSProperties } from "react";

// Shimmer placeholders shown while a screen's data resolves. Size them like
// the content they stand in for so nothing jumps when real data lands.
// Shimmer animation lives in globals.css under `.skeleton`.

export function Skeleton({
  width,
  height = 14,
  radius,
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number;
  style?: CSSProperties;
}) {
  return (
    <div
      className="skeleton"
      aria-hidden
      style={{ width, height, borderRadius: radius, ...style }}
    />
  );
}

/** A stack of row-shaped placeholders approximating a loading list. */
export function SkeletonRows({
  rows = 4,
  height = 48,
  gap = 8,
  padding = "10px 14px",
}: {
  rows?: number;
  height?: number;
  gap?: number;
  padding?: string | number;
}) {
  return (
    <div aria-hidden style={{ display: "flex", flexDirection: "column", gap, padding }}>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
        <div key={i} className="skeleton" style={{ height }} />
      ))}
    </div>
  );
}
