"use client";

// UsSecuritySelect — the Explore screener for US stocks & ETFs, the US-market
// sibling of FundSelect (Thai funds). Search by symbol/name, filter by type,
// sort, page through the catalog, and open a detail sheet with a price chart.
// Backed by GET /api/us-securities over the us_securities catalog.

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AssetResultRow } from "@/components/AssetResultRow";
import { ExploreFilterBar } from "@/components/ExploreFilterBar";
import { UsSecurityDetailSheet } from "@/components/UsSecurityDetailSheet";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { TerBadge } from "@/components/ui/TerBadge";
import type { UsSecurity } from "@/lib/db/queries/us-securities";
import { prefetchResource, useResource } from "@/lib/fetchers/swr";
import { cleanUsSecurityName } from "@/lib/market/us-security-name";
import { useOptionalDetailStack } from "@/lib/nav/detail-stack";
import { useExploreQuery } from "@/lib/stores/explore-ui";

type TypeFilter = "" | "stock" | "etf";
type SortKey = "symbol" | "name" | "popularity";

// Pagination mirrors the Thai fund screener (FundSelect): the first AUTO_LOAD_MAX
// rows stream in click-free in AUTO_STEP chunks (the common browse stays in the
// cheap top), then the long tail is opt-in via "Load more" (CLICK_STEP each) to
// cap DOM growth and keep keyboard/screen-reader control.
const AUTO_STEP = 50;
const AUTO_LOAD_MAX = 100;
const CLICK_STEP = 100;
// How many visible rows to warm on render so the first click paints instantly.
const PREFETCH_ROWS = 8;

// The detail chart's default-range series URL — MUST match `useUsSecuritySeries`
// (range "1y"), so the prefetch and the detail mount share one SWR cache key.
const seriesUrl = (symbol: string) =>
  `/api/us-securities/${encodeURIComponent(symbol)}/series?range=1y`;

interface UsSecuritiesPage {
  items: UsSecurity[];
  total: number;
}

/** Compact USD for market cap: $4.7T, $1.2B, $740M. */
function fmtCompactUsd(n: number | null): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  const a = Math.abs(n);
  if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** The trailing metric: an ETF's TER (fee-colored) or a stock's market cap. */
function UsMetric({ s }: { s: UsSecurity }) {
  if (s.securityType === "etf") {
    if (s.ter == null) return null;
    return <TerBadge pct={s.ter * 100} />;
  }
  const cap = fmtCompactUsd(s.marketCap);
  return cap ? (
    <span
      style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--muted)", flexShrink: 0 }}
    >
      {cap}
    </span>
  ) : null;
}

export interface UsSecuritySelectProps {
  /** Fixed type filter — the Explore "US ETFs" / "US stocks" segment owns this. */
  initialType?: TypeFilter;
  /** Rendered as the first element of the filter row (the asset-type segment). */
  leadingFilter?: ReactNode;
  /** Open a Thai fund's detail from a US cross-link. */
  onOpenFund?: (projId: string) => void;
}

export function UsSecuritySelect({
  initialType = "",
  leadingFilter,
  onOpenFund,
}: UsSecuritySelectProps = {}) {
  // Shared across asset-type tabs + persists across screen unmount (Explore store).
  const [queryInput, setQueryInput] = useExploreQuery();
  const [query, setQuery] = useState(queryInput);
  // Type is fixed by the asset-type segment (etf/stock tab); idle browse is
  // most-traded-first (alphabetical isn't useful), so default sort = popularity.
  const [type] = useState<TypeFilter>(initialType);
  const [sort] = useState<SortKey>("popularity");

  const placeholder =
    initialType === "etf"
      ? "Search US ETFs by name or symbol… (e.g. VOO, Vanguard)"
      : initialType === "stock"
        ? "Search US stocks by name or symbol… (e.g. AAPL, Apple)"
        : "Search US stocks & ETFs by symbol or name… (e.g. AAPL, Vanguard)";
  const [limit, setLimit] = useState(AUTO_STEP);
  const [detail, setDetail] = useState<UsSecurity | null>(null);
  // Inside Explore, route detail opens through the shared stack (modal-as-page);
  // standalone, use the local sheet.
  const detailStack = useOptionalDetailStack();
  const openDetail = (s: UsSecurity) =>
    detailStack ? detailStack.push({ kind: "us", symbol: s.symbol }) : setDetail(s);

  // Debounce the search query so we don't fire on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(queryInput), 280);
    return () => clearTimeout(t);
  }, [queryInput]);

  // A new filter/search is a new result set — start back at page one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: AUTO_STEP is a module constant; we reset only when the query shape changes.
  useEffect(() => {
    setLimit(AUTO_STEP);
  }, [query, type, sort]);

  const url = useMemo(() => {
    const p = new URLSearchParams();
    if (query.trim()) p.set("query", query.trim());
    if (type) p.set("type", type);
    p.set("sort", sort);
    p.set("limit", String(limit));
    return `/api/us-securities?${p.toString()}`;
  }, [query, type, sort, limit]);

  const { data, isLoading } = useResource<UsSecuritiesPage>(url, { keepPreviousData: true });
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const hasResults = items.length > 0;
  const canLoadMore = items.length < total;
  // Auto-stream up to AUTO_LOAD_MAX rows click-free: once the current page has
  // arrived (items caught up to the requested limit), bump the limit another
  // AUTO_STEP until the cap. keepPreviousData keeps the list stable between bumps;
  // past the cap the tail is opt-in via "Load more".
  const autoLoading = canLoadMore && limit < AUTO_LOAD_MAX;
  useEffect(() => {
    if (autoLoading && items.length >= limit) {
      setLimit((l) => Math.min(AUTO_LOAD_MAX, l + AUTO_STEP));
    }
  }, [autoLoading, items.length, limit]);

  // Warm row charts so opening the detail sheet paints from cache: the top
  // PREFETCH_ROWS on render, plus any row on hover/focus. Dedup so each symbol is
  // warmed once per session, even as the user filters or scrolls.
  const prefetched = useRef(new Set<string>());
  const prefetchSeries = (symbol: string) => {
    if (prefetched.current.has(symbol)) return;
    prefetched.current.add(symbol);
    prefetchResource(seriesUrl(symbol));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: warm the top N whenever the visible set changes; prefetchSeries dedups.
  useEffect(() => {
    for (const s of items.slice(0, PREFETCH_ROWS)) prefetchSeries(s.symbol);
  }, [items]);

  return (
    <>
      {!detailStack && (
        <UsSecurityDetailSheet
          symbol={detail?.symbol ?? null}
          security={detail}
          onOpenFund={onOpenFund}
          onClose={() => setDetail(null)}
        />
      )}
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <ExploreFilterBar placeholder={placeholder} value={queryInput} onChange={setQueryInput}>
          {leadingFilter}
        </ExploreFilterBar>

        <div style={{ flex: 1, overflowY: "auto", minHeight: 360 }}>
          {!hasResults ? (
            isLoading ? (
              <SkeletonRows rows={6} />
            ) : (
              <div
                style={{
                  padding: "28px 16px",
                  textAlign: "center",
                  color: "var(--muted)",
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                <div style={{ marginBottom: 6 }}>No US securities found</div>
                <div style={{ fontSize: 12 }}>
                  {query
                    ? "Try a shorter search term, or another tab."
                    : "The catalog is populated by the nightly Nasdaq directory refresh."}
                </div>
              </div>
            )
          ) : (
            <>
              {items.map((s, i) => (
                <AssetResultRow
                  key={s.symbol}
                  index={i + 1}
                  ticker={s.symbol}
                  // GICS sector on line 1 (SIC `industry` is never shown), the
                  // exchange on line 2 with the name.
                  category={s.gicsSector ?? undefined}
                  name={cleanUsSecurityName(s.name)}
                  exchange={s.exchange ?? undefined}
                  metric={<UsMetric s={s} />}
                  onClick={() => openDetail(s)}
                  onIntent={() => prefetchSeries(s.symbol)}
                />
              ))}
              {autoLoading && <SkeletonRows rows={3} />}
              {canLoadMore && !autoLoading && (
                <div style={{ padding: "12px 14px 18px", textAlign: "center" }}>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--muted)",
                      fontFamily: "var(--font-mono)",
                      letterSpacing: "0.04em",
                      marginBottom: 8,
                    }}
                  >
                    {items.length.toLocaleString()} of {total.toLocaleString()}
                  </div>
                  <button
                    type="button"
                    onClick={() => setLimit((l) => l + CLICK_STEP)}
                    style={{
                      width: "100%",
                      padding: "10px 16px",
                      borderRadius: 8,
                      border: "1px solid var(--line)",
                      background: "var(--surface)",
                      color: "var(--text)",
                      fontSize: 12.5,
                      fontWeight: 600,
                      letterSpacing: "0.02em",
                      cursor: "pointer",
                    }}
                  >
                    Load {Math.min(CLICK_STEP, total - items.length)} more
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
