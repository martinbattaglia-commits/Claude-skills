// Share-class refresh — enumerate every fund's share classes from the SEC
// profiles endpoint and upsert them into `fund_share_classes` (the priceable
// units). Cheap: it's the same paginated enumeration the catalog crawl runs,
// de-duped per class instead of per fund, so there are no per-fund API calls.
// Derives each class's current TER from the already-ingested `fund_fees` rows.
//
// Run after `refreshFundCatalog` (it FK-references `fund_catalog`); classes whose
// parent isn't in the catalog yet are skipped.

import { and, eq, isNull } from "drizzle-orm";
import { getMarketDb } from "../db/context";
import { type ShareClassInsert, upsertShareClasses } from "../db/queries/share-classes";
import { fundCatalog, fundDividendPolicy, fundFees } from "../db/schema";
import {
  classifyDistribution,
  classifyInvestorType,
  classifyTaxIncentive,
  distributionFromDividendPolicy,
} from "../market/fund-classify";
import { TER_FEE_TYPE } from "../market/fund-fees";
import { enumerateShareClasses } from "../market/providers/sec-thailand";

export interface RefreshShareClassesResult {
  classesSeen: number;
  classesUpserted: number;
  skippedNoParent: number;
  skippedNoTicker: number;
}

/**
 * The priceable ticker for a class: the parent abbr when SEC reports the class
 * as "main" (single-class funds), else the share-class code itself.
 */
export function deriveTicker(
  abbr: string | null | undefined,
  className: string | null | undefined,
): string | null {
  const cls = (className ?? "").trim();
  const isMain = cls === "" || cls === "-" || cls.toLowerCase() === "main";
  const ticker = (isMain ? (abbr ?? "").trim() : cls).trim();
  return ticker || null;
}

export async function refreshShareClasses(
  opts: { limit?: number } = {},
): Promise<RefreshShareClassesResult> {
  const profiles = await enumerateShareClasses(opts.limit ?? 0);
  const db = getMarketDb();

  // Per-class current TER from the active total_expense fee row. One scan,
  // keyed `${projId}:${className}`.
  const feeRows = db
    .select({
      projId: fundFees.projId,
      className: fundFees.fundClassName,
      rate: fundFees.actualRatePct,
      ceiling: fundFees.rateCeilingPct,
    })
    .from(fundFees)
    .where(and(eq(fundFees.feeType, TER_FEE_TYPE), isNull(fundFees.periodEnd)))
    .all();
  const terByClass = new Map<string, number>();
  for (const f of feeRows) {
    const ter = f.rate ?? f.ceiling;
    if (ter != null) terByClass.set(`${f.projId}:${f.className}`, ter);
  }

  const knownParents = new Set(
    db
      .select({ id: fundCatalog.projId })
      .from(fundCatalog)
      .all()
      .map((r) => r.id),
  );

  // Formal factsheet dividend-policy codes per (projId, className) — landed by
  // the catalog transform (which runs before this job on the nightly schedule).
  // Authoritative where present; the Thai-text parse below stays the fallback.
  const divPolicyByKey = new Map(
    getMarketDb()
      .select({
        projId: fundDividendPolicy.projId,
        className: fundDividendPolicy.fundClassName,
        code: fundDividendPolicy.dividendPolicy,
      })
      .from(fundDividendPolicy)
      .all()
      .filter((r) => r.code)
      .map((r) => [`${r.projId}:${r.className}`, r.code as string]),
  );

  const rows: ShareClassInsert[] = [];
  const seenTickers = new Set<string>();
  let skippedNoParent = 0;
  let skippedNoTicker = 0;

  for (const p of profiles) {
    const ticker = deriveTicker(p.proj_abbr_name, p.fund_class_name);
    if (!ticker) {
      skippedNoTicker++;
      continue;
    }
    if (!knownParents.has(p.proj_id)) {
      skippedNoParent++;
      continue;
    }
    // `ticker` carries a UNIQUE index; drop a rare cross-fund collision rather
    // than abort the whole upsert transaction.
    if (seenTickers.has(ticker)) continue;
    seenTickers.add(ticker);

    const className = (p.fund_class_name ?? "main").trim() || "main";
    rows.push({
      projId: p.proj_id,
      className,
      ticker,
      classDetailTh: p.fund_class_detail ?? null,
      distributionPolicy:
        distributionFromDividendPolicy(divPolicyByKey.get(`${p.proj_id}:${className}`)) ??
        classifyDistribution(p.fund_class_detail),
      investorType: classifyInvestorType(p.fund_class_detail),
      taxIncentiveType: classifyTaxIncentive(p.fund_class_tax_incentive_type),
      isinCode: p.fund_class_isin_code ?? null,
      currentTer: terByClass.get(`${p.proj_id}:${className}`) ?? null,
    });
  }

  upsertShareClasses(rows);
  return {
    classesSeen: profiles.length,
    classesUpserted: rows.length,
    skippedNoParent,
    skippedNoTicker,
  };
}
