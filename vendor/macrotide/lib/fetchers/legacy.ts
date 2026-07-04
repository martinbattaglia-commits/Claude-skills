"use client";

// Adapter-shaped fetchers — return the legacy `lib/static/types` view so
// existing screens can drop their mock imports without rewriting layout.

import { useEffect, useMemo, useRef } from "react";
import type { FundQuote } from "@/lib/db/queries/quotes";
import {
  adaptAggregate,
  adaptJournal,
  adaptModelPortfolios,
  adaptPortfolios,
} from "@/lib/portfolio/adapter";
import {
  type RefreshedQuote,
  type SeriesRange,
  useBuckets,
  useHoldings,
  useJournalEntries,
  useModelPortfolios,
  usePlan,
  usePortfolioSeries,
  useQuotes,
} from "./portfolio";
import { invalidate, useResource } from "./swr";

export function usePortfolioView(range: SeriesRange = "6mo") {
  const { data: buckets, error: e1 } = useBuckets();
  const { data: holdings, error: e2 } = useHoldings();
  const { data: quotes, error: e3 } = useQuotes();
  const { data: series, error: e4 } = usePortfolioSeries(range);

  // Live-refresh quotes for every held position. The server derives the refs
  // from the holdings metadata (`mine=1`), so this fires in parallel with the
  // holdings fetch instead of waterfalling behind it. Cache hits return from
  // the DB synchronously; misses trigger a network call through the provider
  // registry. Failures are tolerated — the cached quote (or avgCost fallback
  // inside the adapter) keeps the UI rendering.
  const { data: refreshed } = useResource<RefreshedQuote[]>("/api/quotes?refresh=1&mine=1");

  // The refs used to live in the SWR key, so an add/remove holding re-ran the
  // refresh automatically. The fixed `mine=1` key needs the nudge: when the
  // held set changes (not on first load), re-run so a newly added ticker gets
  // its first quote without a reload.
  const heldSig = useMemo(
    () =>
      holdings
        ?.map((h) => `${h.quoteSource}:${h.ticker}`)
        .sort()
        .join(",") ?? null,
    [holdings],
  );
  const prevHeldSig = useRef<string | null>(null);
  useEffect(() => {
    if (heldSig == null) return;
    if (prevHeldSig.current != null && prevHeldSig.current !== heldSig) {
      invalidate("/api/quotes?refresh=1&mine=1");
    }
    prevHeldSig.current = heldSig;
  }, [heldSig]);

  // The series endpoint reads nav_history, which the quotes refresh writes
  // to as a side-effect. On a cold cache (e.g. a fresh demo session) the
  // series query lands before history exists, so SWR caches an empty result.
  // Re-invalidate once a refresh response arrives that wrote at least one
  // new row, so the chart fills in without a manual page reload.
  const invalidatedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!refreshed || refreshed.length === 0) return;
    const okKey = refreshed
      .filter((r) => r.ok)
      .map((r) => `${r.source}:${r.ticker}@${r.asOf ?? ""}`)
      .sort()
      .join(",");
    if (!okKey || invalidatedKey.current === okKey) return;
    invalidatedKey.current = okKey;
    invalidate(/^\/api\/portfolios\/series/);
  }, [refreshed]);

  // Overlay refreshed values onto the cached quote list so the adapter
  // sees the freshest NAVs without needing a separate revalidation pass.
  const effectiveQuotes = useMemo<FundQuote[]>(() => {
    if (!quotes) return [];
    if (!refreshed || refreshed.length === 0) return quotes;
    const map = new Map(quotes.map((q) => [q.ticker, q]));
    for (const r of refreshed) {
      if (!r.ok || r.price == null) continue;
      const key = `${r.source}:${r.ticker}`;
      const prev = map.get(key);
      map.set(key, {
        ticker: key,
        nav: r.price,
        d1Pct: prev?.d1Pct ?? null,
        ytdPct: prev?.ytdPct ?? null,
        y1Pct: prev?.y1Pct ?? null,
        updatedAt: r.asOf ?? new Date().toISOString(),
        deepestRange: prev?.deepestRange ?? null,
      });
    }
    return [...map.values()];
  }, [quotes, refreshed]);

  const portfolios = useMemo(
    () =>
      buckets && holdings
        ? adaptPortfolios(buckets, holdings, effectiveQuotes, series ?? undefined)
        : null,
    [buckets, holdings, effectiveQuotes, series],
  );

  const aggregate = useMemo(
    () =>
      portfolios
        ? adaptAggregate(
            portfolios,
            series?.aggregate,
            series?.netInvested,
            series?.cashDecomp,
            series?.netInvestedForReturn,
          )
        : null,
    [portfolios, series],
  );

  return {
    portfolios,
    aggregate,
    // Portfolio-wide: does the book hold a dividend-paying fund? Used by the
    // performance-vs-index disclaimer. Defaults false until the series loads.
    hasDistributingHolding: series?.hasDistributingHolding ?? false,
    // Latest date partly valued from trade-implied prices — drives the chart's
    // estimate caption. Null = every plotted point is cache-priced.
    estimatedThrough: series?.estimatedThrough ?? null,
    // In-transit settlement cash per date (aggregate) for the tooltip note.
    cashSeries: series?.cash ?? null,
    // Inception date (first ledger trade), window-independent — lets the UI hide
    // a 5Y range that would just duplicate "All" on a younger book.
    historyStart: series?.historyStart ?? null,
    // Hold the loading skeleton until the chart series resolves too — otherwise
    // buckets/holdings/quotes land first and the chart renders an empty
    // "NO HISTORY YET" until `series` arrives a beat later (a flash that a cold
    // cache stretches into seconds). `e4` lets a series-fetch error fall through
    // to the (empty) chart instead of spinning the skeleton forever.
    isLoading: !buckets || !holdings || !quotes || (!series && !e4),
    error: e1 ?? e2 ?? e3 ?? e4,
  };
}

export function useModelPortfoliosView() {
  const { data, error } = useModelPortfolios();
  const models = useMemo(() => (data ? adaptModelPortfolios(data) : null), [data]);
  return { models, isLoading: !data, error };
}

export function useSelectedModelId(): string | null {
  const { data: plan } = usePlan();
  return plan?.selectedModelId ?? null;
}

export function useJournalView() {
  const { data, error } = useJournalEntries();
  const journal = useMemo(() => (data ? adaptJournal(data) : null), [data]);
  return { journal, isLoading: !data, error };
}
