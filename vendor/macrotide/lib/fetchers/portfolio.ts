"use client";

import type { Bucket } from "@/lib/db/queries/buckets";
import type { Earmark } from "@/lib/db/queries/earmarks";
import type { Holding as DbHolding } from "@/lib/db/queries/holdings";
import type { JournalEntry } from "@/lib/db/queries/journal";
import type { ModelPortfolio as DbModelPortfolio } from "@/lib/db/queries/models";
import type { Plan } from "@/lib/db/queries/plan";
import type { FundQuote } from "@/lib/db/queries/quotes";
import type { UsSecurityDetail } from "@/lib/db/queries/us-detail";
import type { IndicatorDef } from "@/lib/market/indicators";
import type { LookThrough } from "@/lib/portfolio/health";
import { invalidate, useResource } from "./swr";

export type { Bucket, DbHolding, DbModelPortfolio, FundQuote, JournalEntry, Plan };

export function useBuckets() {
  return useResource<Bucket[]>("/api/buckets");
}

/** Broker import config for the UI (display name + install/open/login URLs).
 *  `error` present (or no displayName) ⇒ no broker configured → hide the UI. */
export interface BrokerConfig {
  token?: string;
  displayName?: string;
  accountLabel?: string | null;
  installUrl?: string;
  openUrl?: string | null;
  loginUrl?: string | null;
  error?: string;
}

export function useBrokerConfig() {
  return useResource<BrokerConfig>("/api/import/broker/token");
}

/** One configured connector, for the multi-broker picker / grouped list. */
export interface BrokerConnectorInfo {
  id: string;
  /** The tag stamped on imported rows — matches a connection's `source`. */
  source: string;
  displayName: string;
  host: string;
  openUrl: string | null;
  loginUrl: string | null;
  installUrl: string;
}

/** All configured connectors (empty array ⇒ none configured). */
export function useBrokerConnectors() {
  return useResource<BrokerConnectorInfo[]>("/api/import/broker/connectors");
}

export function useHoldings(bucketId?: string) {
  const key = bucketId ? `/api/holdings?bucket=${encodeURIComponent(bucketId)}` : "/api/holdings";
  return useResource<DbHolding[]>(key);
}

export function useQuotes() {
  return useResource<FundQuote[]>("/api/quotes");
}

/** Cash earmarks (the per-account Investable | Reserved role + optional label, #149). */
export function useEarmarks() {
  return useResource<Earmark[]>("/api/earmarks");
}

/** Set (upsert) or clear a cash account's designation. Clearing (role investable + no
 *  label) DELETEs the row so the account is back to a plain investable default. */
export async function saveEarmark(input: {
  bucketId: string;
  ticker: string;
  role: "investable" | "reserved";
  amount: number | null;
  purpose?: string | null;
}): Promise<void> {
  const clear = input.role === "investable" && !(input.purpose ?? "").trim();
  const res = await fetch("/api/earmarks", {
    method: clear ? "DELETE" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      clear
        ? { bucketId: input.bucketId, ticker: input.ticker }
        : { ...input, purpose: (input.purpose ?? "").trim() || null },
    ),
  });
  if (!res.ok) throw new Error("Failed to save the cash purpose");
  invalidate("/api/earmarks");
}

export interface QuoteRef {
  source: string;
  ticker: string;
}

export interface RefreshedQuote extends QuoteRef {
  ok: boolean;
  price?: number;
  previousClose?: number;
  asOf?: string;
  error?: string;
}

export function useModelPortfolios() {
  return useResource<DbModelPortfolio[]>("/api/models");
}

export function usePlan() {
  return useResource<Plan>("/api/plan");
}

export function useJournalEntries() {
  return useResource<JournalEntry[]>("/api/journal");
}

export type SeriesRange = "1mo" | "3mo" | "6mo" | "1y" | "5y" | "max";

export interface PortfolioSeriesPoint {
  date: string;
  value: number;
}

export interface CashDecompResponse {
  cashValue: PortfolioSeriesPoint[];
  heldCashValue: PortfolioSeriesPoint[];
  reservedCashValue: PortfolioSeriesPoint[];
  cashContrib: PortfolioSeriesPoint[];
  reservedCashContrib: PortfolioSeriesPoint[];
}

export interface PortfolioSeriesResponse {
  aggregate: PortfolioSeriesPoint[];
  perBucket: Record<string, PortfolioSeriesPoint[]>;
  /** Cumulative external money in (the contribution line), same dates as aggregate. */
  netInvested: PortfolioSeriesPoint[];
  netInvestedByBucket: Record<string, PortfolioSeriesPoint[]>;
  /** Contribution line for the time-weighted return (full proceeds at a walk-away sale). */
  netInvestedForReturn: PortfolioSeriesPoint[];
  netInvestedForReturnByBucket: Record<string, PortfolioSeriesPoint[]>;
  /** In-transit settlement cash included in `aggregate` per date. */
  cash: PortfolioSeriesPoint[];
  /** Cash decomposition for the return-mode pill (#149) — value + contributions, all vs reserved. */
  cashDecomp: CashDecompResponse;
  cashDecompByBucket: Record<string, CashDecompResponse>;
  asOf: string | null;
  /** Inception (first ledger trade), window-independent — for hiding a 5Y range
   * that would just duplicate "All" on a younger book. */
  historyStart: string | null;
  /** True if the book holds a dividend-paying fund (price line drops payouts). */
  hasDistributingHolding: boolean;
  /** Latest plotted date partly valued from trade-implied prices (estimate caption). */
  estimatedThrough: string | null;
}

export function usePortfolioSeries(range: SeriesRange = "6mo") {
  // keepPreviousData: a range switch redraws from the old curve instead of
  // blanking the chart while the new range loads.
  return useResource<PortfolioSeriesResponse>(
    `/api/portfolios/series?range=${encodeURIComponent(range)}`,
    { keepPreviousData: true },
  );
}

export interface FundSeriesPoint {
  /** ISO date. */
  d: string;
  /** NAV per unit. */
  v: number;
  /** Fund total net assets (AUM) on this date; null for sources that omit it. */
  aum: number | null;
}

export interface FundSeriesResponse {
  series: FundSeriesPoint[];
  asOf: string | null;
}

/**
 * Daily NAV history for a single catalog fund, powering the fund-detail chart.
 * `projId` is the fund's SEC proj_id or its bare ticker (abbr_name); null while
 * the sheet is closed. Re-fetches when the range changes.
 */
export function useFundSeries(projId: string | null, range: SeriesRange = "1y") {
  // keepPreviousData: range switches keep the old curve on screen while the
  // new range loads (the fund stays the same; a fund change still resets).
  return useResource<FundSeriesResponse>(
    projId
      ? `/api/funds/${encodeURIComponent(projId)}/series?range=${encodeURIComponent(range)}`
      : null,
    { keepPreviousData: true },
  );
}

/**
 * Daily price history for one US stock / ETF, powering the US fund-detail chart.
 * `symbol` is the bare ticker (= `market:${SYMBOL}` cache key tail); null while
 * the sheet is closed. Prices are the provider's native USD close. Re-fetches
 * when the range changes; keeps the prior curve on a range switch.
 */
export function useUsSecuritySeries(symbol: string | null, range: SeriesRange = "1y") {
  return useResource<FundSeriesResponse>(
    symbol
      ? `/api/us-securities/${encodeURIComponent(symbol)}/series?range=${encodeURIComponent(range)}`
      : null,
    { keepPreviousData: true },
  );
}

/**
 * The full US detail payload (profile, ratios, TER, dividends, ETF holdings +
 * exposure, index cross-links) for one symbol. Cache-first: returns whatever is
 * stored now; the sheet also POSTs /view to JIT-warm the cold tail, and SWR
 * revalidation picks up the filled sections. Null while the sheet is closed.
 */
export function useUsSecurityDetail(symbol: string | null) {
  return useResource<UsSecurityDetail>(
    symbol ? `/api/us-securities/${encodeURIComponent(symbol)}` : null,
    { keepPreviousData: false },
  );
}

export interface HoldingSeriesPoint {
  /** ISO date. */
  date: string;
  /** THB. */
  value: number;
}

export interface HoldingSeriesResponse {
  /** Position market value per date (units × NAV × fx). */
  value: HoldingSeriesPoint[];
  /** Remaining cost basis per date (what you've put in, net of sells). */
  costBasis: HoldingSeriesPoint[];
  asOf: string | null;
  /** Latest date valued from trade-implied prices / cost-carry, or null. */
  estimatedThrough: string | null;
  missingFx: string[];
}

/**
 * Value-over-time for one holding (the user's actual position value + its
 * cost-basis line), powering the position-detail chart. `ticker` is null while
 * unresolved. Re-fetches when the range changes.
 */
export function useHoldingSeries(ticker: string | null, range: SeriesRange = "6mo") {
  return useResource<HoldingSeriesResponse>(
    ticker
      ? `/api/holdings/series?ticker=${encodeURIComponent(ticker)}&range=${encodeURIComponent(range)}`
      : null,
  );
}

export interface LookThroughResponse {
  lookThrough: LookThrough | null;
}

/**
 * Underlying-exposure look-through for the active scope ("all" or a bucket id),
 * fed into the client-side health computation so the diversification check
 * reflects the real underlying concentration. Needs market.db, hence a fetch.
 */
export function useLookThrough(scope: string) {
  const key =
    scope && scope !== "all"
      ? `/api/analysis/look-through?bucket=${encodeURIComponent(scope)}`
      : "/api/analysis/look-through";
  return useResource<LookThroughResponse>(key);
}

export interface MarketIndexResponse {
  ok: boolean;
  symbol: string;
  label: string;
  name: string;
  price?: number | null;
  d1Pct?: number;
  series?: { d: string; v: number }[];
  asOf?: string | null;
  error?: string;
}

export function useMarketIndices() {
  return useResource<MarketIndexResponse[]>("/api/market/indices");
}

export interface MarketIndicatorPrefs {
  /** The user's selected indicator symbols, in display order. */
  selected: string[];
  /** The full addable catalog (label/group/tier metadata). */
  catalog: IndicatorDef[];
}

export function useMarketIndicatorPrefs() {
  return useResource<MarketIndicatorPrefs>("/api/market/indicators");
}

export interface MarketNewsItem {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: string;
}

export interface MarketNewsResponse {
  items: MarketNewsItem[];
  failures: number;
  fetchedAt: string;
}

export function useMarketNews() {
  return useResource<MarketNewsResponse>("/api/market/news");
}

export interface BenchmarkSeriesResponse {
  key: string;
  label: string;
  series: { date: string; value: number }[];
}

/**
 * Real index series for the Portfolio "VS" overlay. Pass `null` (e.g. when the
 * selection is "none") to skip the request. `range` should match the chart's
 * current range so the benchmark spans the same window as the portfolio.
 */
export function useBenchmarkSeries(key: string | null, range: SeriesRange = "6mo") {
  const url = key
    ? `/api/market/benchmark?key=${encodeURIComponent(key)}&range=${encodeURIComponent(range)}`
    : null;
  return useResource<BenchmarkSeriesResponse>(url, { keepPreviousData: true });
}

// ─── Fee-creep ────────────────────────────────────────────────────────────────

export interface FeeCreepAlternative {
  projId: string;
  abbrName: string;
  englishName: string | null;
  assetClass: string | null;
  ter: number;
}

export interface FeeCreepFinding {
  heldTicker: string;
  heldName: string;
  heldTer: number;
  assetClass: string | null;
  alternatives: FeeCreepAlternative[];
  savingsPp: number;
  /** Deterministic suppression key (fee_creep:{heldTicker}); the route adds it. */
  key: string;
}

export function useFeeCreep() {
  return useResource<FeeCreepFinding[]>("/api/portfolio/fee-creep");
}

// ─── Action-item suppression (Archive / Not for me) ─────────────────────────────

export type ActionItemStateValue = "archived" | "not_for_me";

/** A hidden (archived / rejected) action item, as the Hidden-checks list shows it. */
export interface HiddenActionItem {
  id: number;
  itemType: string;
  itemKey: string;
  state: ActionItemStateValue;
  reason: string | null;
  snapshotSavingsPp: number | null;
  createdAt: string;
  updatedAt: string;
}

/** The current owner's hidden set — the source for the "Hidden checks (N)" surface. */
export function useHiddenActionItems() {
  return useResource<{ hidden: HiddenActionItem[] }>("/api/portfolio/action-items");
}

/**
 * Record an Archive / "Not for me" on a generated action item, then revalidate
 * the consuming feeds so the card disappears. `reason` (a chip key or free text)
 * and `savingsPp` (the magnitude the user saw, snapshotted server-side for the
 * resurface check) apply to a "Not for me"; both are optional. `topic` is the
 * human label used for the Journal feedback entry a rejection writes server-side.
 */
export async function mutateActionItemState(input: {
  itemType: "fee_creep" | "headline" | "rebalance";
  itemKey: string;
  state: ActionItemStateValue;
  reason?: string | null;
  savingsPp?: number | null;
  topic?: string | null;
}): Promise<void> {
  await fetch("/api/portfolio/action-items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  // Revalidate the feeds the suppression affects: the fee-creep list, the Hidden
  // set, and (for a rejection) the Journal feed the feedback entry lands in.
  await Promise.all([
    invalidate("/api/portfolio/fee-creep"),
    invalidate("/api/portfolio/action-items"),
    invalidate("/api/journal"),
  ]);
}

/** Restore a previously archived / rejected item (un-suppress). */
export async function restoreActionItem(itemKey: string): Promise<void> {
  await fetch(`/api/portfolio/action-items?key=${encodeURIComponent(itemKey)}`, {
    method: "DELETE",
  });
  await Promise.all([
    invalidate("/api/portfolio/fee-creep"),
    invalidate("/api/portfolio/action-items"),
  ]);
}
