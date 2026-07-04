// Dev-only: seed ONE fund's enrichment into the local DB so you can eyeball the
// FundDetailSheet (portfolio collapse, latest-period filter, feeder look-through)
// without running the full ~8800-fund crawl.
//
// Usage:
//   npx tsx --tsconfig tsconfig.scripts.json --env-file=.env.local \
//     scripts/seed-local-fund.ts [proj_id]
//
// Defaults to K-US500X (M0257_2564) — an S&P 500 feeder whose portfolio has the
// 60-FX-forward + NAV-total shape this UI work addresses. Needs SEC_API_KEY in
// .env.local. Then: AUTH_DISABLED=1 npm run dev → open the fund.

import { fileURLToPath } from "node:url";
import {
  upsertFeederLookThroughHoldings,
  upsertFeederMasterMap,
} from "../lib/db/queries/feeder-enrichment";
import {
  upsertFundPortfolio,
  upsertFundPortfolioAssetType,
} from "../lib/db/queries/fund-enrichment";
import { upsertFund } from "../lib/db/queries/funds";
import {
  EDGAR_FUNDS,
  fetchNportHoldings,
  matchEdgarFund,
} from "../lib/market/providers/edgar-nport";
import {
  fetchFundPortfolio,
  fetchFundPortfolioAssetType,
} from "../lib/market/providers/sec-thailand";

// Known display fields for the default fund (no single-profile SEC endpoint).
const DEFAULTS: Record<string, { abbr: string; nameEn: string; master: string }> = {
  M0257_2564: {
    abbr: "K-US500X",
    nameEn: "K US500 Index Fund",
    master: "iShares Core S&P 500 ETF",
  },
};

async function main() {
  const projId = process.argv[2] ?? "M0257_2564";
  const meta = DEFAULTS[projId] ?? { abbr: projId, nameEn: projId, master: "" };
  console.log(`Seeding ${projId} (${meta.abbr}) into local DB…`);

  upsertFund({
    projId,
    abbrName: meta.abbr,
    englishName: meta.nameEn,
    isFeederFund: true,
    feederMasterFund: meta.master,
    assetClass: "Foreign equity",
    status: "active",
  });

  const [port, portType] = await Promise.all([
    fetchFundPortfolio(projId),
    fetchFundPortfolioAssetType(projId),
  ]);

  upsertFundPortfolio(
    projId,
    port.map((it) => ({
      projId,
      period: it.period,
      asOfDate: it.as_of_date ?? null,
      assetliabId: it.assetliab_id ?? null,
      assetliabDesc: it.assetliab_desc ?? null,
      issueCode: it.issue_code ?? null,
      isinCode: it.isin_code ?? null,
      issuer: it.issuer ?? null,
      assetliabValue: it.assetliab_value ?? null,
      percentNav: it.percent_nav ?? null,
      lastUpdDate: it.last_upd_date ?? null,
    })),
  );

  upsertFundPortfolioAssetType(
    projId,
    portType.map((it) => ({
      projId,
      period: it.period,
      assetliabCode: it.assetliab_code,
      assetliabDesc: it.assetliab_desc ?? null,
      marketValue: it.market_value ?? null,
      percentNav: it.percent_nav ?? null,
    })),
  );

  // Feeder look-through via SEC EDGAR N-PORT (same path as the crawl).
  const masterIsin = meta.master ? matchEdgarFund(meta.master) : null;
  const ref = masterIsin ? EDGAR_FUNDS[masterIsin] : undefined;
  let lookThrough = 0;
  if (ref) {
    const { asOfDate, holdings } = await fetchNportHoldings(ref);
    if (holdings.length > 0) {
      upsertFeederMasterMap({
        projId,
        masterIsin: ref.isin,
        masterName: meta.master,
        provider: "sec-nport",
      });
      upsertFeederLookThroughHoldings(
        projId,
        holdings.map((h, i) => ({
          projId,
          rank: i + 1,
          name: h.name,
          ticker: h.ticker,
          assetClass: h.assetClass,
          isin: h.isin,
          weightPct: h.weightPct,
          asOfDate,
        })),
      );
      lookThrough = holdings.length;
    }
  }

  console.log(
    `Done: portfolio=${port.length} assetType=${portType.length} lookThrough=${lookThrough}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
