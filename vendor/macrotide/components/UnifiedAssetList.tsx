"use client";

// UnifiedAssetList — the single cross-asset search list backing Explore's "All"
// tab: one bar over Thai funds + US stocks & ETFs. Two modes:
//   • Searching → a flat relevance list across all types (GET /api/search), so a
//     query can be compared wrapper-to-wrapper (Thai feeder vs US ETF vs index).
//   • Idle → curated shelves (GET /api/explore/shelves), each ranked by its own
//     honest signal, instead of one blended-popularity list.
// A row opens the right detail — Thai funds via the fund sheet (onOpenFund), US
// securities via the US detail sheet here.

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { AssetResultRow, AssetTypeBadge } from "@/components/AssetResultRow";
import { ExploreFilterBar } from "@/components/ExploreFilterBar";
import { UsSecurityDetailSheet } from "@/components/UsSecurityDetailSheet";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { TerBadge } from "@/components/ui/TerBadge";
import type { AssetSearchItem, AssetSearchPage } from "@/lib/db/queries/asset-search";
import type { ExploreShelf, ShelfTab } from "@/lib/db/queries/explore-shelves";
import { useResource } from "@/lib/fetchers/swr";
import { useOptionalDetailStack } from "@/lib/nav/detail-stack";
import { useExploreQuery } from "@/lib/stores/explore-ui";

const PAGE = 40;

/** The row's TER metric — the shared label+chip. US ter is a fraction (0.0003);
 *  Thai a percent (1.2), so US is scaled to percent before display. */
function TerMetric({ kind, ter }: { kind: AssetSearchItem["kind"]; ter: number | null }) {
  if (ter == null || ter <= 0) return null;
  return <TerBadge pct={kind === "thai_fund" ? ter : ter * 100} />;
}

export interface UnifiedAssetListProps {
  /** Rendered as the first element of the filter row (the asset-type segment). */
  leadingFilter?: ReactNode;
  /** Open a Thai fund's detail (held at the screen level alongside this list). */
  /** Standalone fallback for a Thai-fund tap (unused inside the Explore stack host). */
  onOpenFund?: (projId: string) => void;
  /** "See all" on an idle shelf switches the Explore asset-type tab. */
  onSeeAll?: (tab: ShelfTab) => void;
}

export function UnifiedAssetList({ leadingFilter, onOpenFund, onSeeAll }: UnifiedAssetListProps) {
  // Shared across asset-type tabs + persists across screen unmount (Explore store).
  const [queryInput, setQueryInput] = useExploreQuery();
  const [query, setQuery] = useState(queryInput);
  const [usDetail, setUsDetail] = useState<string | null>(null);
  // Inside the Explore screen a shared detail stack hosts every overlay (modal
  // as page); standalone, fall back to a local US sheet + the onOpenFund handoff.
  const detailStack = useOptionalDetailStack();

  useEffect(() => {
    const t = setTimeout(() => setQuery(queryInput), 280);
    return () => clearTimeout(t);
  }, [queryInput]);

  const trimmed = query.trim();
  const idle = trimmed.length === 0;

  const searchUrl = useMemo(
    () => `/api/search?type=all&limit=${PAGE}&query=${encodeURIComponent(trimmed)}`,
    [trimmed],
  );

  // Only one mode fetches at a time — a null key skips the other request.
  const { data, isLoading } = useResource<AssetSearchPage>(idle ? null : searchUrl, {
    keepPreviousData: true,
  });
  const { data: shelfData, isLoading: shelvesLoading } = useResource<{ shelves: ExploreShelf[] }>(
    idle ? "/api/explore/shelves" : null,
  );

  const items = data?.items ?? [];
  const shelves = shelfData?.shelves ?? [];

  const open = (item: AssetSearchItem) => {
    // Open the exact share CLASS the user tapped (like the Thai fund tab), not the
    // parent fund — the detail route resolves a class ticker, and passing projId
    // would default to some other class.
    if (detailStack) {
      detailStack.push(
        item.kind === "thai_fund"
          ? { kind: "fund", id: item.ticker }
          : { kind: "us", symbol: item.ticker },
      );
    } else if (item.kind === "thai_fund") {
      onOpenFund?.(item.ticker);
    } else {
      setUsDetail(item.ticker);
    }
  };

  // The idle shelves are each type-homogeneous ("Thai index funds", "Index ETFs",
  // "Popular US stocks"), so the shelf title already conveys the type — the per-row
  // Fund/ETF/Stock badge is redundant there. Search mixes types, so it's shown.
  const row = (it: AssetSearchItem, index: number, showBadge: boolean) => (
    <AssetResultRow
      key={`${it.kind}-${it.ticker}-${it.projId ?? ""}`}
      index={index}
      ticker={it.ticker}
      badge={showBadge ? <AssetTypeBadge kind={it.kind} /> : undefined}
      category={it.category ?? undefined}
      name={it.name}
      exchange={it.exchange ?? undefined}
      metric={<TerMetric kind={it.kind} ter={it.ter} />}
      onClick={() => open(it)}
    />
  );

  return (
    <>
      {!detailStack && (
        <UsSecurityDetailSheet
          symbol={usDetail}
          onOpenFund={onOpenFund}
          onClose={() => setUsDetail(null)}
        />
      )}
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <ExploreFilterBar
          placeholder="Search funds, ETFs, and stocks… (e.g. S&P 500, AAPL, gold)"
          value={queryInput}
          onChange={setQueryInput}
        >
          {leadingFilter}
        </ExploreFilterBar>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {idle ? (
            shelvesLoading && shelves.length === 0 ? (
              <SkeletonRows rows={8} />
            ) : (
              shelves.map((shelf) => (
                <section key={shelf.key}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "14px 14px 4px",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        color: "var(--muted)",
                      }}
                    >
                      {shelf.title}
                    </span>
                    {onSeeAll && (
                      <button
                        type="button"
                        onClick={() => onSeeAll(shelf.seeAll)}
                        style={{
                          flexShrink: 0,
                          background: "none",
                          border: "none",
                          padding: "2px 4px",
                          fontSize: 11.5,
                          color: "var(--accent-ink)",
                          cursor: "pointer",
                        }}
                      >
                        See all →
                      </button>
                    )}
                  </div>
                  {shelf.items.map((it, i) => row(it, i + 1, false))}
                </section>
              ))
            )
          ) : isLoading && items.length === 0 ? (
            <SkeletonRows rows={8} />
          ) : items.length === 0 ? (
            <div
              style={{
                padding: "32px 14px",
                textAlign: "center",
                color: "var(--muted)",
                fontSize: 13,
              }}
            >
              No matches. Try a symbol, fund name, or an index like "S&P 500".
            </div>
          ) : (
            items.map((it, i) => row(it, i + 1, true))
          )}
        </div>
      </div>
    </>
  );
}
