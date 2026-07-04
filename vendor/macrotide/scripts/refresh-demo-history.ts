// Regenerate the committed demo NAV-history fixture (lib/mock/demo-history.ts).
//
// WHY THIS EXISTS
// ---------------
// In demo mode the Portfolio chart should show ~5 years of realistic history for
// both the portfolio line and the benchmark overlay — fully self-contained,
// offline at runtime, zero per-session provider quota. We get there by pulling
// ~5y of REAL public index data ONCE (here), deriving each demo fund's series
// from the index it tracks (fee + tracking transform), and COMMITTING the result
// as a typed fixture. The runtime demo read path reads the fixture — it never
// calls a provider. See lib/db/queries/series.ts + lib/market/benchmarks.ts.
//
// RESOLUTION & ENCODING
// ---------------------
// VARIABLE resolution keeps every UI range dense without a fat fixture: DAILY for
// the most recent ~13 months (so 1M/3M/6M/1Y show real trading-day detail) and
// WEEKLY before that (far-back density is invisible at "All" zoom). Points are
// stored as compact [date, value] tuples (one line each), not {date,value}
// objects, to keep the file small (well under 300 KB).
//
// USAGE
// -----
//   npm run refresh:demo-history
// (reads provider keys from .env.local via tsx --env-file; see package.json)
//
// CADENCE
// -------
// Re-running is OPTIONAL — recency is automatic: the read path re-dates the
// fixture so its latest point always lands on today (see lib/mock/demo-history-read.ts).
// Re-run only to refresh the index SHAPES (a few years of new market action) or
// extend the span; never for the dates. NOT on the live path.
//
// DATA SOURCES (real, public only — no real fund NAVs; see AGENTS.md):
//   - S&P 500 (^GSPC)              → FMP real index, ~5y daily
//   - Nasdaq / Nikkei / SET / ACWI → Twelve Data ETF proxy, ~5y daily (EODHD's
//                                     free index tier caps at ~1y; the proxy
//                                     tracks the index shape, all we rebase on)
//   - Gold (XAU/USD, GC=F)         → Twelve Data, ~5y daily
//   - Thai bonds / cash            → synthetic smooth series (no free real index
//                                     in the provider chain)

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fmpProvider } from "@/lib/market/providers/fmp";
import { twelveDataProvider } from "@/lib/market/providers/twelvedata";
import type { Provider } from "@/lib/market/providers/types";
import { PORTFOLIOS } from "@/lib/mock/data";
import { DEMO_INDICES, indexKeyForHolding, wobbleAmpForTer } from "@/lib/mock/demo-history-map";
import {
  buildHoldingSeries,
  downsampleVariable,
  type HistoryPoint,
} from "@/lib/mock/demo-history-transform";

// ~5y span; daily for the most recent ~13 months, weekly before that.
const MAX_DAYS = 5 * 366;
const DAILY_DAYS = 378; // ~12.5 months daily — covers 1M/3M/6M/1Y crisply (1Y = 366d)
const DEMO_QUOTE_SOURCE = "thai_mutual_fund";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pick the provider that yields the DEEPEST daily history for a fixture index. */
function providerFor(ticker: string): Provider {
  // FMP serves the real ^GSPC with full ~5y depth; everything else goes to the
  // Twelve Data ETF proxy (also ~5y; EODHD's free index tier only gives ~1y).
  return ticker === "^GSPC" ? fmpProvider : twelveDataProvider;
}

/** Fetch a real index's RAW daily series (date, value), oldest-first. */
async function fetchIndexDaily(ticker: string): Promise<HistoryPoint[]> {
  const provider = providerFor(ticker);
  const { series } = await provider.fetchSeries(ticker, "5y", "1d");
  return series
    .map((p) => ({
      date: new Date(p.t * 1000).toISOString().slice(0, 10),
      value: Math.round(p.close * 100) / 100, // 2dp keeps index levels readable
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Re-index a raw daily series onto a canonical date axis by forward-fill: each
 * axis date takes the series' most recent value at/before it. Dates before the
 * series' first observation are dropped (the caller guarantees the axis starts
 * at/after every series' inception via the common start).
 */
function alignToAxis(raw: HistoryPoint[], axis: string[]): HistoryPoint[] {
  const out: HistoryPoint[] = [];
  let i = 0;
  let last: number | null = null;
  for (const date of axis) {
    while (i < raw.length && raw[i].date <= date) {
      last = raw[i].value;
      i++;
    }
    if (last !== null) out.push({ date, value: last });
  }
  return out;
}

/** Build a smooth synthetic series at `annualPct`, sampled on the axis dates. */
function syntheticSeries(axis: string[], annualPct: number): HistoryPoint[] {
  if (axis.length === 0) return [];
  const t0 = Date.parse(`${axis[0]}T00:00:00Z`);
  return axis.map((date) => {
    const years = (Date.parse(`${date}T00:00:00Z`) - t0) / (365.25 * 86400_000);
    return { date, value: Math.round((1 + annualPct / 100) ** years * 1e6) / 1e6 };
  });
}

async function main() {
  console.log("Pulling real index history for the demo fixture…\n");

  // 1. Pull each REAL index as RAW daily series (rate-limited; TD free ~8/min).
  const realDefs = DEMO_INDICES.filter((d) => d.ticker !== null);
  const rawDaily: Record<string, HistoryPoint[]> = {};
  for (const def of realDefs) {
    try {
      const s = await fetchIndexDaily(def.ticker as string);
      rawDaily[def.indexKey] = s;
      console.log(
        `  OK   ${def.indexKey.padEnd(8)} ${(def.ticker as string).padEnd(8)} ` +
          `${String(s.length).padStart(4)} raw  ${s[0]?.date} → ${s.at(-1)?.date}`,
      );
    } catch (err) {
      console.error(`  FAIL ${def.indexKey} (${def.ticker}): ${err}`);
      process.exitCode = 1;
      return;
    }
    await sleep(9000);
  }

  // 2. ONE canonical trading-day axis: the union of every real index's dates,
  // starting at the LATEST inception among them (so every series has data on the
  // axis from day one — no staggered "All" ramp). This kills the weekend-only /
  // calendar-mismatch dates that opened a window on a synthetic-only date.
  const commonStart = Object.values(rawDaily)
    .map((s) => s[0]?.date ?? "")
    .reduce((a, b) => (a > b ? a : b), "");
  const axisSet = new Set<string>();
  for (const s of Object.values(rawDaily)) {
    for (const p of s) if (p.date >= commonStart) axisSet.add(p.date);
  }
  const fullAxis = Array.from(axisSet).sort();
  // Variable resolution on the canonical axis (daily recent / weekly far-back).
  const axis = downsampleVariable(
    fullAxis.map((date) => ({ date, value: 0 })),
    { maxDays: MAX_DAYS, dailyDays: DAILY_DAYS },
  ).map((p) => p.date);
  console.log(`\n  Canonical axis: ${axis.length} dates  ${axis[0]} → ${axis.at(-1)}\n`);

  // 3. Every index (real, re-indexed onto the axis + synthetic, sampled on it)
  // shares the SAME dates — so every fixture date has all 20 series.
  const indices: Record<string, HistoryPoint[]> = {};
  for (const def of DEMO_INDICES) {
    if (def.ticker !== null) {
      indices[def.indexKey] = alignToAxis(rawDaily[def.indexKey], axis);
    } else if (def.syntheticAnnualPct !== undefined) {
      indices[def.indexKey] = syntheticSeries(axis, def.syntheticAnnualPct);
      console.log(`  SYNTH ${def.indexKey.padEnd(8)} @ ${def.syntheticAnnualPct}%/yr`);
    }
  }
  const calendar = axis;

  // 4. Per-holding series, keyed by the runtime cache key `${quoteSource}:${ticker}`.
  const holdings: Record<string, HistoryPoint[]> = {};
  for (const portfolio of PORTFOLIOS) {
    for (const h of portfolio.holdings) {
      const key = `${DEMO_QUOTE_SOURCE}:${h.ticker}`;
      const indexKey = indexKeyForHolding(h.class, h.region);
      const index = indices[indexKey];
      if (!index || index.length === 0) {
        console.error(`  FAIL holding ${key}: no index series for "${indexKey}"`);
        process.exitCode = 1;
        return;
      }
      const terPct = h.ter ?? 0;
      const valueSeries = buildHoldingSeries({
        seedKey: key,
        index,
        terPct,
        currentValue: h.value,
        wobbleAmp: wobbleAmpForTer(terPct),
      });
      // The fixture stores PER-UNIT NAV (same shape as a market.db nav_history
      // row): the demo ledger replays units over time, so the read path computes
      // value = units(date) × nav — a total-value series would double-count the
      // unit story. Scale the built total-value series by the seeded unit count.
      holdings[key] = valueSeries.map((p) => ({
        date: p.date,
        value: Math.round((p.value / h.units) * 1e4) / 1e4,
      }));
    }
  }

  // 4. Emit the fixture module.
  const generatedAt = new Date().toISOString();
  const out = renderFixture({ generatedAt, calendar, indices, holdings });
  const dest = resolve(process.cwd(), "lib/mock/demo-history.ts");
  writeFileSync(dest, out, "utf8");
  const totalPts =
    Object.values(holdings).reduce((s, a) => s + a.length, 0) +
    Object.values(indices).reduce((s, a) => s + a.length, 0);
  console.log(
    `\nWrote ${dest}\n  ${Object.keys(holdings).length} holdings, ` +
      `${Object.keys(indices).length} indices, ${calendar.length} pts/series (densest), ` +
      `${totalPts} points total, ${(Buffer.byteLength(out) / 1024).toFixed(0)} KB`,
  );
}

function renderFixture(data: {
  generatedAt: string;
  calendar: string[];
  indices: Record<string, HistoryPoint[]>;
  holdings: Record<string, HistoryPoint[]>;
}): string {
  const j = (v: unknown) => JSON.stringify(v);
  // Compact: one [date, value] tuple per line.
  const block = (rec: Record<string, HistoryPoint[]>) =>
    Object.entries(rec)
      .map(
        ([k, pts]) =>
          `  ${j(k)}: [\n${pts.map((p) => `    [${j(p.date)}, ${p.value}],`).join("\n")}\n  ],`,
      )
      .join("\n");

  return `// GENERATED FILE — do not edit by hand.
// Regenerate with: npm run refresh:demo-history (scripts/refresh-demo-history.ts).
//
// Self-contained ~5-year NAV history for DEMO MODE only. Built from REAL public
// index data (S&P 500 via FMP; Nasdaq/Nikkei/SET/ACWI/Gold via Twelve Data; Thai
// bonds/cash synthetic) transformed into per-holding series. The demo read path
// (lib/db/queries/series.ts, lib/market/benchmarks.ts) reads this so it never
// calls a provider. Owner mode is unaffected — it still reads market.db.
//
// Resolution: DAILY for the most recent ~13 months, WEEKLY before that.
// Encoding: compact [date, value] tuples (decode via lib/mock/demo-history-read).
//
// Date grid: ALL series (holdings + indices, incl. synthetic) share ONE
// canonical trading-day axis with a COMMON START (the latest inception among the
// real sources). So every fixture date carries every series — no weekend-only
// dates and no staggered "All" ramp.
//
// Generated: ${data.generatedAt}

/** A committed point: [ISO YYYY-MM-DD date, value]. */
export type EncodedPoint = [string, number];

/** Per-holding PER-UNIT NAV series (THB), keyed by \`\${quoteSource}:\${ticker}\` — same shape as a market.db nav_history row. The demo ledger replays units over time; value = units(date) × this nav. */
export const DEMO_HOLDING_HISTORY: Record<string, EncodedPoint[]> = {
${block(data.holdings)}
};

/** Real (and synthetic) index series, keyed by fixture index key. */
export const DEMO_INDEX_HISTORY: Record<string, EncodedPoint[]> = {
${block(data.indices)}
};

/** When this fixture was generated (ISO). */
export const DEMO_HISTORY_GENERATED_AT = ${j(data.generatedAt)};
`;
}

void main();
