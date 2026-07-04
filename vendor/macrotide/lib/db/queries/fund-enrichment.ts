// Fund enrichment queries — read/write for the five SEC enrichment tables:
// fund_performance, fund_asset_allocation, fund_top_holdings,
// fund_portfolio, fund_portfolio_asset_type.
//
// Write side: upsert helpers called by the fund-catalog refresh job.
// Read side: typed getters for API routes and the advisor tool.

import "server-only";
import { and, eq, getTableColumns, inArray, ne, sql } from "drizzle-orm";
import { getMarketDb } from "../context";
import {
  fundAssetAllocation,
  fundBenchmarks,
  fundDividendHistory,
  fundDividendPolicy,
  fundFactsheetUrls,
  fundPerformance,
  fundPortfolio,
  fundPortfolioAssetType,
  fundSpecifications,
  fundStatistics,
  fundSubscriptionMinimums,
  fundTopHoldings,
  securityIdMap,
  usSecurities,
} from "../schema";

// SEC assetliab code for the "net asset value" / grand-total summary line
// (มูลค่าทรัพย์สินสุทธิ in portfolio, รวม in asset-type). It is a 100% total,
// not a holding — both /outstanding endpoints emit it, and no consumer wants it.
const TOTAL_ASSETLIAB_CODE = "903";

/**
 * Canonicalize a reporting period to a clean "YYYYMM" string.
 *
 * The SEC /outstanding endpoints return `period` as a JSON NUMBER (e.g. 202406)
 * even though our row type calls it a string. Binding that number to the TEXT
 * `period` column stores it as "202406.0", and the incremental guards below
 * compare a Set of stored STRINGS against the incoming NUMBER — `set.has(202406)`
 * is always false against "202406.0", so every crawl re-inserted the entire
 * portfolio (the 6× duplication bug). Normalizing both sides to an integer
 * string makes the comparison correct, keeps the stored value tidy ("202406"),
 * and heals legacy "202406.0" rows already on disk (they normalize identically).
 */
export function normalizePeriod(period: string | number | null | undefined): string {
  if (period == null) return "";
  const n = typeof period === "number" ? period : Number.parseFloat(period);
  return Number.isFinite(n) ? String(Math.trunc(n)) : String(period).trim();
}

// ─── Inferred row types ───────────────────────────────────────────────────────

export type FundPerformanceRow = typeof fundPerformance.$inferSelect;
export type FundPerformanceInsert = typeof fundPerformance.$inferInsert;

export type FundAssetAllocationRow = typeof fundAssetAllocation.$inferSelect;
export type FundAssetAllocationInsert = typeof fundAssetAllocation.$inferInsert;

export type FundTopHoldingRow = typeof fundTopHoldings.$inferSelect;
export type FundTopHoldingInsert = typeof fundTopHoldings.$inferInsert;

export type FundPortfolioRow = typeof fundPortfolio.$inferSelect & {
  /** The holding's US ticker, resolved from its ISIN via the OpenFIGI crosswalk,
   *  or null when it isn't a US-listed security we can open (a UCITS master, a
   *  bank deposit, an FX forward). Drives row tappability — a feeder's master ETF
   *  line becomes a drill-in to that ETF's detail. */
  resolvedSymbol: string | null;
};
export type FundPortfolioInsert = typeof fundPortfolio.$inferInsert;

export type FundPortfolioAssetTypeRow = typeof fundPortfolioAssetType.$inferSelect;
export type FundPortfolioAssetTypeInsert = typeof fundPortfolioAssetType.$inferInsert;

export type FundBenchmarkRow = typeof fundBenchmarks.$inferSelect;
export type FundBenchmarkInsert = typeof fundBenchmarks.$inferInsert;

export type FundStatisticsRow = typeof fundStatistics.$inferSelect;
export type FundStatisticsInsert = typeof fundStatistics.$inferInsert;

export type FundSpecificationRow = typeof fundSpecifications.$inferSelect;
export type FundSpecificationInsert = typeof fundSpecifications.$inferInsert;

export type FundFactsheetUrlRow = typeof fundFactsheetUrls.$inferSelect;
export type FundFactsheetUrlInsert = typeof fundFactsheetUrls.$inferInsert;

export type FundSubscriptionMinimumRow = typeof fundSubscriptionMinimums.$inferSelect;
export type FundSubscriptionMinimumInsert = typeof fundSubscriptionMinimums.$inferInsert;

export type FundDividendPolicyRow = typeof fundDividendPolicy.$inferSelect;
export type FundDividendPolicyInsert = typeof fundDividendPolicy.$inferInsert;

export type FundDividendHistoryRow = typeof fundDividendHistory.$inferSelect;
export type FundDividendHistoryInsert = typeof fundDividendHistory.$inferInsert;

// ─── Write side ──────────────────────────────────────────────────────────────

/**
 * Replace all performance rows for a fund with a fresh set. Deletes existing
 * rows first (since the PK is (projId, fundClassName, performanceTypeDesc,
 * referencePeriod) a single insert/replace would leave orphan rows for
 * reference periods no longer in the latest factsheet).
 */
export function upsertFundPerformance(projId: string, rows: FundPerformanceInsert[]): void {
  if (rows.length === 0) return;
  const db = getMarketDb();
  db.transaction((tx) => {
    tx.delete(fundPerformance).where(eq(fundPerformance.projId, projId)).run();
    for (const row of rows) {
      tx.insert(fundPerformance).values(row).run();
    }
  });
}

/**
 * Replace all asset allocation rows for a fund. The latest factsheet snapshot
 * replaces the previous one entirely (asset_seq set may differ across snapshots).
 */
export function upsertFundAssetAllocation(projId: string, rows: FundAssetAllocationInsert[]): void {
  if (rows.length === 0) return;
  const db = getMarketDb();
  db.transaction((tx) => {
    tx.delete(fundAssetAllocation).where(eq(fundAssetAllocation.projId, projId)).run();
    for (const row of rows) {
      tx.insert(fundAssetAllocation).values(row).run();
    }
  });
}

/**
 * Replace all top-5 holding rows for a fund. The latest factsheet snapshot
 * replaces the previous one entirely.
 */
export function upsertFundTopHoldings(projId: string, rows: FundTopHoldingInsert[]): void {
  if (rows.length === 0) return;
  const db = getMarketDb();
  db.transaction((tx) => {
    tx.delete(fundTopHoldings).where(eq(fundTopHoldings.projId, projId)).run();
    for (const row of rows) {
      tx.insert(fundTopHoldings).values(row).run();
    }
  });
}

/**
 * Incrementally store portfolio rows for a fund: insert only the periods not
 * already present, preserving prior periods and NEVER deleting. The SEC
 * /outstanding endpoints return years of history; past periods are immutable,
 * so we accumulate them as a time series rather than rewriting nightly — and a
 * flaky or empty (HTTP 204) response can't wipe what we already have. The read
 * side (getFundPortfolio) surfaces only the latest period for display.
 *
 * Periods are normalized on BOTH sides of the guard (see {@link normalizePeriod})
 * — the feed sends `period` as a number, so without this the guard never matched
 * and every crawl duplicated the whole portfolio.
 */
export function upsertFundPortfolio(projId: string, rows: FundPortfolioInsert[]): void {
  if (rows.length === 0) return;
  const db = getMarketDb();
  db.transaction((tx) => {
    const existing = new Set(
      tx
        .select({ period: fundPortfolio.period })
        .from(fundPortfolio)
        .where(eq(fundPortfolio.projId, projId))
        .all()
        .map((r) => normalizePeriod(r.period)),
    );
    for (const row of rows) {
      const period = normalizePeriod(row.period);
      if (existing.has(period)) continue;
      tx.insert(fundPortfolio)
        .values({ ...row, period })
        .run();
    }
  });
}

/**
 * Incrementally store portfolio-asset-type rows — same additive, period-
 * normalized strategy as upsertFundPortfolio: insert only new periods, never
 * delete the monthly history (it backs asset-mix-over-time). The composite PK
 * (projId, period, assetliabCode) guards against exact dupes, but the period is
 * still normalized so the stored value stays clean and the guard matches.
 */
export function upsertFundPortfolioAssetType(
  projId: string,
  rows: FundPortfolioAssetTypeInsert[],
): void {
  if (rows.length === 0) return;
  const db = getMarketDb();
  db.transaction((tx) => {
    const existing = new Set(
      tx
        .select({ period: fundPortfolioAssetType.period })
        .from(fundPortfolioAssetType)
        .where(eq(fundPortfolioAssetType.projId, projId))
        .all()
        .map((r) => normalizePeriod(r.period)),
    );
    for (const row of rows) {
      const period = normalizePeriod(row.period);
      if (existing.has(period)) continue;
      // The period-skip above guards already-stored periods, but the SEC can
      // return two rows with the SAME (period, assetliab_code) within one
      // response — a plain insert then trips the composite PK. Upsert so an
      // intra-response duplicate updates rather than aborting the whole fund.
      tx.insert(fundPortfolioAssetType)
        .values({ ...row, period })
        .onConflictDoUpdate({
          target: [
            fundPortfolioAssetType.projId,
            fundPortfolioAssetType.period,
            fundPortfolioAssetType.assetliabCode,
          ],
          set: {
            assetliabDesc: row.assetliabDesc,
            marketValue: row.marketValue,
            percentNav: row.percentNav,
          },
        })
        .run();
    }
  });
}

/**
 * Replace all benchmark rows for a fund with the latest declared set. Delete +
 * insert (not upsert) so a fund that drops a blend component doesn't keep an
 * orphan group_seq row.
 */
export function upsertFundBenchmarks(projId: string, rows: FundBenchmarkInsert[]): void {
  if (rows.length === 0) return;
  const db = getMarketDb();
  db.transaction((tx) => {
    tx.delete(fundBenchmarks).where(eq(fundBenchmarks.projId, projId)).run();
    for (const row of rows) {
      tx.insert(fundBenchmarks).values(row).run();
    }
  });
}

/**
 * Replace all statistics rows for a fund with the latest factsheet set. Delete +
 * insert so a class no longer reported doesn't keep stale stats.
 */
export function upsertFundStatistics(projId: string, rows: FundStatisticsInsert[]): void {
  if (rows.length === 0) return;
  const db = getMarketDb();
  db.transaction((tx) => {
    tx.delete(fundStatistics).where(eq(fundStatistics.projId, projId)).run();
    for (const row of rows) {
      tx.insert(fundStatistics).values(row).run();
    }
  });
}

/** Replace a fund's special-characteristic codes with the latest set. */
export function upsertFundSpecifications(projId: string, rows: FundSpecificationInsert[]): void {
  if (rows.length === 0) return;
  const db = getMarketDb();
  db.transaction((tx) => {
    tx.delete(fundSpecifications).where(eq(fundSpecifications.projId, projId)).run();
    for (const row of rows) {
      tx.insert(fundSpecifications).values(row).run();
    }
  });
}

/** Replace a fund's factsheet URLs with the latest set. */
export function upsertFundFactsheetUrls(projId: string, rows: FundFactsheetUrlInsert[]): void {
  if (rows.length === 0) return;
  const db = getMarketDb();
  db.transaction((tx) => {
    tx.delete(fundFactsheetUrls).where(eq(fundFactsheetUrls.projId, projId)).run();
    for (const row of rows) {
      tx.insert(fundFactsheetUrls).values(row).run();
    }
  });
}

/** Replace a fund's subscription/redemption minimums with the latest set. */
export function upsertFundSubscriptionMinimums(
  projId: string,
  rows: FundSubscriptionMinimumInsert[],
): void {
  if (rows.length === 0) return;
  const db = getMarketDb();
  db.transaction((tx) => {
    tx.delete(fundSubscriptionMinimums).where(eq(fundSubscriptionMinimums.projId, projId)).run();
    for (const row of rows) {
      tx.insert(fundSubscriptionMinimums).values(row).run();
    }
  });
}

/** Replace a fund's formal dividend-policy codes with the latest set. */
export function upsertFundDividendPolicy(projId: string, rows: FundDividendPolicyInsert[]): void {
  if (rows.length === 0) return;
  const db = getMarketDb();
  db.transaction((tx) => {
    tx.delete(fundDividendPolicy).where(eq(fundDividendPolicy.projId, projId)).run();
    for (const row of rows) {
      tx.insert(fundDividendPolicy).values(row).run();
    }
  });
}

/**
 * APPEND a fund's dividend payments — history is never deleted; a re-landed
 * payment updates in place (heals corrections) keyed on
 * (projId, classAbbrName, bookCloseDate).
 */
export function upsertFundDividendHistory(
  _projId: string,
  rows: FundDividendHistoryInsert[],
): void {
  if (rows.length === 0) return;
  const db = getMarketDb();
  db.transaction((tx) => {
    for (const row of rows) {
      tx.insert(fundDividendHistory)
        .values(row)
        .onConflictDoUpdate({
          target: [
            fundDividendHistory.projId,
            fundDividendHistory.classAbbrName,
            fundDividendHistory.bookCloseDate,
          ],
          set: {
            dividendDate: row.dividendDate,
            dividendValue: row.dividendValue,
            lastUpdDate: row.lastUpdDate,
          },
        })
        .run();
    }
  });
}

// ─── Read side ────────────────────────────────────────────────────────────────

/** Special-characteristic codes for one fund (ETF / CIV / FIF …). */
export function getFundSpecifications(projId: string): FundSpecificationRow[] {
  return getMarketDb()
    .select()
    .from(fundSpecifications)
    .where(eq(fundSpecifications.projId, projId))
    .all();
}

/** Factsheet URLs for one fund, per class. */
export function getFundFactsheetUrls(projId: string): FundFactsheetUrlRow[] {
  return getMarketDb()
    .select()
    .from(fundFactsheetUrls)
    .where(eq(fundFactsheetUrls.projId, projId))
    .all();
}

/** Subscription/redemption minimums for one fund, per class. */
export function getFundSubscriptionMinimums(projId: string): FundSubscriptionMinimumRow[] {
  return getMarketDb()
    .select()
    .from(fundSubscriptionMinimums)
    .where(eq(fundSubscriptionMinimums.projId, projId))
    .all();
}

/** Formal dividend-policy codes for one fund, per class. */
export function getFundDividendPolicy(projId: string): FundDividendPolicyRow[] {
  return getMarketDb()
    .select()
    .from(fundDividendPolicy)
    .where(eq(fundDividendPolicy.projId, projId))
    .all();
}

/** Dividend payment history for one fund, most recent first. */
export function getFundDividendHistory(projId: string): FundDividendHistoryRow[] {
  return getMarketDb()
    .select()
    .from(fundDividendHistory)
    .where(eq(fundDividendHistory.projId, projId))
    .orderBy(sql`${fundDividendHistory.bookCloseDate} DESC`)
    .all();
}

/** Declared benchmark rows for one fund (latest factsheet), in blend order. */
export function getFundBenchmarks(projId: string): FundBenchmarkRow[] {
  return getMarketDb()
    .select()
    .from(fundBenchmarks)
    .where(eq(fundBenchmarks.projId, projId))
    .orderBy(fundBenchmarks.groupSeq)
    .all();
}

/** Factsheet statistics rows for one fund (latest factsheet), per share class. */
export function getFundStatistics(projId: string): FundStatisticsRow[] {
  return getMarketDb()
    .select()
    .from(fundStatistics)
    .where(eq(fundStatistics.projId, projId))
    .orderBy(fundStatistics.fundClassName)
    .all();
}

/** All performance rows for one fund (latest snapshot). */
export function getFundPerformance(projId: string): FundPerformanceRow[] {
  return getMarketDb()
    .select()
    .from(fundPerformance)
    .where(eq(fundPerformance.projId, projId))
    .all();
}

/** Asset allocation rows for one fund (latest snapshot). */
export function getFundAssetAllocation(projId: string): FundAssetAllocationRow[] {
  return getMarketDb()
    .select()
    .from(fundAssetAllocation)
    .where(eq(fundAssetAllocation.projId, projId))
    .orderBy(fundAssetAllocation.assetSeq)
    .all();
}

/** Top-5 holdings for one fund (latest snapshot), ordered by rank. */
export function getFundTopHoldings(projId: string): FundTopHoldingRow[] {
  return getMarketDb()
    .select()
    .from(fundTopHoldings)
    .where(eq(fundTopHoldings.projId, projId))
    .orderBy(fundTopHoldings.assetSeq)
    .all();
}

// A Bloomberg-style US ticker as some AMCs report it in a portfolio row's
// issue_code — "<TICKER> <US-exchange-code>", e.g. "QQQM US", "AAPL UW". Not every
// AMC fills isin_code for a US holding (KKP reports only this), so it's the
// fallback resolution path. Returns the bare ticker, or null when the code isn't a
// US Bloomberg ticker (a Thai internal code like "USD-CASH-NDQ100-UH" won't match:
// the suffix must be a space-delimited 2-letter US venue code at the very end).
const US_BLOOMBERG_TICKER = /^([A-Z][A-Z.]{0,5}) (US|UN|UW|UQ|UP|UR|UA|UV|UF)$/;
export function usTickerFromIssueCode(issueCode: string | null | undefined): string | null {
  const m = issueCode?.trim().match(US_BLOOMBERG_TICKER);
  return m ? m[1] : null;
}

/**
 * Full portfolio for one fund — LATEST period only.
 * The SEC /v2/fund/outstanding/portfolio endpoint returns every reported
 * quarter (years of history), not just the most recent one, so we filter to
 * the max period here — otherwise the UI stacks multiple quarters that each
 * sum to 100%. Defensive against the ingest storing more than one period.
 */
export function getFundPortfolio(projId: string): FundPortfolioRow[] {
  // Resolve each holding to its US ticker so a feeder's master-ETF line becomes a
  // tappable drill-in. Primary path: isin_code via the OpenFIGI crosswalk (the
  // master's real US ISIN — unlike the corrupt master_isin in feeder_master_map).
  // Fallback: some AMCs (e.g. KKP) leave isin_code blank but report the Bloomberg
  // ticker in issue_code ("QQQM US") — parse it and confirm it's a real US listing.
  const rows = getMarketDb()
    .select({
      ...getTableColumns(fundPortfolio),
      resolvedSymbol: securityIdMap.ticker,
    })
    .from(fundPortfolio)
    // security_id_map.id_value is stored upper-cased (ISINs are upper-case per
    // ISO 6166); upper-case the portfolio side too so a stray lower-case ISIN
    // still resolves. One-sided so the id_value PK index still seeks.
    .leftJoin(securityIdMap, eq(securityIdMap.idValue, sql`UPPER(${fundPortfolio.isinCode})`))
    .where(
      and(
        eq(fundPortfolio.projId, projId),
        ne(fundPortfolio.assetliabId, TOTAL_ASSETLIAB_CODE),
        eq(
          fundPortfolio.period,
          sql`(select max(${fundPortfolio.period}) from ${fundPortfolio} where ${fundPortfolio.projId} = ${projId})`,
        ),
      ),
    )
    .all();

  // Fallback for isin-less rows: validate the parsed Bloomberg ticker against the
  // live US catalog (one batched lookup), so we only link a real, active symbol.
  const candidates = new Map<number, string>();
  for (const r of rows) {
    if (r.resolvedSymbol) continue;
    const t = usTickerFromIssueCode(r.issueCode);
    if (t) candidates.set(r.id, t);
  }
  if (candidates.size > 0) {
    const wanted = [...new Set(candidates.values())];
    const valid = new Set(
      getMarketDb()
        .select({ symbol: usSecurities.symbol })
        .from(usSecurities)
        .where(and(inArray(usSecurities.symbol, wanted), eq(usSecurities.status, "active")))
        .all()
        .map((s) => s.symbol.toUpperCase()),
    );
    for (const r of rows) {
      const t = candidates.get(r.id);
      if (t && valid.has(t.toUpperCase())) r.resolvedSymbol = t;
    }
  }
  return rows;
}

/**
 * Portfolio by asset type for one fund — LATEST month only.
 * Same as getFundPortfolio: the endpoint returns every reported month, so we
 * filter to the max period to avoid stacking dozens of 100% breakdowns.
 */
export function getFundPortfolioAssetType(projId: string): FundPortfolioAssetTypeRow[] {
  return getMarketDb()
    .select()
    .from(fundPortfolioAssetType)
    .where(
      and(
        eq(fundPortfolioAssetType.projId, projId),
        ne(fundPortfolioAssetType.assetliabCode, TOTAL_ASSETLIAB_CODE),
        eq(
          fundPortfolioAssetType.period,
          sql`(select max(${fundPortfolioAssetType.period}) from ${fundPortfolioAssetType} where ${fundPortfolioAssetType.projId} = ${projId})`,
        ),
      ),
    )
    .all();
}

/**
 * Composite fund detail — returns all enrichment data for one fund in a
 * single call. Any table that has no data returns an empty array.
 * Suitable for a fund-detail API route response body.
 */
export function getFundEnrichment(projId: string): {
  performance: FundPerformanceRow[];
  assetAllocation: FundAssetAllocationRow[];
  topHoldings: FundTopHoldingRow[];
  portfolio: FundPortfolioRow[];
  portfolioAssetType: FundPortfolioAssetTypeRow[];
} {
  return {
    performance: getFundPerformance(projId),
    assetAllocation: getFundAssetAllocation(projId),
    topHoldings: getFundTopHoldings(projId),
    portfolio: getFundPortfolio(projId),
    portfolioAssetType: getFundPortfolioAssetType(projId),
  };
}
