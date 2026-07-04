// Shapes DB rows into the legacy `lib/static/types` view that the existing
// screens render against. Lets us swap the data source without rewriting UI.

import type { Bucket } from "@/lib/db/queries/buckets";
import type { Holding as DbHolding } from "@/lib/db/queries/holdings";
import type { JournalEntry } from "@/lib/db/queries/journal";
import type { ModelPortfolio as DbModelPortfolio } from "@/lib/db/queries/models";
import type { FundQuote } from "@/lib/db/queries/quotes";
import { fmtRelativeDate } from "@/lib/format";
import { quoteCacheKey } from "@/lib/market/sources";
import type {
  AggregatePortfolio,
  AssetClass,
  CashDecomp,
  Holding,
  ModelPortfolio,
  Note,
  Portfolio,
  PortfolioType,
  ReadingItem,
  RiskBand,
  SeriesPoint,
  UserJournal,
} from "@/lib/static/types";

const DEFAULT_RISK: RiskBand = "balanced";
const ASSET_CLASSES: AssetClass[] = ["equity", "bond", "mixed", "alternative", "cash"];

function quotesByTicker(quotes: FundQuote[]): Map<string, FundQuote> {
  // fund_quotes.ticker is the combined cache key "source:ticker" — see
  // lib/market/cache.ts. We also index by the bare ticker so older callers
  // that pass plain symbols still get a hit on the unique entry.
  const m = new Map<string, FundQuote>();
  for (const q of quotes) {
    m.set(q.ticker, q);
    const idx = q.ticker.indexOf(":");
    if (idx > 0) {
      const bare = q.ticker.slice(idx + 1);
      if (!m.has(bare)) m.set(bare, q);
    }
  }
  return m;
}

function holdingFromDb(h: DbHolding, quotes: Map<string, FundQuote>): Holding {
  // Prefer the source-namespaced lookup. Falls back to the bare ticker for
  // backward compatibility with cache entries written before quoteSource
  // existed.
  const q = quotes.get(quoteCacheKey(h.quoteSource, h.ticker)) ?? quotes.get(h.ticker);
  // Cash is priced at 1.0 in its own currency (no NAV). Like every other foreign
  // holding in this snapshot, its native value is summed without FX conversion —
  // the FX-aware figure is the All-chart series (getPortfolioSeries). THB cash,
  // the common case, is exact either way.
  const nav = h.quoteSource === "cash" ? 1 : (q?.nav ?? h.avgCost ?? 0);
  const value = h.units * nav;
  // Cost basis is unknown for an uncosted opening/snapshot (ADR 0004). Keep
  // `cost` at 0 then, but flag it so gain figures degrade rather than mislead.
  const costKnown = h.avgCost != null;
  const cost = (h.avgCost ?? 0) * h.units;
  const assetClass = ASSET_CLASSES.includes(h.assetClass as AssetClass)
    ? (h.assetClass as AssetClass)
    : "unknown";
  return {
    id: h.id,
    bucketId: h.bucketId,
    ticker: h.ticker,
    thai: h.thaiName ?? undefined,
    name: h.englishName,
    category: h.category ?? "",
    class: assetClass,
    region: h.region ?? "",
    value,
    cost,
    costKnown,
    units: h.units,
    nav,
    d1: q?.d1Pct ?? 0,
    ytd: q?.ytdPct ?? 0,
    y1: q?.y1Pct ?? 0,
    ter: h.ter ?? null,
    source: h.source ?? "",
    quoteSource: h.quoteSource,
    instrumentType: h.instrumentType ?? null,
    exposureRegion: h.exposureRegion ?? null,
    riskSpectrum: h.riskSpectrum ?? null,
    syncedBroker: h.syncedBroker ?? null,
  };
}

function weightedPct(holdings: Holding[], total: number, key: "d1" | "ytd" | "y1"): number {
  if (total <= 0) return 0;
  return holdings.reduce((s, h) => s + (h.value / total) * h[key], 0);
}

// Legacy Portfolio "type" enum isn't stored — infer it from the SSF type label
// so the UI's badge logic keeps working. Everything else falls back to "free".
function inferPortfolioType(typeLabel: string | null): PortfolioType {
  if (!typeLabel) return "free";
  const t = typeLabel.toLowerCase();
  if (t.includes("ssf") || t.includes("rmf") || t.includes("tax")) return "tax-locked";
  if (t.includes("experiment")) return "experiment";
  return "free";
}

// Convert "YYYY-MM-DD" → "MMM DD" (e.g. "2026-05-22" → "May 22"). Used by the
// hand-rolled PerfChart's axis labels.
export function formatSeriesDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// "YYYY-MM-DD" → "MMM 'yy" (e.g. "2026-05-22" → "May '26"). The prominent
// month-boundary label on the interactive chart's grouped x-axis.
export function formatMonthYear(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const mon = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return `${mon} '${String(d.getUTCFullYear()).slice(-2)}`;
}

// "YYYY-MM-DD" → bare day-of-month (e.g. "2026-05-22" → "22"). The muted
// in-between ticks under a month label on the grouped x-axis.
export function formatDay(iso: string): string {
  return String(new Date(`${iso}T00:00:00Z`).getUTCDate());
}

// "YYYY-MM-DD" → "MMM D, YYYY" (e.g. "May 22, 2026"). The full, unambiguous
// date shown in the chart's hover tooltip.
export function formatTooltipDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Standard height (px) for the interactive value/NAV time-series line charts
// (the portfolio balance chart, a position's value chart, a fund's NAV/AUM
// chart). One number so every NavChart — and its loading skeleton — sizes the
// same. Lives here (a recharts-free module) so screens can import it without
// pulling the lazy-loaded chart bundle. Donuts/bars keep their own height.
export const NAV_CHART_HEIGHT = 160;

// Pick up to `count` evenly-spaced points for x-axis ticks, INSET from both
// edges — each tick sits at the centre of its 1/count slot, so there are
// half-slot margins on each side. No label lands on the chart boundary (so
// edge labels never clip) and the gaps read uniformly. Index-spacing — not
// calendar — so gaps mirror the data's own (trading) days. Returns the points'
// ISO `d` values; the chart hands these to recharts as an explicit `ticks` list
// so each tick can compare against its neighbour for month grouping.
export function pickAxisTicks(data: readonly { d: string }[], count = 6): string[] {
  const n = data.length;
  if (n === 0) return [];
  const c = Math.min(count, n);
  return Array.from(
    { length: c },
    (_, k) => data[Math.min(n - 1, Math.floor(((k + 0.5) / c) * n))].d,
  );
}

// Cumulative % return across a series: first finite value → last finite value.
// Null when there aren't two finite points or the start is zero (can't divide).
export function seriesReturnPct(series: SeriesPoint[]): number | null {
  const finite = series.filter((p) => Number.isFinite(p.v));
  if (finite.length < 2) return null;
  const start = finite[0].v;
  if (!start) return null;
  return (finite[finite.length - 1].v / start - 1) * 100;
}

function toSeriesPoints(raw: { date: string; value: number }[] | undefined): SeriesPoint[] {
  if (!raw || raw.length === 0) return [];
  // `d` carries the raw ISO date; the chart formats axis/tooltip labels from it.
  return raw.map((p) => ({ d: p.date, v: p.value }));
}

// Server cash-decomposition shape ({date,value} arrays) → client ({d,v}).
interface RawCashDecomp {
  cashValue: { date: string; value: number }[];
  heldCashValue: { date: string; value: number }[];
  reservedCashValue: { date: string; value: number }[];
  cashContrib: { date: string; value: number }[];
  reservedCashContrib: { date: string; value: number }[];
}

function toCashDecomp(raw: RawCashDecomp | undefined): CashDecomp | undefined {
  if (!raw) return undefined;
  return {
    cashValue: toSeriesPoints(raw.cashValue),
    heldCashValue: toSeriesPoints(raw.heldCashValue),
    reservedCashValue: toSeriesPoints(raw.reservedCashValue),
    cashContrib: toSeriesPoints(raw.cashContrib),
    reservedCashContrib: toSeriesPoints(raw.reservedCashContrib),
  };
}

// Look back `days` calendar days from the latest point and return the % delta
// vs the closest point on or before that target date. Falls back to the first
// point if the series doesn't reach that far back.
function lookbackPct(raw: { date: string; value: number }[] | undefined, days: number): number {
  if (!raw || raw.length < 2) return 0;
  const latest = raw[raw.length - 1];
  if (!latest.value) return 0;
  const target = new Date(`${latest.date}T00:00:00Z`);
  target.setUTCDate(target.getUTCDate() - days);
  const targetIso = target.toISOString().slice(0, 10);
  let start = raw[0];
  for (const p of raw) {
    if (p.date <= targetIso) start = p;
    else break;
  }
  if (!start.value) return 0;
  return ((latest.value - start.value) / start.value) * 100;
}

/**
 * The latest valued date in a portfolio's value series, formatted "24 Jun 2026".
 * This is the portfolio's NAV-as-of date — it advances whenever fresh NAV lands,
 * NOT when the portfolio row is edited. NAV dates are end-of-day calendar dates,
 * so no clock time or timezone is shown. Empty when there's no priced history.
 */
function formatAsOf(rawSeries?: { date: string; value: number }[]): string {
  const date = rawSeries?.at(-1)?.date;
  if (!date) return "";
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function adaptBucket(
  bucket: Bucket,
  bucketHoldings: DbHolding[],
  quotes: Map<string, FundQuote>,
  rawSeries?: { date: string; value: number }[],
  rawNetInvested?: { date: string; value: number }[],
  rawCashDecomp?: RawCashDecomp,
  rawNetInvestedForReturn?: { date: string; value: number }[],
): Portfolio {
  const holdings = bucketHoldings.map((h) => holdingFromDb(h, quotes));
  const totalValue = holdings.reduce((s, h) => s + h.value, 0);
  const initialInvestment = holdings.reduce((s, h) => s + h.cost, 0);

  return {
    id: bucket.id,
    name: bucket.name,
    icon: bucket.icon ?? "",
    type: inferPortfolioType(bucket.typeLabel),
    typeLabel: bucket.typeLabel ?? "",
    color: bucket.color ?? "var(--accent)",
    notes: bucket.notes ?? "",
    targetModelId: bucket.targetModelId ?? null,
    initialInvestment,
    totalValue,
    asOf: formatAsOf(rawSeries),
    brokerage: bucket.brokerage,
    perfPct: {
      d7: lookbackPct(rawSeries, 7),
      d30: lookbackPct(rawSeries, 30),
      ytd: weightedPct(holdings, totalValue, "ytd"),
      y1: weightedPct(holdings, totalValue, "y1"),
    },
    series: toSeriesPoints(rawSeries),
    netInvested: toSeriesPoints(rawNetInvested),
    netInvestedForReturn: toSeriesPoints(rawNetInvestedForReturn),
    cashDecomp: toCashDecomp(rawCashDecomp),
    holdings,
  };
}

export interface SeriesBundle {
  aggregate: { date: string; value: number }[];
  perBucket: Record<string, { date: string; value: number }[]>;
  netInvested?: { date: string; value: number }[];
  netInvestedByBucket?: Record<string, { date: string; value: number }[]>;
  netInvestedForReturn?: { date: string; value: number }[];
  netInvestedForReturnByBucket?: Record<string, { date: string; value: number }[]>;
  cashDecomp?: RawCashDecomp;
  cashDecompByBucket?: Record<string, RawCashDecomp>;
}

export function adaptPortfolios(
  buckets: Bucket[],
  holdings: DbHolding[],
  quotes: FundQuote[],
  series?: SeriesBundle,
): Portfolio[] {
  const byTicker = quotesByTicker(quotes);
  return buckets.map((b) =>
    adaptBucket(
      b,
      holdings.filter((h) => h.bucketId === b.id),
      byTicker,
      series?.perBucket[b.id],
      series?.netInvestedByBucket?.[b.id],
      series?.cashDecompByBucket?.[b.id],
      series?.netInvestedForReturnByBucket?.[b.id],
    ),
  );
}

export function adaptAggregate(
  portfolios: Portfolio[],
  rawSeries?: { date: string; value: number }[],
  rawNetInvested?: { date: string; value: number }[],
  rawCashDecomp?: RawCashDecomp,
  rawNetInvestedForReturn?: { date: string; value: number }[],
): AggregatePortfolio {
  const allHoldings = portfolios.flatMap((p) => p.holdings);
  const totalValue = portfolios.reduce((s, p) => s + p.totalValue, 0);
  const initialInvestment = portfolios.reduce((s, p) => s + p.initialInvestment, 0);
  return {
    totalValue,
    baseCurrency: "THB",
    initialInvestment,
    perfPct: {
      d7: lookbackPct(rawSeries, 7),
      d30: lookbackPct(rawSeries, 30),
      ytd: weightedPct(allHoldings, totalValue, "ytd"),
      y1: weightedPct(allHoldings, totalValue, "y1"),
    },
    asOf: formatAsOf(rawSeries),
    brokerage: portfolios[0]?.brokerage ?? "",
    holdings: allHoldings,
    series: toSeriesPoints(rawSeries),
    netInvested: toSeriesPoints(rawNetInvested),
    netInvestedForReturn: toSeriesPoints(rawNetInvestedForReturn),
    cashDecomp: toCashDecomp(rawCashDecomp),
    target: { equity: 70, bond: 20, alternative: 7, cash: 3 },
  };
}

// Mirrors the server's rangeStartDate (lib/db/queries/series.ts) so the client
// can tell whether a window CLIPPED history: a series whose first point sits on
// the window start carries pre-window state, so "change this period" must be
// rebased against that first point; a series starting later was born inside the
// window and already reads as change-from-zero.
const RANGE_DAYS: Record<string, number> = {
  "1mo": 31,
  "3mo": 92,
  "6mo": 183,
  "1y": 366,
  "5y": 5 * 366,
};

/** The window's start date for a SeriesRange, or null for "max" (never clips). */
export function windowStartIso(range: string): string | null {
  const days = RANGE_DAYS[range];
  if (!days) return null;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function adaptModelPortfolio(m: DbModelPortfolio): ModelPortfolio {
  return {
    id: m.id,
    name: m.name,
    tagline: m.tagline ?? "",
    blurb: m.blurb ?? "",
    mix: m.allocation ?? [],
    expectedReturn: m.expectedReturn ?? 0,
    expectedVol: m.expectedVolatility ?? 0,
    ter: m.ter ?? 0,
    horizon: m.horizon ?? "",
    risk: (m.risk as RiskBand | null) ?? DEFAULT_RISK,
    pros: m.pros ?? [],
    cons: m.cons ?? [],
    isCustom: !m.builtIn,
  };
}

export function adaptModelPortfolios(models: DbModelPortfolio[]): ModelPortfolio[] {
  return models.map(adaptModelPortfolio);
}

// Reverse: legacy ModelPortfolio → DB insert payload (id + createdAt set server-side
// or by the caller; everything else mirrors the legacy fields).
export function modelPortfolioToInsert(m: ModelPortfolio): {
  id: string;
  name: string;
  tagline: string | null;
  blurb: string | null;
  builtIn: boolean;
  allocation: ModelPortfolio["mix"];
  expectedReturn: number | null;
  expectedVolatility: number | null;
  ter: number | null;
  horizon: string | null;
  risk: string | null;
  pros: string[];
  cons: string[];
} {
  return {
    id: m.id,
    name: m.name,
    tagline: m.tagline || null,
    blurb: m.blurb || null,
    builtIn: false,
    allocation: m.mix,
    expectedReturn: m.expectedReturn,
    expectedVolatility: m.expectedVol,
    ter: m.ter,
    horizon: m.horizon || null,
    risk: m.risk,
    pros: m.pros,
    cons: m.cons,
  };
}

function noteFromEntry(e: JournalEntry): Note {
  return {
    id: `j${e.id}`,
    title: e.title ?? "",
    body: e.body ?? "",
    source: e.source ?? "manual",
    date: fmtRelativeDate(e.createdAt),
    tags: e.tags ?? [],
  };
}

function readingFromEntry(e: JournalEntry): ReadingItem {
  return {
    id: `j${e.id}`,
    title: e.title ?? "",
    source: e.source ?? "",
    url: e.url ?? "#",
    summary: e.body ?? "",
    readTime: 0,
    status: "unread",
    savedDate: fmtRelativeDate(e.createdAt),
  };
}

// Synthesizes the legacy UserJournal shape from journal_entries. `plan` and
// `savedModels` stay empty for now — the screens render the empty states fine.
export function adaptJournal(entries: JournalEntry[]): UserJournal {
  const notes: Note[] = [];
  const reading: ReadingItem[] = [];
  for (const e of entries) {
    if (e.kind === "reading") reading.push(readingFromEntry(e));
    else notes.push(noteFromEntry(e));
  }
  return {
    notes,
    reading,
    plan: { target: "", monthlyContribution: 0, nextRebalanceDate: "", commitments: [] },
    savedModels: [],
  };
}
