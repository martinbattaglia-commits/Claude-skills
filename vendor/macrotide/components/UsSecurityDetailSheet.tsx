"use client";

// UsSecurityDetailSheet — the rich detail overlay for a single US stock / ETF,
// mirroring FundDetailSheet's shell and visual language. Long-scroll: profile +
// price chart + key stats, then the index-investing cross-links (the on-ramp
// from a single name to a low-cost index fund), then ETF holdings + exposure or
// dividends. Deep data (the full holdings list) sits behind an inline expand;
// there is no raw-financials drill-in by design — this is a portfolio app, not a
// research terminal.
//
// Cache-first + JIT: the payload returns whatever is cached now; opening also
// POSTs /view to warm the cold tail, and SWR revalidation fills the sections in.

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { NavChart } from "@/components/InteractiveChartsLazy";
import { Modal } from "@/components/Modal";
import { ShowMoreToggle } from "@/components/ui/ShowMoreToggle";
import { Skeleton } from "@/components/ui/Skeleton";
import { Stat } from "@/components/ui/Stat";
import type { RelatedEtfRow } from "@/lib/db/queries/us-detail";
import type { UsDividendRow } from "@/lib/db/queries/us-dividends";
import type { EtfHoldingRow, ExposureSlice } from "@/lib/db/queries/us-etf-holdings";
import type { RelatedFund } from "@/lib/db/queries/us-related";
import type { UsSecurity } from "@/lib/db/queries/us-securities";
import {
  type SeriesRange,
  useUsSecurityDetail,
  useUsSecuritySeries,
} from "@/lib/fetchers/portfolio";
import { fmtPct } from "@/lib/fund-detail-format";
import { cleanUsSecurityName } from "@/lib/market/us-security-name";
import type { DetailEntry } from "@/lib/nav/detail-stack";
import { NAV_CHART_HEIGHT, seriesReturnPct } from "@/lib/portfolio/adapter";

const NAV_RANGES: { lbl: string; range: SeriesRange }[] = [
  { lbl: "1M", range: "1mo" },
  { lbl: "3M", range: "3mo" },
  { lbl: "6M", range: "6mo" },
  { lbl: "1Y", range: "1y" },
  { lbl: "All", range: "max" },
];

const fmtUsd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Compact USD for market cap: $3.28T, $1.2B, $740M. */
function fmtCompactUsd(n: number | null): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return fmtUsd(n);
}

/** US TER is stored as a FRACTION (0.0003 = 0.03%). */
const fmtTerFraction = (ter: number | null): string | null =>
  ter == null ? null : `${(ter * 100).toFixed(2)}%`;
/** Thai fund TER is stored as a PERCENT already (1.2 = 1.2%). */
const fmtTerPercent = (ter: number | null): string | null =>
  ter == null || ter <= 0 ? null : `${ter.toFixed(2)}%`;

const fmtRatio = (n: number | null): string | null =>
  n == null || !Number.isFinite(n) ? null : n.toFixed(1);
const fmtFracPct = (n: number | null): string | null =>
  n == null || !Number.isFinite(n) ? null : `${(n * 100).toFixed(2)}%`;

// TER badge color, taking a fee already expressed in PERCENT (≤0.5 green …).
function terTone(pctValue: number | null): { color: string; bg: string } {
  if (pctValue == null) return { color: "var(--muted)", bg: "var(--card-soft)" };
  if (pctValue <= 0.5) return { color: "var(--gain)", bg: "var(--gain-soft, rgba(34,197,94,0.1))" };
  if (pctValue <= 1.5)
    return { color: "var(--amber, #f59e0b)", bg: "var(--amber-soft, rgba(245,158,11,0.1))" };
  return { color: "var(--loss)", bg: "var(--loss-soft, rgba(220,38,38,0.08))" };
}

const COUNTRY_NAMES: Record<string, string> = {
  US: "United States",
  IE: "Ireland",
  GB: "United Kingdom",
  JP: "Japan",
  CH: "Switzerland",
  CA: "Canada",
  NL: "Netherlands",
  FR: "France",
  DE: "Germany",
  TW: "Taiwan",
  KR: "South Korea",
  Unknown: "Unknown",
};
const countryName = (k: string) => COUNTRY_NAMES[k] ?? k;

function SectionHeader({ title, aside }: { title: string; aside?: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--muted)",
        marginBottom: 8,
        marginTop: 20,
        paddingBottom: 4,
        borderBottom: "1px solid var(--line-soft)",
      }}
    >
      <span>{title}</span>
      {aside && <span style={{ fontWeight: 400, letterSpacing: 0 }}>{aside}</span>}
    </div>
  );
}

// ─── price chart (own series endpoint, own range state) ──────────────────────

function UsSecurityChart({ symbol }: { symbol: string }) {
  const [range, setRange] = useState<SeriesRange>("1y");
  const { data, isLoading } = useUsSecuritySeries(symbol, range);
  const chartData = (data?.series ?? []).map((p) => ({ d: p.d, v: p.v }));
  const periodReturn = seriesReturnPct(chartData);

  return (
    <section style={{ marginTop: 16 }}>
      <div className="row between" style={{ marginBottom: 8 }}>
        <div className="range-pills">
          {NAV_RANGES.map((r) => (
            <button
              key={r.lbl}
              type="button"
              data-active={range === r.range}
              onClick={() => setRange(r.range)}
            >
              {r.lbl}
            </button>
          ))}
        </div>
      </div>
      {periodReturn != null && (
        <span
          className={`delta-pill${periodReturn < 0 ? " down" : ""}`}
          style={{ fontSize: 13, marginTop: 4 }}
        >
          {fmtPct(periodReturn)}
        </span>
      )}
      {isLoading ? (
        <Skeleton height={NAV_CHART_HEIGHT} style={{ marginTop: 4 }} />
      ) : (
        <NavChart
          data={chartData}
          height={NAV_CHART_HEIGHT}
          accent="var(--accent)"
          valueFormatter={fmtUsd}
          seriesLabel="Price"
          showReturnInTooltip
          emptyHint="Price history isn't available for this symbol yet."
        />
      )}
    </section>
  );
}

// ─── key stats ───────────────────────────────────────────────────────────────

function StatGrid({
  security,
  price,
  trailingYield,
  holdingCount,
}: {
  security: UsSecurity;
  price: number | null;
  trailingYield: number | null;
  holdingCount: number | null;
}) {
  const cells: { label: string; value: string }[] = [];
  const push = (label: string, value: string | null) => {
    if (value != null) cells.push({ label, value });
  };

  if (security.securityType === "etf") {
    // TER headlines next to the ticker (like the fund sheet), so it's not repeated here.
    push("Price", price != null ? fmtUsd(price) : null);
    push("Dividend yield", fmtFracPct(trailingYield));
    push("Holdings", holdingCount != null ? String(holdingCount) : null);
  } else {
    push("P/E", fmtRatio(security.peRatio));
    push("P/B", fmtRatio(security.pbRatio));
    push("Market cap", fmtCompactUsd(security.marketCap));
    push("Net margin", fmtFracPct(security.netMargin));
    push("EPS (diluted)", security.epsDiluted != null ? fmtUsd(security.epsDiluted) : null);
    push("Dividend yield", fmtFracPct(trailingYield));
  }

  if (cells.length === 0) return null;
  return (
    <div
      className="stat-cards stat-cards--eq"
      style={{ margin: "16px 0 4px", gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}
    >
      {cells.map((c) => (
        <Stat key={c.label} label={c.label} value={c.value} tone="neutral" />
      ))}
    </div>
  );
}

// ─── index membership chips ──────────────────────────────────────────────────

function IndexChips({ names, isEtf }: { names: string[]; isEtf: boolean }) {
  if (names.length === 0) return null;
  return (
    <>
      <SectionHeader title={isEtf ? "Tracks" : "Member of"} />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {names.map((n) => (
          <span
            key={n}
            style={{
              fontSize: 12,
              padding: "3px 10px",
              borderRadius: 999,
              background: "var(--card-soft)",
              color: "var(--ink-soft)",
            }}
          >
            {n}
          </span>
        ))}
      </div>
    </>
  );
}

// ─── index-investing cross-links (the on-ramp) ───────────────────────────────

function RelatedRow({
  ticker,
  name,
  ter,
  weight,
  isIndex,
  onClick,
}: {
  ticker: string;
  name: string;
  ter: string | null;
  /** This security's weight in the ETF (e.g. "7.63%"), shown as "holds …". */
  weight?: string | null;
  /** Show an "Index" badge (a confirmed index fund/ETF). */
  isIndex?: boolean;
  onClick?: () => void;
}) {
  const tone = ter ? terTone(parseFloat(ter)) : null;
  const inner = (
    <>
      <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600 }}>
            {ticker}
          </span>
          {isIndex && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: "0.04em",
                color: "var(--accent-ink, var(--accent))",
                background: "var(--accent-soft)",
                borderRadius: 4,
                padding: "1px 5px",
                whiteSpace: "nowrap",
              }}
              title="Index fund / ETF"
            >
              INDEX
            </span>
          )}
        </span>
        <span
          style={{
            fontSize: 11.5,
            color: "var(--muted)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {name}
        </span>
      </span>
      {/* TER (optional) then holds — holds is present on nearly every row, so it
          anchors the column just left of the chevron and lines up across rows. */}
      <span style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        {ter && tone && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              fontWeight: 600,
              color: tone.color,
              background: tone.bg,
              borderRadius: 6,
              padding: "2px 7px",
              whiteSpace: "nowrap",
            }}
            title="Total expense ratio (annual fee)"
          >
            TER {ter}
          </span>
        )}
        {weight && (
          <span style={{ fontSize: 11.5, color: "var(--ink-soft)", whiteSpace: "nowrap" }}>
            holds{" "}
            <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500, color: "var(--ink)" }}>
              {weight}
            </span>
          </span>
        )}
        {onClick && <Icon name="chevron-right" size={14} />}
      </span>
    </>
  );
  const style: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "8px 0",
    borderBottom: "1px solid var(--line-soft)",
    width: "100%",
    textAlign: "left",
    background: "none",
    border: "none",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: "var(--line-soft)",
    cursor: onClick ? "pointer" : "default",
  };
  return onClick ? (
    <button type="button" onClick={onClick} style={style}>
      {inner}
    </button>
  ) : (
    <div style={style}>{inner}</div>
  );
}

/** "A", "A and B", "A, B, and C" — name every index the security belongs to. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

const RELATED_ETF_VISIBLE = 4;

/** One labeled group of related ETFs (broad / sector / holder) with its own
 *  cheapest-first cap and a "show more" that reveals the rest in place — so a
 *  higher-fee sector group is never crowded out by the cheap broad one. */
function RelatedEtfGroup({
  label,
  rows,
  onOpenSymbol,
}: {
  label: string | null;
  rows: RelatedEtfRow[];
  onOpenSymbol: (symbol: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (rows.length === 0) return null;
  const shown = expanded ? rows : rows.slice(0, RELATED_ETF_VISIBLE);
  return (
    <div style={{ marginTop: 8 }}>
      {label && <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 2 }}>{label}</div>}
      {shown.map((e) => (
        <RelatedRow
          key={e.symbol}
          ticker={e.symbol}
          name={cleanUsSecurityName(e.name)}
          ter={fmtTerFraction(e.ter)}
          weight={e.weightPct != null ? `${e.weightPct.toFixed(2)}%` : null}
          isIndex={e.isIndex}
          onClick={() => onOpenSymbol(e.symbol)}
        />
      ))}
      <ShowMoreToggle
        expanded={expanded}
        moreCount={rows.length - RELATED_ETF_VISIBLE}
        onToggle={() => setExpanded((v) => !v)}
      />
    </div>
  );
}

/** The "Thai index funds" group with the same cheapest-first cap + "show more" as
 *  the US ETF groups. Opens the exact share CLASS the row shows (its ticker). */
function ThaiFundGroup({
  funds,
  onOpenFund,
}: {
  funds: RelatedFund[];
  onOpenFund?: (projId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (funds.length === 0) return null;
  const shown = expanded ? funds : funds.slice(0, RELATED_ETF_VISIBLE);
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 2 }}>Thai funds</div>
      {shown.map((f) => (
        <RelatedRow
          key={f.projId}
          ticker={f.ticker ?? f.projId}
          name={f.name}
          ter={fmtTerPercent(f.ter)}
          weight={f.weightPct != null ? `${f.weightPct.toFixed(2)}%` : null}
          // Thai funds here are gated to index style (PN/PM), so all are index.
          isIndex
          // Open the exact CLASS the row shows (its ticker), not the parent projId —
          // the detail route resolves a class ticker; projId would default to another.
          onClick={onOpenFund ? () => onOpenFund(f.ticker ?? f.projId) : undefined}
        />
      ))}
      <ShowMoreToggle
        expanded={expanded}
        moreCount={funds.length - RELATED_ETF_VISIBLE}
        onToggle={() => setExpanded((v) => !v)}
      />
    </div>
  );
}

function RelatedSection({
  security,
  indexNames,
  relatedEtfs,
  thaiFunds,
  onOpenSymbol,
  onOpenFund,
}: {
  security: UsSecurity;
  indexNames: string[];
  relatedEtfs: RelatedEtfRow[];
  thaiFunds: RelatedFund[];
  onOpenSymbol: (symbol: string) => void;
  onOpenFund?: (projId: string) => void;
}) {
  if (relatedEtfs.length === 0 && thaiFunds.length === 0) return null;
  const isEtf = security.securityType === "etf";
  const family = indexNames.length > 0 ? joinNames(indexNames) : "an index";
  // The list mixes index trackers with any fund/ETF that holds the security, so
  // for a stock the title stays honest about "a fund", not "the index". The
  // per-row "Index" badge marks the confirmed index funds/ETFs.
  const title = isEtf ? "Own the index" : "Own it through a fund";
  const lead = isEtf
    ? `Other low-cost ways to own ${family}.`
    : `${security.symbol} is part of ${family}. Own it, for less, through a fund or ETF below — each shows whether it's an index fund, how much of ${security.symbol} it holds, and its annual fee.`;

  return (
    <>
      <SectionHeader title={title} />
      <p style={{ fontSize: 12.5, color: "var(--ink-soft)", margin: "0 0 6px", lineHeight: 1.5 }}>
        {lead}
      </p>
      {relatedEtfs.length > 0 &&
        (() => {
          // Group broad → sector → holder. Sub-labels appear only when there's
          // more than one US group (a lone broad list needs no header under the
          // section title). The sector label names the actual sector.
          const broad = relatedEtfs.filter((e) => e.group === "broad");
          const sector = relatedEtfs.filter((e) => e.group === "sector");
          const holder = relatedEtfs.filter((e) => e.group === "holder");
          const groupCount = [broad, sector, holder].filter((g) => g.length > 0).length;
          const multi = groupCount > 1;
          const sectorLabel = security.gicsSector ? `${security.gicsSector} sector` : "Sector";
          return (
            <div style={{ marginTop: 6 }}>
              <RelatedEtfGroup
                label={multi ? "Broad index" : "US ETFs"}
                rows={broad}
                onOpenSymbol={onOpenSymbol}
              />
              <RelatedEtfGroup label={sectorLabel} rows={sector} onOpenSymbol={onOpenSymbol} />
              <RelatedEtfGroup
                label={`Also holds ${security.symbol}`}
                rows={holder}
                onOpenSymbol={onOpenSymbol}
              />
            </div>
          );
        })()}
      <ThaiFundGroup funds={thaiFunds} onOpenFund={onOpenFund} />
    </>
  );
}

// ─── ETF holdings (top-N inline + expand to full) ────────────────────────────

function HoldingsSection({
  items,
  asOf,
  onOpenSymbol,
}: {
  items: EtfHoldingRow[];
  asOf: string | null;
  /** Open a constituent's own detail in-sheet (only rows resolved to a US ticker). */
  onOpenSymbol?: (symbol: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const shown = expanded ? items : items.slice(0, 10);

  // Gross exposure well over 100% means a leveraged/inverse fund whose "holdings"
  // are swap NOTIONAL + collateral (e.g. a 2x single-stock ETF: one AAPL swap at
  // ~200% + T-bills) — not direct positions. Flag it so the >100% weights and the
  // swap counterparty name don't read as broken data.
  const grossWeight = items.reduce((sum, h) => sum + Math.abs(h.weightPct ?? 0), 0);
  const isDerivativeFund = grossWeight > 110;

  return (
    <>
      <SectionHeader title="Top holdings" aside={asOf ? `as of ${asOf}` : undefined} />
      {isDerivativeFund && (
        <p
          style={{
            fontSize: 12,
            color: "var(--muted)",
            margin: "0 0 8px",
            lineHeight: 1.5,
          }}
        >
          Uses derivatives for leveraged or inverse exposure — the figures are notional swap
          exposure and collateral, so they can exceed 100% and aren't direct holdings.
        </p>
      )}
      <ol
        style={{
          margin: 0,
          padding: 0,
          listStyle: "none",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        {shown.map((h) => {
          const sym = h.resolvedSymbol;
          const tappable = Boolean(sym && onOpenSymbol);
          // Two-line row (like the related-fund rows): identity on line 1, the
          // descriptive detail on line 2 so a long derivative row wraps instead of
          // truncating on mobile. When resolved, the ticker headlines and the name
          // moves to the detail line; otherwise the name headlines. The detail line
          // labels a non-common-stock instrument ("Equity derivative", "Debt") and
          // a derivative's counterparty ("via Cowen Group").
          const detail = [
            sym ? h.name : null,
            h.assetCat && h.assetCat !== "Equity (common)" ? h.assetCat : null,
            h.counterparty ? `via ${h.counterparty}` : null,
          ]
            .filter(Boolean)
            .join(" · ");
          const inner = (
            <>
              <span
                style={{
                  minWidth: 18,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--muted)",
                  flexShrink: 0,
                }}
              >
                {h.rank}
              </span>
              <span
                style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}
              >
                <span
                  style={{
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    ...(sym
                      ? {
                          fontFamily: "var(--font-mono)",
                          fontSize: 12.5,
                          fontWeight: 600,
                          color: "var(--ink)",
                        }
                      : { fontSize: 13 }),
                  }}
                >
                  {sym || h.name}
                </span>
                {detail && (
                  <span
                    style={{
                      fontSize: 11.5,
                      color: "var(--muted)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {detail}
                  </span>
                )}
              </span>
              {/* Right-align the weight in a fixed box and always reserve the
                  chevron slot, so the % forms a clean column whether or not a row
                  is tappable (an untappable row's % would otherwise sit further
                  right by the chevron's width). */}
              <span style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    color: "var(--ink)",
                    fontWeight: 500,
                    textAlign: "right",
                    minWidth: 54,
                  }}
                >
                  {h.weightPct != null ? `${h.weightPct.toFixed(2)}%` : "—"}
                </span>
                <span
                  style={{
                    width: 13,
                    display: "inline-flex",
                    justifyContent: "center",
                    flexShrink: 0,
                    color: "var(--muted)",
                  }}
                >
                  {tappable && <Icon name="chevron-right" size={13} />}
                </span>
              </span>
            </>
          );
          const rowStyle: React.CSSProperties = {
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "5px 0",
            width: "100%",
            textAlign: "left",
            background: "none",
            border: "none",
            cursor: tappable ? "pointer" : "default",
          };
          return (
            <li key={`${h.rank}-${h.name}`} style={{ borderBottom: "1px solid var(--line-soft)" }}>
              {tappable && sym ? (
                <button type="button" onClick={() => onOpenSymbol?.(sym)} style={rowStyle}>
                  {inner}
                </button>
              ) : (
                <div style={rowStyle}>{inner}</div>
              )}
            </li>
          );
        })}
      </ol>
      <ShowMoreToggle
        expanded={expanded}
        moreCount={items.length - 10}
        onToggle={() => setExpanded((v) => !v)}
      />
    </>
  );
}

// ─── "Held via" — index ETFs that hold this security (reverse look-through) ───

// ─── exposure bars (country + asset category) ────────────────────────────────

function ExposureBars({ title, slices }: { title: string; slices: ExposureSlice[] }) {
  if (slices.length === 0) return null;
  const top = slices.slice(0, 6);
  return (
    <>
      <SectionHeader title={title} />
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {top.map((s) => {
          const w = Math.max(0, Math.min(100, s.pct));
          const label = title.toLowerCase().includes("countr") ? countryName(s.key) : s.key;
          return (
            <div key={s.key}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>{label}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 500 }}>
                  {s.pct.toFixed(1)}%
                </span>
              </div>
              <div
                style={{
                  height: 4,
                  borderRadius: 2,
                  background: "var(--line)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${w}%`,
                    background: "var(--accent)",
                    borderRadius: 2,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ─── dividends (compact, last-N + expand) ────────────────────────────────────

function DividendsSection({ items }: { items: UsDividendRow[] }) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const shown = expanded ? items.slice(0, 24) : items.slice(0, 6);
  return (
    <>
      <SectionHeader title="Dividends" />
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {shown.map((d) => (
          <div
            key={d.exDate}
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "5px 0",
              borderBottom: "1px solid var(--line-soft)",
              fontSize: 12.5,
            }}
          >
            <span style={{ color: "var(--ink-soft)" }}>
              {d.exDate}
              {d.special ? (
                <span style={{ color: "var(--muted)", marginLeft: 6 }}>special</span>
              ) : null}
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500 }}>
              ${d.cashAmount?.toFixed(4) ?? "—"}
            </span>
          </div>
        ))}
      </div>
      <ShowMoreToggle
        expanded={expanded}
        moreCount={Math.min(24, items.length) - 6}
        onToggle={() => setExpanded((v) => !v)}
      />
    </>
  );
}

// ─── the sheet ───────────────────────────────────────────────────────────────

export interface UsSecurityDetailSheetProps {
  /** Open when set; the bare US ticker. */
  symbol: string | null;
  /** The catalog row (passed from the list to skip a refetch on first paint). */
  security?: UsSecurity | null;
  onAskAdvisor?: (symbol: string) => void;
  /** Open a Thai fund's detail from a cross-link (optional; rows stay static if absent). */
  onOpenFund?: (projId: string) => void;
  /**
   * Hosted mode (DetailSheetHost): cross-links push onto the shared detail stack
   * instead of navigating in-sheet / handing off. When set, the header shows a
   * Back chevron (`onBack`) and the modal defers Back handling to the host.
   */
  onNavigate?: (entry: DetailEntry) => void;
  /** Hosted: pop one level (renders the header Back chevron when set). */
  onBack?: () => void;
  /** Render just the header+body content (no own Modal) — the host wraps it. */
  asContent?: boolean;
  onClose: () => void;
}

export function UsSecurityDetailSheet({
  symbol,
  security,
  onAskAdvisor,
  onOpenFund,
  onNavigate,
  onBack,
  asContent,
  onClose,
}: UsSecurityDetailSheetProps) {
  const open = symbol != null;
  // Internal navigation: a US→US cross-link (e.g. AAPL → VOO) swaps the viewed
  // symbol in place, with a Back affordance. Resets whenever the host reopens.
  const [viewSymbol, setViewSymbol] = useState<string | null>(symbol);
  useEffect(() => setViewSymbol(symbol), [symbol]);

  const active = viewSymbol ?? symbol;
  const navigated = active != null && active !== symbol;

  const { data: detail, isLoading } = useUsSecurityDetail(active);
  // Prefer the freshly-fetched catalog row; fall back to the one passed in.
  const sec = detail?.security ?? (active === symbol ? (security ?? null) : null);

  // Record a real view (feeds the demand half of the prewarm set + JIT-warms the
  // cold tail) for whichever symbol is in view. Once per symbol shown.
  useEffect(() => {
    if (!active) return;
    fetch(`/api/us-securities/${encodeURIComponent(active)}/view`, { method: "POST" }).catch(
      () => {},
    );
  }, [active]);

  const askAdvisor = (sym: string) => {
    if (onAskAdvisor) {
      onAskAdvisor(sym);
      return;
    }
    const prompt = `Tell me about ${sym} — what is it, and would it fit my portfolio?`;
    window.dispatchEvent(
      new CustomEvent("ai-prompt", {
        detail: {
          display: prompt,
          send: prompt,
          context: { screen: "funds", intent: "fund_lookup", subject: sym },
        },
      }),
    );
  };

  const holdingCount = detail?.holdings?.items.length ?? null;
  // Muted header meta beside the ticker: a stock leads with its sector (its key
  // classification, the analog of an ETF's TER chip), then the exchange trails.
  const metaLine = sec
    ? [sec.securityType === "stock" ? (sec.gicsSector ?? sec.industry) : null, sec.exchange]
        .filter(Boolean)
        .join(" · ")
    : "";

  // Cross-link navigation. Hosted (onNavigate set): push onto the shared detail
  // stack so the host swaps content within one modal. Standalone: swap the viewed
  // symbol in place (US→US), or hand off to the fund sheet (closing self).
  const openSymbol = onNavigate
    ? (s: string) => onNavigate({ kind: "us", symbol: s })
    : setViewSymbol;
  const openFund = onNavigate
    ? (id: string) => onNavigate({ kind: "fund", id })
    : onOpenFund
      ? (id: string) => {
          onOpenFund(id);
          onClose();
        }
      : undefined;

  // Hosted, the DetailSheetHost's Modal labels itself by "detail-sheet-title", so the
  // content header must use that id. Standalone, use an own id so two sheets (or a
  // standalone + the host) can't collide on one DOM id and break aria-labelledby.
  const titleId = asContent ? "detail-sheet-title" : "us-detail-title";
  const content = (
    <>
      <Modal.Header
        title={sec?.securityType === "etf" ? "ETF detail" : sec ? "Stock detail" : "Details"}
        id={titleId}
        back={onBack}
        action={
          active ? (
            <button
              type="button"
              className="icon-btn"
              title="Ask Advisor"
              aria-label={`Ask Advisor about ${active}`}
              onClick={() => askAdvisor(active)}
              style={{ marginTop: -4 }}
            >
              <Icon name="chat" size={15} />
            </button>
          ) : undefined
        }
      />
      <Modal.Body scrollResetKey={active}>
        {open && active && (
          <div>
            {navigated && !onNavigate && (
              <button
                type="button"
                onClick={() => setViewSymbol(symbol)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 12.5,
                  color: "var(--accent)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "0 0 8px",
                }}
              >
                <Icon name="arrow-left" size={14} /> Back to {symbol}
              </button>
            )}

            {/* Header mirrors the fund sheet: mono ticker, inline fee-toned TER
                chip (ETFs), muted type, name beneath, then the sector line. */}
            <div style={{ marginBottom: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 15,
                    fontWeight: 700,
                    letterSpacing: "0.02em",
                    color: "var(--ink)",
                  }}
                >
                  {active}
                </span>
                {sec?.securityType === "etf" && sec.ter != null && <TerHeaderBadge ter={sec.ter} />}
                {/* Stock: sector · exchange. ETF: exchange. The title names the type. */}
                {metaLine && (
                  <span style={{ fontSize: 11.5, color: "var(--muted)" }}>{metaLine}</span>
                )}
              </div>
              {sec && cleanUsSecurityName(sec.name) !== active && (
                <div style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 2 }}>
                  {cleanUsSecurityName(sec.name)}
                </div>
              )}
            </div>

            <UsSecurityChart symbol={active} />

            {sec && (
              <StatGrid
                security={sec}
                price={detail?.price ?? null}
                trailingYield={detail?.dividends.trailingYield ?? null}
                holdingCount={holdingCount}
              />
            )}

            {!detail && isLoading && <Skeleton height={120} style={{ marginTop: 16 }} />}

            {detail && sec && (
              <>
                <IndexChips names={detail.related.indexNames} isEtf={sec.securityType === "etf"} />
                {/* key={active}: the modal swaps content in place across drill-ins
                    (no remount, to avoid flicker), so these sections' local expand
                    state (Show all / show more) would otherwise carry over to the
                    next security. Keying on the active symbol resets them per view. */}
                <RelatedSection
                  key={`related-${active}`}
                  security={sec}
                  indexNames={detail.related.indexNames}
                  relatedEtfs={detail.relatedEtfs}
                  thaiFunds={detail.related.thaiFunds}
                  onOpenSymbol={openSymbol}
                  onOpenFund={openFund}
                />
                {detail.holdings && (
                  <>
                    <HoldingsSection
                      key={`holdings-${active}`}
                      items={detail.holdings.items}
                      asOf={detail.holdings.asOf}
                      onOpenSymbol={openSymbol}
                    />
                    <ExposureBars
                      title="Country exposure"
                      slices={detail.holdings.exposure.byCountry}
                    />
                    <ExposureBars
                      title="Asset breakdown"
                      slices={detail.holdings.exposure.byAssetCat}
                    />
                  </>
                )}
                <DividendsSection key={`div-${active}`} items={detail.dividends.items} />
              </>
            )}

            <div style={{ marginTop: 20, fontSize: 11.5, color: "var(--muted)", lineHeight: 1.5 }}>
              Prices are end-of-day in {sec?.currency ?? "USD"}, converted to THB wherever this
              security appears in your portfolio. Add it from your portfolio to track a position.
            </div>
          </div>
        )}
      </Modal.Body>
    </>
  );

  // Hosted (asContent): the DetailSheetHost owns one persistent Modal and swaps
  // this content in — no per-sheet Modal remount, so US→fund doesn't flicker.
  if (asContent) return content;
  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="detail"
      labelledBy={titleId}
      manageBack={!onNavigate}
    >
      {content}
    </Modal>
  );
}

// Inline TER chip beside the ticker — same treatment as the fund sheet's header
// (rounded-6 fee-toned chip), so a US ETF and a Thai fund read identically. US ter
// is a FRACTION (0.0003 = 0.03%).
function TerHeaderBadge({ ter }: { ter: number }) {
  const pct = ter * 100;
  const tone = terTone(pct);
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11.5,
        fontWeight: 600,
        color: tone.color,
        background: tone.bg,
        borderRadius: 6,
        padding: "2px 7px",
      }}
    >
      TER {pct.toFixed(2)}%
    </span>
  );
}
