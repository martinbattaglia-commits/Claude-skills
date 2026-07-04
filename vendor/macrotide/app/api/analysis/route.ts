// GET /api/analysis
//
// Returns the composite portfolio-health score + component breakdown + the
// health signals used to produce it. Scope is the aggregate of ALL the
// current user's holdings, with the plan's `selectedModelId` as the target.
//
// The score is purely deterministic — see lib/portfolio/score.ts for rules.

import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { listBuckets } from "@/lib/db/queries/buckets";
import { listEarmarks } from "@/lib/db/queries/earmarks";
import { listHeldQuoteKeys, listHoldings } from "@/lib/db/queries/holdings";
import { listModelPortfolios } from "@/lib/db/queries/models";
import { getPlan } from "@/lib/db/queries/plan";
import { listFundQuotes } from "@/lib/db/queries/quotes";
import { adaptAggregate, adaptModelPortfolios, adaptPortfolios } from "@/lib/portfolio/adapter";
import { computeHealth } from "@/lib/portfolio/health";
import { computeLookThrough } from "@/lib/portfolio/look-through";
import { scorePortfolio } from "@/lib/portfolio/score";

export async function GET() {
  return withDb(() => {
    // ── 1. Resolve all user data from the DB ─────────────────────────────
    const buckets = listBuckets();
    const dbHoldings = listHoldings();
    const quotes = listFundQuotes(listHeldQuoteKeys());
    const dbModels = listModelPortfolios();
    const plan = getPlan();

    // ── 2. Build adapted view (holdings with live NAV values) ────────────
    const portfolios = adaptPortfolios(buckets, dbHoldings, quotes);
    const aggregate = adaptAggregate(portfolios);

    // ── 3. Resolve target model (plan.selectedModelId, if any) ───────────
    const models = adaptModelPortfolios(dbModels);
    const targetModelId = plan?.selectedModelId ?? null;
    const targetModel = targetModelId ? (models.find((m) => m.id === targetModelId) ?? null) : null;

    // ── 4. Compute health signals (with underlying-exposure look-through) ──
    const lookThrough = computeLookThrough(aggregate.holdings);
    // Reserved cash (#149) → its own allocation slice, not the investable Cash sleeve.
    const reservedTickers = new Set(
      listEarmarks()
        .filter((e) => e.role === "reserved" && e.ticker)
        .map((e) => (e.ticker as string).toUpperCase()),
    );
    const health = computeHealth(
      aggregate.holdings,
      aggregate.totalValue,
      targetModel?.mix ?? null,
      targetModel?.ter ?? null,
      lookThrough,
      reservedTickers,
    );

    // ── 5. Derive composite score ─────────────────────────────────────────
    const hasTarget = targetModel !== null;
    const score = scorePortfolio(health, hasTarget);

    return NextResponse.json({
      score,
      health,
      targetName: targetModel?.name ?? null,
      totalValue: aggregate.totalValue,
      holdingCount: aggregate.holdings.length,
    });
  });
}
