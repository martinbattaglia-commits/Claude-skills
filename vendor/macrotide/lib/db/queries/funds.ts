// Fund-catalog queries — the shared contract over `fund_catalog` + `fund_fees`.
//
// Write side (ingestion): the daily SEC refresh job upserts funds and their fee
// time-series. Read side (consumers): the find_funds advisor tool and the Select
// UI list/filter funds and compare current fees.
//
// "Current fee" = the most recent record for a fee type: prefer the open period
// (`periodEnd IS NULL`), else the latest `periodStart`. We resolve this in JS
// after a per-fund fetch rather than in SQL — catalog scale is a few thousand
// funds on a single-VM SQLite, so clarity beats a window-function query here.

import "server-only";
import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  not,
  or,
  sql,
} from "drizzle-orm";
import { indexTypeFromManagementStyle, isIndexStyle } from "../../market/fund-classify";
import { type FeeType, TER_FEE_TYPE } from "../../market/fund-fees";
import {
  type AccessTier,
  browseTiers,
  isTierBuyable,
  type RetailTier,
  retailTier,
} from "../../market/retail-tier";
import { compareClassesForList } from "../../market/share-class-select";
import { type QuoteSource, quoteCacheKey, tickerKey } from "../../market/sources";
import { searchFundIds, searchFundIdsScored } from "../../search/fund-index";
import { getMarketDb } from "../context";
import {
  fundCatalog,
  fundFees,
  fundQuotes,
  fundShareClasses,
  navHistory,
  usSecurities,
} from "../schema";
import { listShareClassesByProj } from "./share-classes";

export type Fund = typeof fundCatalog.$inferSelect;
export type FundInsert = typeof fundCatalog.$inferInsert;
export type FundFee = typeof fundFees.$inferSelect;
export type FundFeeInsert = typeof fundFees.$inferInsert;

// ─── write side (refresh job) ───────────────────────────────────────────────

/** Insert or update one fund. Touches `updatedAt` on conflict. */
export function upsertFund(input: FundInsert): Fund {
  return getMarketDb()
    .insert(fundCatalog)
    .values(input)
    .onConflictDoUpdate({
      target: fundCatalog.projId,
      set: {
        abbrName: input.abbrName,
        thaiName: input.thaiName,
        englishName: input.englishName,
        amcName: input.amcName,
        fundType: input.fundType,
        policyDesc: input.policyDesc,
        assetClass: input.assetClass,
        riskSpectrum: input.riskSpectrum,
        policyDescTh: input.policyDescTh,
        managementStyle: input.managementStyle,
        taxIncentiveType: input.taxIncentiveType,
        distributionPolicy: input.distributionPolicy,
        investRegion: input.investRegion,
        isFeederFund: input.isFeederFund ?? false,
        feederMasterFund: input.feederMasterFund,
        feederFundCountry: input.feederFundCountry,
        investmentPolicyDesc: input.investmentPolicyDesc,
        fxHedgingPolicy: input.fxHedgingPolicy,
        isFixedTerm: input.isFixedTerm ?? false,
        termYears: input.termYears,
        termMonths: input.termMonths,
        termDays: input.termDays,
        initDate: input.initDate,
        regisDate: input.regisDate,
        cancelDate: input.cancelDate,
        isinCode: input.isinCode,
        aum: input.aum,
        aumDate: input.aumDate,
        secStatus: input.secStatus,
        status: input.status ?? "active",
        projRetailType: input.projRetailType,
        updatedAt: sql`(CURRENT_TIMESTAMP)`,
      },
    })
    .returning()
    .get();
}

/** Derived facet columns (see lib/market/fund-facets.ts), updated by the transform. */
export interface FundFacetsUpdate {
  regionFocus: string | null;
  regionFocusSource: string | null;
  sectorFocus: string | null;
  indexFamily: string | null;
  /** Raw AIMC peer-group code, verbatim (null = unclassified / v1 key absent). */
  aimcCategory: string | null;
}

/**
 * Batch-update the derived facet columns. Separate from upsertFund because the
 * facets depend on MORE than the profile (benchmarks + names + policy text), so
 * the transform computes them after the benchmark table is derived. One
 * transaction for the whole catalog (~9k updates, milliseconds on SQLite).
 */
export function updateFundFacets(updates: Array<{ projId: string } & FundFacetsUpdate>): void {
  if (updates.length === 0) return;
  const db = getMarketDb();
  db.transaction((tx) => {
    for (const u of updates) {
      tx.update(fundCatalog)
        .set({
          regionFocus: u.regionFocus,
          regionFocusSource: u.regionFocusSource,
          sectorFocus: u.sectorFocus,
          indexFamily: u.indexFamily,
          aimcCategory: u.aimcCategory,
        })
        .where(eq(fundCatalog.projId, u.projId))
        .run();
    }
  });
}

/**
 * Upsert a batch of fee rows in a single transaction. The composite PK
 * (projId, fundClassName, feeTypeRaw, periodStart) makes this idempotent, so a
 * re-run of the same day's data is a no-op rather than a duplicate.
 */
export function upsertFundFees(rows: FundFeeInsert[]): void {
  if (rows.length === 0) return;
  const db = getMarketDb();
  db.transaction((tx) => {
    for (const row of rows) {
      tx.insert(fundFees)
        .values(row)
        .onConflictDoUpdate({
          target: [
            fundFees.projId,
            fundFees.fundClassName,
            fundFees.feeTypeRaw,
            fundFees.periodStart,
          ],
          set: {
            feeType: row.feeType,
            rateCeilingPct: row.rateCeilingPct,
            actualRatePct: row.actualRatePct,
            periodEnd: row.periodEnd,
            prospectusType: row.prospectusType,
            lastUpdDate: row.lastUpdDate,
          },
        })
        .run();
    }
  });

  // Keep the derived fund_catalog.current_ter cache in sync with the fees just
  // written, so findFunds can sort/annotate by TER without touching the full
  // fee history. Picks the current total_expense row (open period first, then
  // newest start) for exactly the funds in `rows`.
  //
  // A multi-class fund publishes one total_expense row PER class in the same
  // open period, so the period sort alone leaves a tie that SQLite breaks
  // arbitrarily — and a single fee-waived special class (e.g. a `-X` at 0.011%
  // beside a `-A` retail class at 1.964%) could win, dragging the whole family
  // to the top of the cheapest-TER-first screener under a fee no retail buyer
  // pays. So pick the class the screener actually leads with: join the share
  // classes, drop the ones individuals can't buy (institutional / insurance),
  // and break the period tie by the same audience tier compareClassesForList
  // uses (retail → unknown → restricted), then a deterministic class name.
  //
  // NULLIF(rate, 0) before COALESCE: the SEC reports a `0` actual rate for a fund
  // whose fee hasn't been actualized yet (new/IPO funds carry a ceiling but no
  // realized expense) and an all-zero `main` placeholder row beside the real
  // classes. A bare COALESCE(actual, ceiling) treats that `0` as a genuine fee —
  // so a 4.49%-ceiling fund reads as "0.00%" and a multi-class fund can inherit
  // the placeholder. Nulling the zeros makes an unactualized rate fall through to
  // the ceiling, and a truly dataless row resolve to NULL ("no published fee"),
  // never a fake free fund. (No Thai fund genuinely charges 0; the feed can't
  // even express it — both fields are 0 when data is simply absent.)
  const projIds = [...new Set(rows.map((r) => r.projId))];
  db.run(sql`
    UPDATE ${fundCatalog} SET current_ter = (
      SELECT COALESCE(NULLIF(${fundFees.actualRatePct}, 0), NULLIF(${fundFees.rateCeilingPct}, 0))
      FROM ${fundFees}
      LEFT JOIN ${fundShareClasses}
        ON ${fundShareClasses.projId} = ${fundFees.projId}
       AND ${fundShareClasses.className} = ${fundFees.fundClassName}
      WHERE ${fundFees.projId} = ${fundCatalog.projId}
        AND ${fundFees.feeType} = ${TER_FEE_TYPE}
        AND (${fundShareClasses.investorType} IS NULL
             OR ${fundShareClasses.investorType} NOT IN ('institutional', 'insurance'))
      ORDER BY
        (${fundFees.periodEnd} IS NULL) DESC,
        ${fundFees.periodStart} DESC,
        CASE
          WHEN ${fundShareClasses.investorType} = 'retail' THEN 0
          WHEN ${fundShareClasses.investorType} IS NULL THEN 1
          ELSE 2
        END,
        ${fundFees.fundClassName}
      LIMIT 1
    )
    WHERE ${fundCatalog.projId} IN (${sql.join(
      projIds.map((p) => sql`${p}`),
      sql`, `,
    )})
  `);
}

// ─── read side (find_funds tool, Select UI) ─────────────────────────────────

/**
 * Current fee, per normalized type, for one fund. Picks the open period if there
 * is one, else the newest closed period. Keyed by `FeeType`; types with no data
 * are absent from the map.
 */
export function getCurrentFees(projId: string): Partial<Record<FeeType, FundFee>> {
  const rows = getMarketDb()
    .select()
    .from(fundFees)
    .where(eq(fundFees.projId, projId))
    .orderBy(
      // open period (periodEnd IS NULL) first, then newest start date
      sql`${fundFees.periodEnd} IS NULL DESC`,
      sql`${fundFees.periodStart} DESC`,
    )
    .all();

  return pickCurrentFees(rows);
}

/**
 * Reduce already-fetched fee rows (for a single fund) to the current record per
 * type. Rows MUST be pre-sorted open-period-first, then newest start date — the
 * same order `getCurrentFees`/`fetchCurrentFeesBatch` apply — so "first wins"
 * picks the most current record. Shared by the per-fund and batched paths so
 * both produce identical results.
 */
function pickCurrentFees(rows: FundFee[]): Partial<Record<FeeType, FundFee>> {
  const current: Partial<Record<FeeType, FundFee>> = {};
  for (const row of rows) {
    const ft = row.feeType as FeeType;
    if (!(ft in current)) current[ft] = row; // first wins = most current
  }
  return current;
}

/** TER from a fund's current-fee map. Same semantics as `getCurrentTer`. */
function terFromCurrentFees(current: Partial<Record<FeeType, FundFee>>): number | null {
  const ter = current[TER_FEE_TYPE];
  // Mirror the current_ter cache's NULLIF(rate, 0) → COALESCE: a `0` rate means
  // "not actualized / no data", not a real free fee, so an unactualized actual
  // rate falls through to the ceiling and an all-zero row resolves to null. See
  // the upsertFundFees cache-update comment for why the SEC feed encodes it this
  // way.
  const nonZero = (x: number | null | undefined) => (x != null && x !== 0 ? x : null);
  return nonZero(ter?.actualRatePct) ?? nonZero(ter?.rateCeilingPct) ?? null;
}

/**
 * The all-in fee (TER) a fund actually charges, as a percent, or `null` if the
 * SEC has not published a Total Fee and Expense figure for it. This is the
 * number the fee finder ranks and compares on.
 */
export function getCurrentTer(projId: string): number | null {
  return terFromCurrentFees(getCurrentFees(projId));
}

// The screener/finder never reads the fund's long-form policy text, so its
// catalog query omits `investment_policy_desc` (a ~5KB HTML blob per row). For
// the ~2k-row browse expansion that single column dominated the scan — dropping
// it cuts the catalog read ~10× (queries flow through `CATALOG_LIST_COLUMNS`).
const { investmentPolicyDesc: _omitPolicyDesc, ...CATALOG_LIST_COLUMNS } =
  getTableColumns(fundCatalog);

export type FundWithTer = Omit<Fund, "investmentPolicyDesc"> & { ter: number | null };

export type FindFundsFilter = {
  /** Normalized allocation class: 'equity' | 'bond' | 'alternative' | 'cash'. */
  assetClass?: string;
  /**
   * @deprecated fundType is always null in the catalog now (dead column).
   * Drop this filter from new callers; it is a no-op when fundType is null.
   */
  fundType?: string;
  /** Substring match against abbr / Thai / English name and policy text. */
  query?: string;
  /** Only funds the SEC still lists as offered. Defaults to true. */
  activeOnly?: boolean;
  /** Cap result size. Defaults to 50. */
  limit?: number;
  /**
   * Index/active facet: 'index' = pure passive (managementStyle PN/PM);
   * 'active' = everything else INCLUDING funds with no published style.
   * Omit for both.
   */
  indexType?: "index" | "active";
  /**
   * @deprecated Back-compat alias: `true` ≡ `indexType: 'index'` (the advisor
   * tool schema and old API URLs still send it). `indexType` wins when both
   * are present. New callers use `indexType`.
   */
  indexOnly?: boolean;
  /** Restrict to a specific tax-advantaged wrapper. */
  taxIncentive?: "SSF" | "ThaiESG" | "RMF";
  /** Restrict to a geographic mandate. */
  region?: "foreign" | "domestic" | "mixed";
  /**
   * Restrict to a derived geographic FOCUS (finer than `region`): 'thailand',
   * 'us', 'japan', 'global', … — see fund_catalog.region_focus. Funds with an
   * unknown focus (NULL) are excluded when this is set.
   */
  regionFocus?: string;
  /** Restrict to a derived sector/theme focus ('technology', 'gold', …). */
  sectorFocus?: string;
  /**
   * Restrict to funds that TRACK a normalized index family ("S&P 500", "SET50",
   * "NASDAQ-100", … — fund_catalog.index_family): the family must match AND the
   * fund must be index-style (managementStyle PN/PM). Active funds merely
   * BENCHMARKED against the index keep the family on their catalog row but are
   * excluded here — "tracks" is family + style, by design.
   */
  trackingIndex?: string;
  /**
   * Exclude fixed-term funds — they stop accepting new subscriptions once
   * closed and aren't suitable for ongoing investing. Defaults to true.
   */
  excludeFixedTerm?: boolean;
};

/**
 * Find funds matching an exposure filter, each annotated with its current TER.
 *
 * Ordering depends on whether there is a text query:
 *   • No text query → cheapest-TER-first (the fee finder's "which funds give me
 *     this exposure for the lowest fee?" ranking; funds with no published TER
 *     sort last). Unchanged from before.
 *   • Text query → RELEVANCE first. Candidates come from the in-memory
 *     MiniSearch index (which matches abbr/name/policy AND the feeder master
 *     name, with fuzzy + prefix + alias expansion), already ranked by match
 *     quality. We preserve that order so a great name match isn't buried by a
 *     marginally cheaper unrelated fund. TER still annotates every row and only
 *     breaks ties between funds of equal relevance rank.
 *
 * Structured filters (activeOnly / assetClass / taxIncentive / region /
 * indexType / excludeFixedTerm) and the batched cheapest-first TER fetch are
 * applied identically in both paths, and the `FundWithTer[]` shape is unchanged.
 */
export function findFunds(filter: FindFundsFilter = {}): FundWithTer[] {
  const {
    assetClass,
    query,
    activeOnly = true,
    limit = 50,
    indexType,
    indexOnly,
    taxIncentive,
    region,
    regionFocus,
    sectorFocus,
    trackingIndex,
    excludeFixedTerm = true,
  } = filter;
  const conds = [];
  if (activeOnly) conds.push(eq(fundCatalog.status, "active"));
  if (assetClass) conds.push(eq(fundCatalog.assetClass, assetClass));
  if (taxIncentive) conds.push(eq(fundCatalog.taxIncentiveType, taxIncentive));
  if (region) conds.push(eq(fundCatalog.investRegion, region));
  if (regionFocus) conds.push(eq(fundCatalog.regionFocus, regionFocus));
  if (sectorFocus) conds.push(eq(fundCatalog.sectorFocus, sectorFocus));
  if (excludeFixedTerm) conds.push(eq(fundCatalog.isFixedTerm, false));

  // Index/active facet in SQL (uses idx_fund_catalog_mgmt_style). The 'active'
  // bucket must include NULL styles explicitly — in SQL, `x NOT IN (…)` is
  // NULL (falsy) when x is NULL, so a bare NOT IN would silently drop the
  // ~thousands of funds with no published style.
  const resolvedIndexType = indexType ?? (indexOnly ? "index" : undefined);
  const INDEX_STYLES = ["PN", "PM"];
  if (resolvedIndexType === "index") {
    conds.push(inArray(fundCatalog.managementStyle, INDEX_STYLES));
  } else if (resolvedIndexType === "active") {
    const activeCond = or(
      not(inArray(fundCatalog.managementStyle, INDEX_STYLES)),
      isNull(fundCatalog.managementStyle),
    );
    if (activeCond) conds.push(activeCond);
  }

  // "Tracks X" = family + index style (see the filter doc). Composes with the
  // facet above: combined with indexType 'active' it correctly yields nothing.
  if (trackingIndex) {
    conds.push(eq(fundCatalog.indexFamily, trackingIndex));
    conds.push(inArray(fundCatalog.managementStyle, INDEX_STYLES));
  }

  // Relevance rank by projId when a text query is present (0 = best match).
  // Absent → all funds share rank 0 and we fall back to TER ordering below.
  const queryStr = query?.trim();
  let relevanceRank: Map<string, number> | null = null;
  if (queryStr) {
    const ranked = searchFundIds(queryStr);
    if (ranked.length === 0) return []; // no text match → no results
    relevanceRank = new Map(ranked.map((id, i) => [id, i]));
    // Constrain the SQL fetch to the matched candidate set; the structured
    // filters above still apply on top, so e.g. activeOnly is honored.
    conds.push(inArray(fundCatalog.projId, ranked));
  }

  const funds = getMarketDb()
    .select(CATALOG_LIST_COLUMNS)
    .from(fundCatalog)
    .where(conds.length ? and(...conds) : undefined)
    .all();

  // TER rides along with the catalog row (fund_catalog.current_ter — a derived
  // cache maintained by upsertFundFees), so no fee query is needed here at all.
  const withTer: FundWithTer[] = funds.map((f) => ({
    ...f,
    ter: f.currentTer ?? null,
  }));

  // A non-positive TER means "no published fee" (institutional/private funds
  // report 0, fees charged elsewhere) — sort it last like a null, not as the
  // cheapest, so a zero-TER fund can't top the cheapest-first default.
  const effTer = (t: number | null) => (t != null && t > 0 ? t : null);
  const byTer = (a: FundWithTer, b: FundWithTer) => {
    const ta = effTer(a.ter);
    const tb = effTer(b.ter);
    if (ta == null) return tb == null ? 0 : 1; // null/zero last
    if (tb == null) return -1;
    return ta - tb;
  };

  if (relevanceRank) {
    // Relevance first; TER (then nulls-last) only breaks ties at equal rank.
    withTer.sort((a, b) => {
      const ra = relevanceRank.get(a.projId) ?? Number.MAX_SAFE_INTEGER;
      const rb = relevanceRank.get(b.projId) ?? Number.MAX_SAFE_INTEGER;
      return ra !== rb ? ra - rb : byTer(a, b);
    });
  } else {
    withTer.sort(byTer);
  }

  return withTer.slice(0, limit);
}

/** One entry of the live "Tracks" facet menu. */
export interface TrackedIndexFamily {
  /** Canonical fund_catalog.index_family value ("S&P 500", "SET50", …). */
  indexFamily: string;
  /** Buyable share classes tracking it — matches the screener's result count. */
  trackers: number;
}

/**
 * Every index family with at least one tracker, most-tracked first. Backs the
 * Explore "Tracks" dropdown — derived live so the menu follows the nightly refresh
 * and can never offer an empty result.
 *
 * `trackers` counts the priceable SHARE CLASSES the screener returns for that
 * family (not parent funds), applying the same gates findShareClasses does —
 * active PN/PM, non-fixed-term, retail-or-unknown fund, non-institutional/insurance
 * class — so the badge equals the "Showing N classes" the user lands on.
 */
export function listTrackedIndexFamilies(): TrackedIndexFamily[] {
  return getMarketDb()
    .select({
      indexFamily: fundCatalog.indexFamily,
      trackers: sql<number>`count(*)`,
    })
    .from(fundShareClasses)
    .innerJoin(fundCatalog, eq(fundCatalog.projId, fundShareClasses.projId))
    .where(
      and(
        isNotNull(fundCatalog.indexFamily),
        eq(fundCatalog.status, "active"),
        inArray(fundCatalog.managementStyle, ["PN", "PM"]),
        eq(fundCatalog.isFixedTerm, false),
        or(isNull(fundCatalog.projRetailType), eq(fundCatalog.projRetailType, "R")),
        or(
          isNull(fundShareClasses.investorType),
          not(inArray(fundShareClasses.investorType, ["institutional", "insurance"])),
        ),
      ),
    )
    .groupBy(fundCatalog.indexFamily)
    .orderBy(sql`count(*) DESC`, fundCatalog.indexFamily)
    .all() as TrackedIndexFamily[];
}

/** A priceable share class for the Explore screener — class facts + parent metadata + NAV. */
export interface ShareClassListItem {
  /** Priceable ticker (the class code, or the abbr for single-class funds). */
  ticker: string;
  className: string;
  projId: string;
  abbrName: string | null;
  thaiName: string | null;
  englishName: string | null;
  amcName: string | null;
  assetClass: string | null;
  managementStyle: string | null;
  /** 'index' = pure passive (PN/PM); 'active' = everything else, incl. unknown style. */
  indexType: "index" | "active";
  investRegion: string | null;
  isFeederFund: boolean;
  /** Master fund name when this is a feeder fund; null otherwise. */
  feederMasterFund: string | null;
  /** 'accumulating' | 'dividend' | null. */
  distributionPolicy: string | null;
  /** 'retail' | 'restricted' | 'institutional' | 'insurance' | null. */
  investorType: string | null;
  /** 'SSF' | 'RMF' | 'ThaiESG' | null (per class). */
  taxIncentiveType: string | null;
  /** Per-class TER (falls back to the parent's derived TER). */
  ter: number | null;
  /**
   * Investor-eligibility tier (from the parent's SEC `proj_retail_type`):
   * 'retail' | 'accredited' | 'ultra' | 'provident' | 'institutional'. Drives
   * the row badge and the buy-list vs search gating.
   */
  retailTier: RetailTier;
  /** True when the parent fund is fixed-term (deprioritized in search). */
  isFixedTerm: boolean;
  /** Latest cached NAV for this class, if any. */
  nav: number | null;
  navAsOf: string | null;
  /** Trailing 1-year return %, if cached. */
  y1Pct: number | null;
  /** Latest cached fund size (AUM, THB), if any — drives popularity ordering. */
  aum: number | null;
}

/**
 * A demoted search hit (non-buyable tier, fixed-term, or institutional class)
 * survives only if its relevance score clears this fraction of the top hit's
 * score — i.e. it's a near-exact match, not generic-query noise. Tuned so an
 * exact code/name finds the fund while a broad query ("gold") doesn't surface
 * funds the user can't buy. Exact ticker/abbr matches bypass it entirely.
 */
const SEARCH_STRONG_FRACTION = 0.5;

/**
 * Screener variant of {@link findFunds} that returns priceable SHARE CLASSES
 * rather than parent funds (decision D2b — NAV/fees/tax are per class). Reuses
 * findFunds for parent matching/ordering (relevance or cheapest-TER), then
 * expands each parent to its classes and applies class-level filters.
 *
 * The browse list and search diverge by intent (each fund's investor-eligibility
 * tier comes from {@link retailTier}):
 *   • BROWSE (no query) filters to exactly the audience the `access` facet
 *     selects ({@link browseTiers}) — default = the retail buy list; "accredited"
 *     / "ultra" / "both" show only those restricted tiers. Institutional/insurance
 *     CLASSES are hidden. Fixed-term funds stay excluded (`excludeFixedTerm`
 *     default).
 *   • SEARCH (query) finds ANY active fund — a user may hold a fixed-term,
 *     accredited, or provident fund — but DEPRIORITIZES the non-buyable ones:
 *     they surface only on a strong/exact match (so a generic query isn't
 *     polluted with funds the user can't buy), and rank below buyable hits.
 *
 * findFunds is left untouched — the advisor `find_funds` tool still gets parents.
 */
export function findShareClasses(filter: FindFundsFilter & { access?: AccessTier } = {}): {
  items: ShareClassListItem[];
  total: number;
  /** Breakdown over the FULL eligible set (not the returned window). */
  withTer: number;
  indexCount: number;
} {
  const { limit = 50, taxIncentive, access, ...rest } = filter;
  const hasQuery = !!filter.query?.trim();
  // Expand EVERY eligible parent into its classes, rank the whole set, then window
  // it with `limit`. The requested `limit` slices the final list only — it must
  // NOT bound the pool, or the reported `total` (and the "Load more" reachability
  // it drives) would drift as the user pages deeper. findFunds fetches all matches
  // from SQL then sorts, so an unbounded cap there is cheap; the per-parent class
  // fetch below is the only cost that scales with the pool, and browse already
  // expanded ~1000 parents per request before. Search is relevance-ranked and
  // narrow, so the matched set is the natural full pool.
  const parents = findFunds({
    ...rest,
    taxIncentive: undefined,
    // Search finds any ACTIVE fund the user might hold, so don't drop fixed-term
    // parents up front — they're deprioritized below instead. Browse keeps the
    // caller's excludeFixedTerm (default-on: a buy list, not a holdings search).
    excludeFixedTerm: hasQuery ? false : rest.excludeFixedTerm,
    limit: hasQuery ? Math.max(limit * 4, 200) : Number.MAX_SAFE_INTEGER,
  });

  // Gather every eligible class across the pool. Browse ranks the whole set by
  // per-class TER below; search preserves the parent's relevance order. We collect
  // all of them (no early stop) so `total` reflects the full reachable catalog and
  // each larger page is a strict superset of the smaller one.
  const out: ShareClassListItem[] = [];
  const parentOrder = new Map<string, number>();
  let order = 0;
  // Browse filters to exactly the chosen audience (exclusive, like every facet);
  // search keeps every tier and deprioritizes the non-buyable ones below.
  const shownTiers = browseTiers(access);
  for (const p of parents) {
    const tier = retailTier(p.projRetailType);
    if (!hasQuery && !shownTiers.has(tier)) continue;
    const classes = listShareClassesByProj(p.projId).filter((c) => {
      if (taxIncentive && c.taxIncentiveType !== taxIncentive) return false;
      // Browse hides classes an individual genuinely can't buy directly —
      // institutional and insurance (unit-linked). `restricted` (provident /
      // private / special-group) is KEPT and down-ranked by the comparator
      // (it's investable in principle); null (unknown) is kept too. Search keeps
      // even institutional/insurance classes (demoted) so an exact code finds them.
      if (!hasQuery && (c.investorType === "institutional" || c.investorType === "insurance"))
        return false;
      return true;
    });
    if (classes.length === 0) continue;
    parentOrder.set(p.projId, order++);
    for (const c of classes) {
      out.push({
        ticker: c.ticker,
        className: c.className,
        projId: p.projId,
        abbrName: p.abbrName,
        thaiName: p.thaiName,
        englishName: p.englishName,
        amcName: p.amcName,
        assetClass: p.assetClass,
        managementStyle: p.managementStyle,
        indexType: indexTypeFromManagementStyle(p.managementStyle),
        investRegion: p.investRegion,
        isFeederFund: p.isFeederFund,
        feederMasterFund: p.feederMasterFund,
        distributionPolicy: c.distributionPolicy,
        investorType: c.investorType,
        taxIncentiveType: c.taxIncentiveType,
        ter: c.currentTer ?? p.ter ?? null,
        retailTier: tier,
        isFixedTerm: !!p.isFixedTerm,
        nav: null,
        navAsOf: null,
        y1Pct: null,
        aum: null,
      });
    }
  }

  if (out.length === 0) return { items: [], total: 0, withTer: 0, indexCount: 0 };

  // ── Search (query) ──────────────────────────────────────────────────────────
  // Relevance first, so a great name match isn't buried by a cheaper unrelated
  // class. Families stay grouped (parentOrder = relevance) and compareClassesForList
  // ranks within a family — which considers AUM, so the whole set needs quotes
  // before sorting. That's fine: relevance has already narrowed `out` to the match
  // set, so attaching it all is cheap (unlike browse, which spans the catalog).
  if (hasQuery) {
    attachQuotesAndAum(out);
    const q = filter.query?.trim().toLowerCase() ?? "";

    // A row is "demoted" when it wouldn't show in the buy list at this access
    // level (restricted tier, or an institutional/insurance class) or it's
    // fixed-term. Demoted rows are kept only on a strong/exact match and always
    // rank below buyable hits.
    const isDemoted = (o: ShareClassListItem) =>
      !isTierBuyable(o.retailTier, access) ||
      o.isFixedTerm ||
      o.investorType === "institutional" ||
      o.investorType === "insurance";

    // Relevance scores (per parent fund) gate the demoted rows: keep one only if
    // it's an exact ticker/abbr match or scores near the top hit.
    const scored = searchFundIdsScored(filter.query?.trim() ?? "");
    const topScore = scored[0]?.score ?? 0;
    const scoreByProj = new Map(scored.map((s) => [s.id, s.score]));
    const strongMatch = (o: ShareClassListItem) =>
      o.ticker.toLowerCase() === q ||
      o.abbrName?.toLowerCase() === q ||
      (scoreByProj.get(o.projId) ?? 0) >= SEARCH_STRONG_FRACTION * topScore;

    const demotedOf = new Map<ShareClassListItem, boolean>();
    const eligible = out.filter((o) => {
      const dem = isDemoted(o);
      demotedOf.set(o, dem);
      return dem ? strongMatch(o) : true;
    });

    eligible.sort((a, b) => {
      const da = demotedOf.get(a) ? 1 : 0;
      const dbn = demotedOf.get(b) ? 1 : 0;
      if (da !== dbn) return da - dbn; // buyable hits above demoted ones
      const pa = parentOrder.get(a.projId) ?? Number.MAX_SAFE_INTEGER;
      const pb = parentOrder.get(b.projId) ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      // Same parent → same abbr, so a.abbrName drives the flagship-ticker check.
      return compareClassesForList(a.abbrName)(a, b);
    });
    // The user typed a specific class code (e.g. "SCBGOLDP") → float that exact
    // ticker to the very top, ahead of its siblings and every other family.
    if (q) {
      const idx = eligible.findIndex((x) => x.ticker.toLowerCase() === q);
      if (idx > 0) eligible.unshift(eligible.splice(idx, 1)[0]);
    }
    const withTer = eligible.filter((o) => o.ter != null).length;
    const indexCount = eligible.filter((o) => o.indexType === "index").length;
    return { items: eligible.slice(0, limit), total: eligible.length, withTer, indexCount };
  }

  // ── Browse (no query) ───────────────────────────────────────────────────────
  // Rank each priceable class on its OWN TER — the screener is a fee finder, so a
  // row's position must match the TER it shows, and a cheap sibling must NOT lift
  // an expensive class up with it. Ties → larger AUM, then retail before
  // restricted, then ticker. Zero/null TER sorts last.
  //
  // The AUM tie-break must rank the WHOLE eligible set BEFORE slicing — this
  // catalog has large blocks of identical TER (e.g. many funds at 0.10%), so a
  // window-local tie-break would reshuffle those rows as the limit grows and the
  // "Load more" list would no longer be a strict superset (rank 100 would change
  // funds when you load 200). So attach quotes/AUM to the full set, then sort, then
  // slice — the slice is a stable prefix at every limit.
  attachQuotesAndAum(out);
  const effTer = (t: number | null) => (t != null && t > 0 ? t : null);
  const audienceTier = (c: ShareClassListItem) =>
    c.investorType === "retail" ? 0 : c.investorType == null ? 1 : 2;
  out.sort((a, b) => {
    const ta = effTer(a.ter);
    const tb = effTer(b.ter);
    if (ta == null && tb != null) return 1; // null/zero TER last
    if (ta != null && tb == null) return -1;
    if (ta != null && tb != null && ta !== tb) return ta - tb; // cheaper class first
    const aa = a.aum ?? -1;
    const ab = b.aum ?? -1;
    if (aa !== ab) return ab - aa; // larger AUM first
    const at = audienceTier(a) - audienceTier(b);
    if (at !== 0) return at; // retail before restricted
    return a.ticker.localeCompare(b.ticker);
  });
  // Counts over the full eligible set (not the returned window).
  const withTer = out.filter((o) => o.ter != null).length;
  const indexCount = out.filter((o) => o.indexType === "index").length;
  // `total` is the full eligible count; `items` is the requested window — a strict
  // prefix of the full sorted list, so growing `limit` only appends.
  return { items: out.slice(0, limit), total: out.length, withTer, indexCount };
}

/** Batch-attach latest NAV/quote (fund_quotes) + latest AUM (nav_history) per class. */
function attachQuotesAndAum(items: ShareClassListItem[]): void {
  const db = getMarketDb();
  const keyOf = (t: string) => quoteCacheKey("thai_mutual_fund", t);
  const keys = items.map((x) => keyOf(x.ticker));

  const quotes = db
    .select({
      ticker: fundQuotes.ticker,
      nav: fundQuotes.nav,
      updatedAt: fundQuotes.updatedAt,
      y1Pct: fundQuotes.y1Pct,
    })
    .from(fundQuotes)
    .where(inArray(fundQuotes.ticker, keys))
    .all();
  const qmap = new Map(quotes.map((q) => [q.ticker, q]));

  // Latest non-null net_asset per ticker (some NAV rows carry a NULL net_asset).
  // The correlated `ORDER BY date DESC LIMIT 1` resolves each ticker through the
  // partial idx_nav_history_aum index instead of scanning all ~3M nav_history
  // rows for a GROUP BY MAX — ~5ms vs ~500ms across the full screener set.
  // json_each carries the key list so it stays a single round-trip.
  const aumRows = db.all(
    sql`SELECT k.value AS ticker,
          (SELECT nh.net_asset FROM ${navHistory} nh
           WHERE nh.ticker = k.value AND nh.net_asset IS NOT NULL
           ORDER BY nh.date DESC LIMIT 1) AS aum
        FROM json_each(${JSON.stringify(keys)}) k`,
  ) as Array<{ ticker: string; aum: number | null }>;
  const amap = new Map(aumRows.map((r) => [r.ticker, r.aum]));

  for (const x of items) {
    const qrow = qmap.get(keyOf(x.ticker));
    if (qrow) {
      x.nav = qrow.nav;
      x.navAsOf = qrow.updatedAt;
      x.y1Pct = qrow.y1Pct ?? null;
    }
    x.aum = amap.get(keyOf(x.ticker)) ?? null;
  }
}

/**
 * Given a fund the user holds, find cheaper funds with comparable exposure
 * ranked by TER. Powers the "fee creep" flag in Analyze and the advisor's
 * cheaper-alternative suggestion. Returns only funds strictly cheaper than the
 * reference, capped.
 *
 * "Comparable" means same ACTUAL exposure, not just broad asset class: a
 * suggested peer must share the reference fund's normalized `assetClass`,
 * its geographic mandate (`investRegion`), its index/active character, AND its
 * derived region/sector focus. Asset class alone is too loose — it would offer
 * a Thai-equity fund as an "alternative" to a global-equity one, an active
 * fund for an index fund, or a gold fund for a diversified one (a different
 * product, not a cheaper version of the same one). We deliberately err toward
 * showing nothing over showing a wrong match.
 *
 * Region matching is exact, including null: if the reference has no region we
 * only match other region-less funds, never a fund with a differing non-null
 * region. (`findFunds`' `region` filter can't express "region IS NULL", so we
 * apply the region predicate here in JS.)
 */
export function getCheaperAlternatives(projId: string, limit = 5): FundWithTer[] {
  const ref = getMarketDb().select().from(fundCatalog).where(eq(fundCatalog.projId, projId)).get();
  if (!ref) return [];
  const refTer = getCurrentTer(projId);
  if (refTer == null) return [];

  const peers = findFunds({ assetClass: ref.assetClass ?? undefined, limit: 200 });
  return filterCheaperAlternatives(ref, refTer, peers, limit);
}

/**
 * The pure "is this a cheaper version of the same product" filter, split out so a
 * caller that already holds the reference row + a fetched peer pool (e.g. the
 * fee-creep pass, which fetches one pool per asset class instead of one per holding)
 * reuses the exact same matching rule rather than re-deriving it.
 *
 * `peers` must already be scoped to the reference's asset class (that's the only
 * predicate {@link getCheaperAlternatives} pushes into SQL); every other facet is
 * applied here. Facet semantics differ:
 *   • regionFocus null = "we don't know" → enforce equality only when BOTH sides are
 *     known (don't punish unknowns beyond the coarse investRegion match, which still
 *     applies exactly including null).
 *   • sectorFocus null = "diversified" → exact match including null: a gold fund is
 *     never a cheaper version of a diversified fund, and vice versa.
 */
export function filterCheaperAlternatives(
  ref: Pick<Fund, "projId" | "investRegion" | "managementStyle" | "regionFocus" | "sectorFocus">,
  refTer: number,
  peers: FundWithTer[],
  limit: number,
): FundWithTer[] {
  const regionCompatible = (a: string | null, b: string | null) =>
    a == null || b == null || a === b;
  return peers
    .filter(
      (f) =>
        f.projId !== ref.projId &&
        f.ter != null &&
        f.ter < refTer &&
        f.investRegion === ref.investRegion &&
        isIndexStyle(f.managementStyle) === isIndexStyle(ref.managementStyle) &&
        regionCompatible(f.regionFocus, ref.regionFocus) &&
        f.sectorFocus === ref.sectorFocus,
    )
    .slice(0, limit);
}

/**
 * Resolve each ticker's `quote_source` against the REAL fund catalog — the SINGLE
 * authority for both the importer's source badge and the autocomplete suggestions.
 * A ticker in `fund_share_classes` / `fund_catalog` is a real, priceable fund;
 * anything else is a `manual` (custom, self-priced) asset. No shape heuristic and no
 * static seed — when stocks / ETFs / etc. join the catalog they resolve here the
 * same way (today the catalog holds Thai funds only). Keys are UPPER-CASED tickers.
 */
export function catalogQuoteSource(tickers: string[]): Map<string, QuoteSource> {
  const out = new Map<string, QuoteSource>();
  const cleaned = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
  if (cleaned.length === 0) return out;
  const db = getMarketDb();
  // A symbol is a real Thai fund if it's a priceable share-class ticker OR a parent
  // fund abbreviation (single-class funds expose the parent abbr as the holdable
  // ticker; matching both also covers a partially-derived catalog). Match
  // CASE-INSENSITIVELY: catalog tickers are mixed-case (K-FIXED-A upper, the ttb
  // "tsp1-preserver-SSF" funds lower), and `cleaned` is upper-cased — so compare
  // upper(ticker) or a lowercase code would never hit and would wrongly read custom.
  const hits = new Set<string>();
  for (const r of db
    .select({ ticker: fundShareClasses.ticker })
    .from(fundShareClasses)
    .where(inArray(sql`upper(${fundShareClasses.ticker})`, cleaned))
    .all())
    hits.add(r.ticker.toUpperCase());
  for (const r of db
    .select({ abbr: fundCatalog.abbrName })
    .from(fundCatalog)
    .where(inArray(sql`upper(${fundCatalog.abbrName})`, cleaned))
    .all())
    if (r.abbr) hits.add(r.abbr.toUpperCase());
  // Not a Thai fund? A US-listed stock/ETF/index is market-priced (checked after
  // the Thai catalog so a Thai code always wins its own catalog). Everything else
  // is custom.
  const usHits = new Set<string>();
  const unmatched = cleaned.filter((t) => !hits.has(t));
  if (unmatched.length > 0) {
    for (const r of db
      .select({ symbol: usSecurities.symbol })
      .from(usSecurities)
      .where(inArray(sql`upper(${usSecurities.symbol})`, unmatched))
      .all())
      usHits.add(r.symbol.toUpperCase());
  }
  for (const t of cleaned)
    out.set(t, hits.has(t) ? "thai_mutual_fund" : usHits.has(t) ? "market" : "manual");
  return out;
}

/**
 * Map each input ticker to its OFFICIAL catalog case (#235). A cataloged fund is
 * stored in the catalog's native case (`fund_share_classes.ticker` or
 * `fund_catalog.abbr_name`, e.g. the lowercase `tsp1-preserver-SSF` family); we
 * persist THAT case on the ledger so the user sees the real symbol and even a
 * case-sensitive comparison lines up. A ticker with no catalog match (a custom /
 * self-priced asset, or a cash-account name) keeps exactly what the user typed
 * (trimmed) — its case is the user's to choose. Returned map is keyed by
 * `tickerKey` (upper); look up with `tickerKey(input)`. The share-class ticker
 * wins over the parent abbr on the rare overlap (it's the priceable unit).
 */
export function canonicalTickerMap(tickers: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const cleaned = [...new Set(tickers.map((t) => tickerKey(t)).filter(Boolean))];
  if (cleaned.length === 0) return out;
  const db = getMarketDb();
  // Parent abbr first, then share-class ticker overwrites it (priceable unit wins).
  for (const r of db
    .select({ abbr: fundCatalog.abbrName })
    .from(fundCatalog)
    .where(inArray(sql`upper(${fundCatalog.abbrName})`, cleaned))
    .all())
    if (r.abbr) out.set(tickerKey(r.abbr), r.abbr);
  for (const r of db
    .select({ ticker: fundShareClasses.ticker })
    .from(fundShareClasses)
    .where(inArray(sql`upper(${fundShareClasses.ticker})`, cleaned))
    .all())
    out.set(tickerKey(r.ticker), r.ticker);
  return out;
}

/**
 * The official catalog case for one ticker, or the trimmed input when it's not a
 * cataloged fund (custom asset / cash name keep the user's case). See
 * {@link canonicalTickerMap}.
 */
export function canonicalTicker(ticker: string): string {
  const trimmed = ticker.trim();
  return canonicalTickerMap([trimmed]).get(tickerKey(trimmed)) ?? trimmed;
}

/**
 * The stable catalog identity of a priceable share class (#235): the fund's
 * CURRENT ticker plus the identifiers a holding anchors to. A fund house can
 * rename the ticker (and, for multi-class funds, the class_name) over time, but
 * `uid`/`isin`/`(projId, className)` are progressively more stable — so a renamed
 * fund stays linked even after its symbol leaves the catalog.
 */
export interface CatalogSymbol {
  projId: string;
  className: string;
  /** The fund's CURRENT symbol (catalog case) — may differ from a held old code. */
  currentTicker: string;
  /** Per-class ISIN — global, rename-proof; null when unpublished. */
  isin: string | null;
}

const SHARE_CLASS_COLS = {
  projId: fundShareClasses.projId,
  className: fundShareClasses.className,
  ticker: fundShareClasses.ticker,
  isin: fundShareClasses.isinCode,
};
type ShareClassRow = {
  projId: string;
  className: string;
  ticker: string;
  isin: string | null;
};
const toSymbol = (r: ShareClassRow): CatalogSymbol => ({
  projId: r.projId,
  className: r.className,
  currentTicker: r.ticker,
  isin: r.isin,
});

/** Resolve a stored anchor `(projId, className)` to the current share class. */
export function resolveShareClassByAnchor(projId: string, className: string): CatalogSymbol | null {
  const db = getMarketDb();
  const sc = db
    .select(SHARE_CLASS_COLS)
    .from(fundShareClasses)
    .where(and(eq(fundShareClasses.projId, projId), eq(fundShareClasses.className, className)))
    .get();
  if (sc) return toSymbol(sc);
  // A single-class fund exposes the parent abbr as the holdable ticker.
  if (className === "main") {
    const cat = db
      .select({ abbr: fundCatalog.abbrName })
      .from(fundCatalog)
      .where(eq(fundCatalog.projId, projId))
      .get();
    if (cat?.abbr) return { projId, className, currentTicker: cat.abbr, isin: null };
  }
  return null;
}

/** Resolve a held ticker to its catalog share class (share-class match first, then
 * parent abbr for single-class funds). Returns null for a custom / off-catalog symbol. */
export function resolveShareClassByTicker(ticker: string): CatalogSymbol | null {
  const key = tickerKey(ticker);
  if (!key) return null;
  const db = getMarketDb();
  const sc = db
    .select(SHARE_CLASS_COLS)
    .from(fundShareClasses)
    .where(sql`upper(${fundShareClasses.ticker}) = ${key}`)
    .get();
  if (sc) return toSymbol(sc);
  const cat = db
    .select({ projId: fundCatalog.projId, abbr: fundCatalog.abbrName })
    .from(fundCatalog)
    .where(sql`upper(${fundCatalog.abbrName}) = ${key}`)
    .get();
  if (cat?.abbr)
    return { projId: cat.projId, className: "main", currentTicker: cat.abbr, isin: null };
  return null;
}

/**
 * Resolve a holding to its current catalog share class — the single chokepoint
 * (#235). Tries the stored anchor in order of STABILITY: the `isin` (a global
 * security id), then `(projId, className)` — so a multi-class rebrand that changes
 * even the class_name still resolves wherever an ISIN was captured. Falls back to a
 * ticker match for holdings created before the anchor was bound. Returns null for a
 * custom / cash holding (no catalog link).
 */
export function resolveCatalogSymbol(input: {
  ticker: string;
  catalogProjId?: string | null;
  catalogClassName?: string | null;
  catalogIsin?: string | null;
}): CatalogSymbol | null {
  const db = getMarketDb();
  if (input.catalogIsin) {
    // An ISIN can match >1 row: a renamed class leaves a lingering stale row (the
    // refresh never deletes), and the SEC feed has a couple of duplicate ISINs (one
    // cross-fund). When the stored anchor also carries a proj_id, prefer the row
    // that matches it — proj_id is stable, so this lands on the right fund even for
    // a cross-fund ISIN collision.
    if (input.catalogProjId) {
      const exact = db
        .select(SHARE_CLASS_COLS)
        .from(fundShareClasses)
        .where(
          and(
            eq(fundShareClasses.isinCode, input.catalogIsin),
            eq(fundShareClasses.projId, input.catalogProjId),
          ),
        )
        .orderBy(desc(fundShareClasses.updatedAt), sql`rowid desc`)
        .get();
      if (exact) return toSymbol(exact);
    }
    // Otherwise pick the most-recently-updated row sharing the ISIN (the nightly
    // refresh keeps the LIVE class fresh; rowid breaks an exact-timestamp tie toward
    // the newer row) so we always land on the current class.
    const r = db
      .select(SHARE_CLASS_COLS)
      .from(fundShareClasses)
      .where(eq(fundShareClasses.isinCode, input.catalogIsin))
      .orderBy(desc(fundShareClasses.updatedAt), sql`rowid desc`)
      .get();
    if (r) return toSymbol(r);
  }
  if (input.catalogProjId && input.catalogClassName) {
    const byAnchor = resolveShareClassByAnchor(input.catalogProjId, input.catalogClassName);
    if (byAnchor) return byAnchor;
  }
  return resolveShareClassByTicker(input.ticker);
}

/** Look up catalog rows for a set of fund symbols (e.g. the user's holdings). */
export function getFundsByAbbr(abbrNames: string[]): Fund[] {
  if (abbrNames.length === 0) return [];
  return getMarketDb()
    .select()
    .from(fundCatalog)
    .where(inArray(fundCatalog.abbrName, abbrNames))
    .all();
}

/** Count of funds in the catalog (used by the refresh job to log coverage). */
export function countFunds(activeOnly = false): number {
  const row = getMarketDb()
    .select({ n: sql<number>`count(*)` })
    .from(fundCatalog)
    .where(activeOnly ? eq(fundCatalog.status, "active") : undefined)
    .get();
  return row?.n ?? 0;
}
