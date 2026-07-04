"use client";

// TerBadge — the shared "TER" headline metric used by every Explore screener
// (Thai funds, US ETFs, the mixed All list). A grey "TER" label sits left of a
// fee-level-colored value chip: green ≤ 0.5%, amber 0.5–1.5%, red > 1.5%, muted
// when unpublished. The Thai fund row reuses terColor/terBg directly (it lays
// the badge in its own TER-over-1Y grid); the unified rows render the whole
// label+chip via <TerBadge>.

import type { CSSProperties } from "react";

/** Fee-level text color for a TER expressed in PERCENT. */
export function terColor(ter: number | null): string {
  if (ter == null) return "var(--muted)";
  return ter <= 0.5 ? "var(--gain)" : ter <= 1.5 ? "var(--amber, #f59e0b)" : "var(--loss)";
}

/** Fee-level chip background, paired with terColor. */
export function terBg(ter: number | null): string {
  if (ter == null) return "var(--card-soft)";
  return ter <= 0.5
    ? "var(--gain-soft, rgba(34,197,94,0.1))"
    : ter <= 1.5
      ? "var(--amber-soft, rgba(245,158,11,0.1))"
      : "var(--loss-soft, rgba(220,38,38,0.08))";
}

/** Grey, bold label ("TER" / "1Y") sitting left of its value. */
export const METRIC_LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  fontWeight: 600,
  color: "var(--muted)",
  letterSpacing: "0.04em",
  textAlign: "right",
  whiteSpace: "nowrap",
};

/** Just the fee-colored value chip (no label) — for callers that lay the label
 *  out themselves (e.g. the Thai fund row's TER-over-1Y grid). */
export const TER_CHIP_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontWeight: 600,
  borderRadius: 6,
  padding: "2px 7px",
  whiteSpace: "nowrap",
};

/** The full inline metric: a "TER" label + the fee-colored value chip. `pct` is
 *  already in percent (1.20 → "1.20%"). */
export function TerBadge({ pct }: { pct: number | null }) {
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}
      title="Total expense ratio (annual fee)"
    >
      <span style={METRIC_LABEL_STYLE}>TER</span>
      <span style={{ ...TER_CHIP_STYLE, color: terColor(pct), background: terBg(pct) }}>
        {pct != null ? `${pct.toFixed(2)}%` : "–"}
      </span>
    </span>
  );
}
