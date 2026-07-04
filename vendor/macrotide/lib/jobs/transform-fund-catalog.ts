// Transform — the API-free half of the ELT crawl. Reads verbatim SEC payloads
// landed in `sec_raw` (by the land phase of refresh-fund-catalog) and derives the
// normalized `fund_catalog` + `fund_fees` rows. No network, no SEC key: it runs
// over local rows in seconds, so a classification change ships as a transform
// re-run (`npm run jobs:transform-catalog`), not an ~80-min re-crawl.
//
// The mappers below are pure (raw item → insert shape) and are the single place
// SEC fields become catalog columns — shared by the live crawl and the re-run.
//
// Scope: catalog + fees. Share classes (fund_share_classes) remain their own job
// (refresh-share-classes) — it reads the fund_fees this transform writes.

import { listFeederMasterMap } from "../db/queries/feeder-enrichment";
import {
  type FundBenchmarkInsert,
  type FundDividendHistoryInsert,
  type FundDividendPolicyInsert,
  type FundFactsheetUrlInsert,
  type FundSpecificationInsert,
  type FundStatisticsInsert,
  type FundSubscriptionMinimumInsert,
  upsertFundBenchmarks,
  upsertFundDividendHistory,
  upsertFundDividendPolicy,
  upsertFundFactsheetUrls,
  upsertFundSpecifications,
  upsertFundStatistics,
  upsertFundSubscriptionMinimums,
} from "../db/queries/fund-enrichment";
import {
  type FundFacetsUpdate,
  type FundFeeInsert,
  type FundInsert,
  updateFundFacets,
  upsertFund,
  upsertFundFees,
} from "../db/queries/funds";
import {
  listSecRawProjIds,
  readSecRaw,
  readSecRawItemFor,
  readSecRawItems,
  readSecRawItemsFor,
  SEC_ENDPOINTS,
} from "../db/queries/sec-raw";
import {
  classifyDistribution,
  classifyFxHedging,
  classifyInvestRegion,
  classifyTaxIncentive,
  deriveAssetClass,
  distributionFromDividendPolicy,
  statusFromSec,
  stripPolicyHtml,
} from "../market/fund-classify";
import { deriveFundFacets } from "../market/fund-facets";
import { normalizeFeeType, type SecFundFeeItem } from "../market/fund-fees";
import type {
  SecBenchmarkItem,
  SecDividendHistoryItem,
  SecDividendPolicyItem,
  SecFactsheetUrlItem,
  SecFundProfile,
  SecFundSpecificationItem,
  SecFundStatisticsItem,
  SecRiskSpectrumItem,
  SecSubscriptionMinimumItem,
} from "../market/providers/sec-thailand";
import { invalidateFundIndex } from "../search/fund-index";

// ─── Pure mappers (raw SEC item → catalog insert shape) ─────────────────────

/** AUM snapshot as landed under the `aum` endpoint (our derived shape, not raw SEC). */
export interface AumSnapshot {
  aum: number;
  aumDate: string;
}

/**
 * Map a verbatim SEC profile (+ optional AUM snapshot + risk-spectrum code) to a
 * `fund_catalog` row. This is where the SEC's fields become our normalized
 * taxonomy. Asset class is risk-spectrum-first (the structured signal), falling
 * back to policy_desc + the money-market name match; pass `rsCode = undefined`
 * (no landed risk-spectrum) to use the fallback alone.
 *
 * AUM is set only when present (active funds): inactive funds land no AUM, so the
 * field stays undefined and the upsert leaves any existing value intact.
 */
export function profileToFundInsert(
  p: SecFundProfile,
  aum?: AumSnapshot | null,
  rsCode?: string | null,
  dividendPolicyCode?: string | null,
): FundInsert {
  const secStatus = p.fund_status ?? null;
  const feederMaster = p.feederfund_master_fund ?? null;
  const isFixedTerm = p.proj_term_flag === "Y";
  // Term components only mean anything on fixed-term funds — the SEC sends 0s
  // elsewhere, which would read as a "0-day term" rather than "open-ended".
  const term = (n: number | null | undefined) =>
    isFixedTerm && n != null && Number.isFinite(Number(n)) ? Number(n) : null;

  const insert: FundInsert = {
    projId: p.proj_id,
    abbrName: p.proj_abbr_name,
    thaiName: p.proj_name_th ?? null,
    englishName: p.proj_name_en ?? null,
    amcName: p.amc_name ?? null,
    // fundType is not returned by v2; keep null so we don't wipe any existing value.
    fundType: null,
    policyDesc: p.policy_desc ?? null,
    policyDescTh: p.policy_desc ?? null,
    assetClass: deriveAssetClass(rsCode, p.policy_desc, p.proj_name_th, p.proj_name_en),
    riskSpectrum: rsCode ?? null,
    managementStyle: p.management_style ?? null,
    taxIncentiveType: classifyTaxIncentive(p.fund_class_tax_incentive_type),
    // Formal factsheet code first (authoritative), Thai-text parsing as fallback.
    distributionPolicy:
      distributionFromDividendPolicy(dividendPolicyCode) ??
      classifyDistribution(p.fund_class_detail),
    investRegion: classifyInvestRegion(p.invest_country_flag),
    isFeederFund: !!feederMaster,
    feederMasterFund: feederMaster,
    // Master-fund DOMICILE (where it's registered) — kept as data, but never a
    // region signal: a Luxembourg/Ireland UCITS master can invest anywhere.
    feederFundCountry: p.feederfund_country?.trim() || null,
    investmentPolicyDesc: stripPolicyHtml(p.investment_policy_desc),
    fxHedgingPolicy: classifyFxHedging(p.exchange_rate_protection_policy),
    isFixedTerm,
    termYears: term(p.proj_term_year),
    termMonths: term(p.proj_term_month),
    termDays: term(p.proj_term_day),
    initDate: p.init_date ?? null,
    regisDate: p.regis_date?.trim() || null,
    cancelDate: p.cancel_date?.trim() || null,
    isinCode: p.fund_class_isin_code ?? null,
    secStatus,
    status: statusFromSec(secStatus),
    projRetailType: p.proj_retail_type ?? null,
  };

  if (aum != null) {
    insert.aum = aum.aum;
    insert.aumDate = aum.aumDate;
  }

  return insert;
}

/** SEC figures arrive as strings ("24.63", "-0.02"); parse or null — never NaN. */
function numOrNull(s: string | number | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = typeof s === "number" ? s : Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Map a verbatim SEC benchmark item to a `fund_benchmarks` row, or null when it names no benchmark. */
export function benchmarkItemToRow(item: SecBenchmarkItem): FundBenchmarkInsert | null {
  const benchmark = item.benchmark?.trim();
  if (!item.proj_id || !benchmark) return null;
  return {
    projId: item.proj_id,
    groupSeq: numOrNull(item.group_seq) ?? 1,
    benchmark,
    benchmarkRemark: item.benchmark_remark?.trim() || null,
    startDate: item.start_date ?? null,
    endDate: item.end_date ?? null,
    prospectusType: item.prospectus_type ?? null,
    lastUpdDate: item.last_upd_date ?? null,
  };
}

/** Map a verbatim SEC statistics item to a `fund_statistics` row (parsing the string figures). */
export function statisticsItemToRow(item: SecFundStatisticsItem): FundStatisticsInsert | null {
  if (!item.proj_id) return null;
  return {
    projId: item.proj_id,
    fundClassName: item.fund_class_name ?? "main",
    portfolioTurnoverRatio: numOrNull(item.portfolio_turnover_ratio),
    maximumDrawdown: numOrNull(item.maximum_drawdown),
    sharpeRatio: numOrNull(item.sharpe_ratio),
    beta: numOrNull(item.beta),
    alpha: numOrNull(item.alpha),
    fxHedgingRatio: numOrNull(item.fx_hedging),
    trackingError: numOrNull(item.tracking_error),
    yieldToMaturity: item.yield_to_maturity?.trim() || null,
    recoveringPeriod: item.recovering_period?.trim() || null,
    portfolioDurationPeriod: item.portfolio_duration_period?.trim() || null,
    startDate: item.start_date ?? null,
    endDate: item.end_date ?? null,
    prospectusType: item.prospectus_type ?? null,
    lastUpdDate: item.last_upd_date ?? null,
  };
}

/** Map a verbatim SEC specification item to a `fund_specifications` row. */
export function specificationItemToRow(
  item: SecFundSpecificationItem,
): FundSpecificationInsert | null {
  const specCode = item.spec_code?.trim();
  if (!item.proj_id || !specCode) return null;
  return {
    projId: item.proj_id,
    fundClassName: item.fund_class_name ?? "main",
    specCode,
    specDesc: item.spec_desc?.trim() || null,
    lastUpdDate: item.last_upd_date ?? null,
  };
}

/** Map a verbatim SEC factsheet-URL item to a `fund_factsheet_urls` row. */
export function factsheetUrlItemToRow(item: SecFactsheetUrlItem): FundFactsheetUrlInsert | null {
  const amcUrl = item.amc_url_factsheet?.trim() || null;
  const pdfUrl = item.pdf_factsheet?.trim() || null;
  if (!item.proj_id || (!amcUrl && !pdfUrl)) return null;
  return {
    projId: item.proj_id,
    fundClassName: item.fund_class_name ?? "main",
    amcUrlFactsheet: amcUrl,
    pdfFactsheet: pdfUrl,
    asOfDate: item.as_of_date ?? null,
    prospectusType: item.prospectus_type ?? null,
    lastUpdDate: item.last_upd_date ?? null,
  };
}

/** Map a verbatim SEC minimums item to a `fund_subscription_minimums` row. */
export function minimumItemToRow(
  item: SecSubscriptionMinimumItem,
): FundSubscriptionMinimumInsert | null {
  if (!item.proj_id) return null;
  return {
    projId: item.proj_id,
    fundClassName: item.fund_class_name ?? "main",
    minimumSubIpo: numOrNull(item.minimum_sub_ipo),
    minimumSubIpoCur: item.minimum_sub_ipo_cur?.trim() || null,
    minimumSub: numOrNull(item.minimum_sub),
    minimumSubCur: item.minimum_sub_cur?.trim() || null,
    minimumSubUnit: item.minimum_sub_unit?.trim() || null,
    minimumRedempt: numOrNull(item.minimum_redempt),
    minimumRedemptCur: item.minimum_redempt_cur?.trim() || null,
    minimumRedemptUnit: item.minimum_redempt_unit?.trim() || null,
    lowbalVal: numOrNull(item.lowbal_val),
    lowbalValCur: item.lowbal_val_cur?.trim() || null,
    lowbalUnit: item.lowbal_unit?.trim() || null,
    startDate: item.start_date ?? null,
    endDate: item.end_date ?? null,
    prospectusType: item.prospectus_type ?? null,
    lastUpdDate: item.last_upd_date ?? null,
  };
}

/** Map a verbatim SEC dividend-policy item to a `fund_dividend_policy` row. */
export function dividendPolicyItemToRow(
  item: SecDividendPolicyItem,
): FundDividendPolicyInsert | null {
  if (!item.proj_id) return null;
  return {
    projId: item.proj_id,
    fundClassName: item.fund_class_name ?? "main",
    dividendPolicy: item.dividend_policy?.trim() || null,
    startDate: item.start_date ?? null,
    endDate: item.end_date ?? null,
    prospectusType: item.prospectus_type ?? null,
    lastUpdDate: item.last_upd_date ?? null,
  };
}

/** Map a verbatim SEC dividend-history item to a `fund_dividend_history` row. */
export function dividendHistoryItemToRow(
  item: SecDividendHistoryItem,
): FundDividendHistoryInsert | null {
  if (!item.proj_id || !item.book_close_date) return null;
  return {
    projId: item.proj_id,
    classAbbrName: item.class_abbr_name?.trim() || "main",
    bookCloseDate: item.book_close_date,
    dividendDate: item.dividend_date ?? null,
    dividendValue: numOrNull(item.dividend_value),
    lastUpdDate: item.last_upd_date ?? null,
  };
}

/** Map a verbatim SEC fee item to a `fund_fees` row (normalizing the fee type). */
export function feeItemToFeeRow(item: SecFundFeeItem): FundFeeInsert {
  return {
    projId: item.proj_id,
    fundClassName: item.fund_class_name,
    feeType: normalizeFeeType(item.fee_type_desc),
    feeTypeRaw: item.fee_type_desc,
    rateCeilingPct: item.rate ?? null,
    actualRatePct: item.actual_value ?? null,
    periodStart: item.start_date,
    periodEnd: item.end_date ?? null,
    prospectusType: item.prospectus_type ?? null,
    lastUpdDate: item.last_upd_date ?? null,
  };
}

// ─── Transform job ──────────────────────────────────────────────────────────

export interface TransformFundCatalogResult {
  /** Distinct funds whose catalog row was (re)derived from landed profiles. */
  fundsUpserted: number;
  /** Funds that had at least one landed fee row. */
  fundsWithFees: number;
  /** Total fee rows derived and upserted. */
  feeRowsUpserted: number;
  /** Funds with at least one landed benchmark row. */
  fundsWithBenchmarks: number;
  /** Funds with at least one landed statistics row. */
  fundsWithStatistics: number;
  /** Funds with at least one landed specification / factsheet-URL / minimums /
   * dividend-policy / dividend-history row. */
  fundsWithSpecifications: number;
  fundsWithFactsheetUrls: number;
  fundsWithMinimums: number;
  fundsWithDividendPolicy: number;
  fundsWithDividendHistory: number;
  /** Funds whose derived region focus was claimed (coverage of the facet). */
  fundsWithRegionFocus: number;
  /** Funds with an AIMC peer-group code (from the legacy v1 snapshot). */
  fundsWithAimcCategory: number;
}

/**
 * Derive one per-fund enrichment table from its landed sec_raw endpoint: map
 * each raw item, group rows per fund, replace each fund's set via its upsert.
 * Returns the count of distinct funds touched.
 */
function deriveGrouped<TItem, TRow extends { projId: string }>(
  endpoint: string,
  mapItem: (item: TItem) => TRow | null,
  upsert: (projId: string, rows: TRow[]) => void,
  eachRow?: (row: TRow) => void,
): number {
  let funds = 0;
  for (const projId of listSecRawProjIds(endpoint)) {
    const rows: TRow[] = [];
    for (const it of readSecRawItemsFor<TItem>(endpoint, projId)) {
      const row = mapItem(it);
      if (!row) continue;
      rows.push(row);
      eachRow?.(row);
    }
    if (rows.length === 0) continue;
    upsert(projId, rows);
    funds++;
  }
  return funds;
}

/**
 * Derive `fund_catalog` + `fund_fees` from the landed raw payloads in `sec_raw`.
 * Idempotent and API-free: safe to re-run any time to apply a mapper change to
 * the whole universe without touching the SEC API.
 *
 * Order matters for the FK + the derived TER cache: catalog rows first (fees
 * reference fund_catalog), then fees (whose upsert recomputes current_ter).
 */
export function transformFundCatalog(): TransformFundCatalogResult {
  // AUM snapshots first, keyed by projId, so the catalog mapping can merge them.
  const aumByProj = new Map<string, AumSnapshot>();
  for (const row of readSecRaw(SEC_ENDPOINTS.aum)) {
    try {
      aumByProj.set(row.projId, JSON.parse(row.payload) as AumSnapshot);
    } catch {
      // Skip an unparseable AUM row; the fund just keeps its prior AUM.
    }
  }

  // Latest risk-spectrum code per fund — the primary asset-class signal.
  const rsByProj = new Map<string, string>();
  for (const it of readSecRawItems<SecRiskSpectrumItem>(SEC_ENDPOINTS.riskSpectrum)) {
    if (it.proj_id && it.risk_spectrum) rsByProj.set(it.proj_id, it.risk_spectrum);
  }

  // Formal dividend-policy codes per (projId, class) — small items, read up
  // front so the profiles pass below can prefer them over Thai-text parsing.
  const divPolicyByKey = new Map<string, string>();
  for (const it of readSecRawItems<SecDividendPolicyItem>(SEC_ENDPOINTS.dividendPolicy)) {
    if (it.proj_id && it.dividend_policy?.trim()) {
      divPolicyByKey.set(
        `${it.proj_id}:${it.fund_class_name ?? "main"}`,
        it.dividend_policy.trim(),
      );
    }
  }

  // 1. Catalog rows from landed profiles (one landed row per fund), streamed —
  // profile payloads carry the long investment-policy text, so they're read
  // per fund here and again in the facet pass rather than held throughout.
  const profileIds = listSecRawProjIds(SEC_ENDPOINTS.profiles);
  let fundsUpserted = 0;
  for (const projId of profileIds) {
    const p = readSecRawItemFor<SecFundProfile>(SEC_ENDPOINTS.profiles, projId);
    if (!p?.proj_id) continue;
    upsertFund(
      profileToFundInsert(
        p,
        aumByProj.get(p.proj_id) ?? null,
        rsByProj.get(p.proj_id),
        divPolicyByKey.get(`${p.proj_id}:${p.fund_class_name ?? "main"}`),
      ),
    );
    fundsUpserted++;
  }

  // 2. Fee rows from landed fees (one landed row per fund holds its fee array).
  // STREAMED per fund, flushed in fund-batches, instead of materializing the
  // whole catalog's fee history at once: that history is ~800k rows and grows
  // every month, and holding it (plus every parsed payload) was the transform's
  // memory whale — a heap OOM at the job container's limit. Peak memory is now
  // one batch (~70k rows); upsertFundFees recomputes current_ter per flush.
  const FEE_FLUSH_FUNDS = 200;
  let fundsWithFees = 0;
  let feeRowsUpserted = 0;
  let feeBatch: FundFeeInsert[] = [];
  let feeBatchFunds = 0;
  for (const projId of listSecRawProjIds(SEC_ENDPOINTS.fees)) {
    const items = readSecRawItemFor<SecFundFeeItem[]>(SEC_ENDPOINTS.fees, projId);
    if (!Array.isArray(items) || items.length === 0) continue;
    fundsWithFees++;
    feeRowsUpserted += items.length;
    for (const item of items) feeBatch.push(feeItemToFeeRow(item));
    if (++feeBatchFunds >= FEE_FLUSH_FUNDS) {
      upsertFundFees(feeBatch);
      feeBatch = [];
      feeBatchFunds = 0;
    }
  }
  upsertFundFees(feeBatch);

  // 3. Per-fund enrichment tables from the landed bulk sweeps — each one maps,
  // groups per fund, and replaces that fund's set atomically (dividend history
  // appends instead — payments are never deleted).
  // The facet pass (step 4) needs each fund's benchmark STRINGS — tap them
  // here while the rows stream by, instead of re-reading the endpoint.
  const benchStringsByProj = new Map<string, Array<{ seq: number; benchmark: string }>>();
  const fundsWithBenchmarks = deriveGrouped<SecBenchmarkItem, FundBenchmarkInsert>(
    SEC_ENDPOINTS.benchmarks,
    benchmarkItemToRow,
    upsertFundBenchmarks,
    (row) => {
      const list = benchStringsByProj.get(row.projId) ?? [];
      list.push({ seq: row.groupSeq, benchmark: row.benchmark });
      benchStringsByProj.set(row.projId, list);
    },
  );
  const fundsWithStatistics = deriveGrouped<SecFundStatisticsItem, FundStatisticsInsert>(
    SEC_ENDPOINTS.statistics,
    statisticsItemToRow,
    upsertFundStatistics,
  );
  const fundsWithSpecifications = deriveGrouped<SecFundSpecificationItem, FundSpecificationInsert>(
    SEC_ENDPOINTS.specifications,
    specificationItemToRow,
    upsertFundSpecifications,
  );
  const fundsWithFactsheetUrls = deriveGrouped<SecFactsheetUrlItem, FundFactsheetUrlInsert>(
    SEC_ENDPOINTS.factsheetUrls,
    factsheetUrlItemToRow,
    upsertFundFactsheetUrls,
  );
  const fundsWithMinimums = deriveGrouped<
    SecSubscriptionMinimumItem,
    FundSubscriptionMinimumInsert
  >(SEC_ENDPOINTS.minimums, minimumItemToRow, upsertFundSubscriptionMinimums);
  const fundsWithDividendPolicy = deriveGrouped<SecDividendPolicyItem, FundDividendPolicyInsert>(
    SEC_ENDPOINTS.dividendPolicy,
    dividendPolicyItemToRow,
    upsertFundDividendPolicy,
  );
  const fundsWithDividendHistory = deriveGrouped<SecDividendHistoryItem, FundDividendHistoryInsert>(
    SEC_ENDPOINTS.dividendHistory,
    dividendHistoryItemToRow,
    upsertFundDividendHistory,
  );

  // 4. Derived facets (region/sector focus + index family) — computed from the
  // fund's benchmark strings (tapped in step 3) with name fallback, per
  // lib/market/fund-facets.ts. Runs last and writes via one batched update.
  // AIMC peer-group codes from the one-shot v1 snapshot (see
  // scripts/backfill-aimc-v1.ts — the v1 portal retires mid-2026, so this is
  // snapshot data, not a recurring crawl; absent rows simply claim nothing).
  const aimcByProj = new Map<string, string>();
  for (const row of readSecRaw(SEC_ENDPOINTS.aimcCategory)) {
    try {
      const code = (JSON.parse(row.payload) as { fund_compare?: string | null }).fund_compare;
      if (code?.trim()) aimcByProj.set(row.projId, code.trim());
    } catch {
      // Skip an unparseable row; a snapshot re-run re-lands it.
    }
  }

  const facetUpdates: Array<{ projId: string } & FundFacetsUpdate> = [];
  let fundsWithRegionFocus = 0;
  // Curated look-through master names (feeder_master_map) — covers feeders the
  // SEC profile's master-fund field misses, so facet derivation sees both.
  const curatedMasterByProj = new Map(
    listFeederMasterMap()
      .filter((m) => m.masterName)
      .map((m) => [m.projId, m.masterName as string]),
  );
  for (const projId of profileIds) {
    const p = readSecRawItemFor<SecFundProfile>(SEC_ENDPOINTS.profiles, projId);
    if (!p?.proj_id) continue;
    const benchmarks = (benchStringsByProj.get(p.proj_id) ?? [])
      .sort((a, b) => a.seq - b.seq)
      .map((b) => b.benchmark);
    const aimcCategory = aimcByProj.get(p.proj_id) ?? null;
    const facets = deriveFundFacets({
      benchmarks,
      aimcCategory,
      englishName: p.proj_name_en,
      thaiName: p.proj_name_th,
      feederMasterFund: p.feederfund_master_fund,
      curatedMasterName: curatedMasterByProj.get(p.proj_id) ?? null,
      investRegion: classifyInvestRegion(p.invest_country_flag),
    });
    if (facets.regionFocus) fundsWithRegionFocus++;
    facetUpdates.push({ projId: p.proj_id, ...facets, aimcCategory });
  }
  updateFundFacets(facetUpdates);

  // Drop the cached search index so the next search rebuilds over the fresh
  // catalog.
  invalidateFundIndex();

  return {
    fundsUpserted,
    fundsWithFees,
    feeRowsUpserted,
    fundsWithBenchmarks,
    fundsWithStatistics,
    fundsWithSpecifications,
    fundsWithFactsheetUrls,
    fundsWithMinimums,
    fundsWithDividendPolicy,
    fundsWithDividendHistory,
    fundsWithRegionFocus,
    fundsWithAimcCategory: aimcByProj.size,
  };
}
