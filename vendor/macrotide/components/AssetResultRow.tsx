"use client";

// AssetResultRow — the one result-row skeleton shared by the Explore screeners
// (All / US ETFs / US stocks; the Thai screener mirrors the same visual
// language). Two rows: line 1 is [#] ticker · badge · category … metric (the IDs,
// classification, headline number — the sector fills the space after the badge,
// like the fund tab's class tags); line 2 is the full name across the whole row
// width with the muted exchange tucked right.

import type { ReactNode, Ref } from "react";
import { MiniTag } from "@/components/ui/MiniTag";

export type AssetTypeKind = "thai_fund" | "us_etf" | "us_stock";

// ETF = accent (green, the index-investing hero), Fund = blue (--info), Stock =
// amber — three clearly distinct hues. Stock is colored (not grey) so it can't be
// mistaken for the neutral-grey sector chip that sits next to it. (--accent is
// green in this app; --info the blue.)
const BADGE_COLOR: Record<AssetTypeKind, { color: string; bg: string }> = {
  us_etf: { color: "var(--accent-ink)", bg: "var(--accent-soft)" },
  thai_fund: { color: "var(--info)", bg: "color-mix(in srgb, var(--info) 16%, transparent)" },
  us_stock: { color: "var(--amber)", bg: "var(--amber-soft, rgba(245,158,11,0.1))" },
};

/** Product-type badge for the mixed "All" list: Fund / ETF / Stock — the shared
 *  MiniTag (same chip as the Thai fund-class tags), retinted per type. */
export function AssetTypeBadge({ kind }: { kind: AssetTypeKind }) {
  const label = kind === "thai_fund" ? "Fund" : kind === "us_etf" ? "ETF" : "Stock";
  const c = BADGE_COLOR[kind];
  return <MiniTag label={label} color={c.color} bg={c.bg} />;
}

export function AssetResultRow({
  index,
  ticker,
  badge,
  category,
  name,
  exchange,
  metric,
  onClick,
  onIntent,
  focusRef,
}: {
  /** 1-based position in the list — a plain number, shared across tabs. */
  index: number;
  ticker: string;
  badge?: ReactNode;
  /** Muted classification on line 1 after the badge (sector / asset class). */
  category?: string;
  name: string;
  /** Muted listing on line 2 after the name (exchange / market). */
  exchange?: string;
  /** Right-aligned line-1 metric node (TER, market cap, …). */
  metric?: ReactNode;
  onClick: () => void;
  /** Warm-on-hover/focus (prefetch). */
  onIntent?: () => void;
  focusRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      ref={focusRef}
      onClick={onClick}
      onMouseEnter={onIntent}
      onFocus={onIntent}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        width: "100%",
        textAlign: "left",
        padding: "10px 14px",
        background: "none",
        border: "none",
        borderBottom: "1px solid var(--line-soft)",
        cursor: "pointer",
      }}
    >
      <span
        style={{
          minWidth: 18,
          marginTop: 1,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--muted)",
          textAlign: "right",
          flexShrink: 0,
        }}
      >
        {index}
      </span>
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        {/* Line 1 — ticker · badge · sector (fills the space, truncates) · metric. */}
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span
            style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, flexShrink: 0 }}
          >
            {ticker}
          </span>
          {badge}
          {category && (
            <MiniTag
              label={category}
              title={category}
              color="var(--muted)"
              bg="var(--card-soft)"
              clamp
            />
          )}
          {metric && <span style={{ flexShrink: 0, marginLeft: "auto" }}>{metric}</span>}
        </span>
        {/* Line 2 — full name across the whole width · muted exchange, right. Same
            font/color as the Thai fund-row name (12.5px, muted). */}
        <span style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
          <span
            title={name}
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12.5,
              color: "var(--muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {name}
          </span>
          {exchange && (
            <span style={{ flexShrink: 0, fontSize: 11.5, color: "var(--muted)" }}>{exchange}</span>
          )}
        </span>
      </span>
    </button>
  );
}
