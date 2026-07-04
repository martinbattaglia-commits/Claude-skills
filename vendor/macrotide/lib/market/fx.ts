import "server-only";
import { getCachedSeries } from "./cache";
import { BASE_CURRENCY } from "./currency";
import type { SeriesRange } from "./providers/types";

const MS_PER_DAY = 86_400_000;

// Per-date FX conversion into the portfolio base currency (THB), reusing the
// existing keyless Frankfurter chain (ECB reference rates) — no new provider.
//
// Frankfurter quotes USD→XXX (the Yahoo "XXX=X" convention). To convert an
// amount in currency C to THB on a given date we use the cross rate
//   C→THB = (USD→THB) / (USD→C)
// from that date's two USD-based rates. ECB publishes working-day rates only,
// so we forward-fill the most recent rate on/before each portfolio date (weekend
// and holiday gaps reuse the prior business day, as is standard for daily FX).

/** A per-date lookup of "1 unit of currency C, in THB". */
export interface FxConverter {
  /** Multiply a value in currency C by this to get THB. 1 for THB itself. */
  rateOn(currency: string, date: string): number | null;
  /** True if every requested non-THB currency resolved to at least one rate. */
  readonly missing: ReadonlySet<string>;
}

/** Build a forward-fill lookup (date → rate) from an ascending date series. */
function forwardFillRates(
  series: { date: string; close: number }[],
  dates: string[],
): Map<string, number> {
  const out = new Map<string, number>();
  let i = 0;
  let last: number | null = null;
  for (const d of dates) {
    while (i < series.length && series[i].date <= d) {
      last = series[i].close;
      i++;
    }
    if (last !== null) out.set(d, last);
  }
  // ECB has no rate before its first published date in range; back-fill the
  // earliest known rate so leading portfolio dates still convert rather than
  // dropping the holding. FX moves are small relative to the alternative
  // (summing raw foreign NAV as if it were THB).
  if (last === null && series.length > 0) return out;
  const firstKnown = series[0]?.close ?? null;
  if (firstKnown !== null) {
    for (const d of dates) {
      if (!out.has(d)) out.set(d, firstKnown);
    }
  }
  return out;
}

/**
 * Build an FX converter covering `currencies` over the dates spanned by
 * `range`, fetching each USD→currency series (incl. USD→THB) once from the
 * cache. Missing or cold rates degrade gracefully: `rateOn` returns null for an
 * unresolved currency and the caller decides how to handle it (we skip that
 * holding's contribution rather than crash, and flag it via `missing`).
 *
 * THB needs no rate (factor 1). USD→THB is the THB=X series. A third currency C
 * converts to THB via the cross rate (USD→THB)/(USD→C) on the same date.
 */
export async function buildFxConverter(
  currencies: Iterable<string>,
  range: SeriesRange,
  dates: string[],
): Promise<FxConverter> {
  const needed = new Set<string>();
  for (const c of currencies) {
    if (c && c !== BASE_CURRENCY) needed.add(c);
  }

  const missing = new Set<string>();

  // USD→THB drives every conversion. If THB itself is the only thing we need and
  // there are no foreign currencies, we can short-circuit.
  const usdThb = await fetchUsdRate(BASE_CURRENCY, range, dates);
  if (usdThb === null && needed.size > 0) {
    // No USD→THB at all — can't convert anything foreign. Mark all foreign
    // currencies missing; rateOn will return null for them.
    for (const c of needed) missing.add(c);
    return { rateOn: (c) => (c === BASE_CURRENCY ? 1 : null), missing };
  }

  // For each needed foreign currency C, fetch USD→C (USD needs none — USD→THB
  // already IS the USD factor).
  const usdRates = new Map<string, Map<string, number>>();
  await Promise.all(
    Array.from(needed).map(async (c) => {
      if (c === "USD") return; // handled directly via usdThb
      const r = await fetchUsdRate(c, range, dates);
      if (r === null || r.size === 0) {
        missing.add(c);
        return;
      }
      usdRates.set(c, r);
    }),
  );

  const rateOn = (currency: string, date: string): number | null => {
    if (!currency || currency === BASE_CURRENCY) return 1;
    if (!usdThb) return null;
    const thbPerUsd = usdThb.get(date);
    if (thbPerUsd === undefined) return null;
    if (currency === "USD") return thbPerUsd;
    const usdPerC = usdRates.get(currency)?.get(date);
    if (usdPerC === undefined || usdPerC === 0) return null;
    // C→THB = (USD→THB) / (USD→C)
    return thbPerUsd / usdPerC;
  };

  return { rateOn, missing };
}

/**
 * The smallest cache range that comfortably spans back to `date`, so the FX series
 * actually contains that date's rate (forward-fill can't invent data before the
 * range start — it back-fills the earliest known rate, which for a far-past date is
 * the wrong rate). A little headroom past the exact boundary absorbs ECB weekend/
 * holiday gaps.
 */
function rangeForDate(date: string): SeriesRange {
  const days = (Date.now() - Date.parse(`${date}T00:00:00Z`)) / MS_PER_DAY;
  if (days <= 25) return "1mo";
  if (days <= 80) return "3mo";
  if (days <= 170) return "6mo";
  if (days <= 350) return "1y";
  if (days <= 1800) return "5y";
  return "max";
}

/**
 * One rate: "1 unit of `currency`, in THB" on `date` (the trade-date FX used to
 * capture a non-THB cost basis). THB → 1. Returns null when the rate can't be
 * resolved (cold cache / unknown currency) so the caller can fall back to a manual
 * entry rather than guess. Reuses the same keyless Frankfurter cross-rate path as
 * the value fold, so an entered basis and its later valuation share one FX source.
 */
export async function fxRateOn(currency: string, date: string): Promise<number | null> {
  const c = (currency || "").trim().toUpperCase();
  if (!c || c === BASE_CURRENCY) return 1;
  const fx = await buildFxConverter([c], rangeForDate(date), [date]);
  return fx.rateOn(c, date);
}

/** Fetch the USD→`currency` daily series via Frankfurter and forward-fill it. */
async function fetchUsdRate(
  currency: string,
  range: SeriesRange,
  dates: string[],
): Promise<Map<string, number> | null> {
  try {
    const cached = await getCachedSeries("market", `${currency}=X`, range);
    if (cached.series.length === 0) return null;
    return forwardFillRates(cached.series, dates);
  } catch {
    return null;
  }
}
