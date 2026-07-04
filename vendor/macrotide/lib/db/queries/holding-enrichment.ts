import "server-only";
import { eq, inArray, sql } from "drizzle-orm";
import { cleanUsSecurityName } from "../../market/us-security-name";
import { translateThaiPolicy } from "../../portfolio/holding-taxonomy";
import { getMarketDb } from "../context";
import { fundCatalog, fundShareClasses } from "../schema";
import { resolveCatalogSymbol } from "./funds";
import type { Holding } from "./holdings";
import { resolveUsHolding } from "./us-securities";

export interface CatalogHoldingMetadata {
  thaiName: string | null;
  englishName: string | null;
  category: string | null;
  assetClass: string | null;
  region: string | null;
  ter: number | null;
  /** SEC risk-spectrum code (RS1…RS8, RS81) — drives the holding swatch color. */
  riskSpectrum: string | null;
}

const CATALOG_FIELDS = [
  "thaiName",
  "englishName",
  "category",
  "assetClass",
  "region",
  "ter",
  "riskSpectrum",
] as const;
export type CatalogOwnedField = (typeof CATALOG_FIELDS)[number];

export function stripCatalogOwnedFields<T extends Partial<Record<CatalogOwnedField, unknown>>>(
  patch: T,
): Omit<T, CatalogOwnedField> {
  const out = { ...patch };
  for (const key of CATALOG_FIELDS) delete out[key];
  return out;
}

function displayRegion(region: string | null): string | null {
  switch (region) {
    case "domestic":
      return "Thailand";
    case "foreign":
      return "Foreign";
    case "mixed":
      return "Mixed";
    default:
      return region;
  }
}

export function catalogMetadataForHoldings(tickers: string[]): Map<string, CatalogHoldingMetadata> {
  const cleaned = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
  const out = new Map<string, CatalogHoldingMetadata>();
  if (cleaned.length === 0) return out;

  const db = getMarketDb();
  for (const r of db
    .select({
      ticker: fundShareClasses.ticker,
      thaiName: fundCatalog.thaiName,
      englishName: fundCatalog.englishName,
      fundType: fundCatalog.fundType,
      policyDesc: fundCatalog.policyDesc,
      policyDescTh: fundCatalog.policyDescTh,
      assetClass: fundCatalog.assetClass,
      investRegion: fundCatalog.investRegion,
      riskSpectrum: fundCatalog.riskSpectrum,
      shareTer: fundShareClasses.currentTer,
      fundTer: fundCatalog.currentTer,
    })
    .from(fundShareClasses)
    .innerJoin(fundCatalog, eq(fundShareClasses.projId, fundCatalog.projId))
    .where(inArray(sql`upper(${fundShareClasses.ticker})`, cleaned))
    .all()) {
    out.set(r.ticker.toUpperCase(), {
      thaiName: r.thaiName,
      englishName: r.englishName,
      category: r.policyDescTh ?? r.policyDesc ?? r.fundType,
      assetClass: r.assetClass,
      region: displayRegion(r.investRegion),
      ter: r.shareTer ?? r.fundTer,
      riskSpectrum: r.riskSpectrum,
    });
  }

  for (const r of db
    .select({
      ticker: fundCatalog.abbrName,
      thaiName: fundCatalog.thaiName,
      englishName: fundCatalog.englishName,
      fundType: fundCatalog.fundType,
      policyDesc: fundCatalog.policyDesc,
      policyDescTh: fundCatalog.policyDescTh,
      assetClass: fundCatalog.assetClass,
      investRegion: fundCatalog.investRegion,
      riskSpectrum: fundCatalog.riskSpectrum,
      ter: fundCatalog.currentTer,
    })
    .from(fundCatalog)
    .where(inArray(sql`upper(${fundCatalog.abbrName})`, cleaned))
    .all()) {
    const ticker = r.ticker?.toUpperCase();
    if (!ticker || out.has(ticker)) continue;
    out.set(ticker, {
      thaiName: r.thaiName,
      englishName: r.englishName,
      category: r.policyDescTh ?? r.policyDesc ?? r.fundType,
      assetClass: r.assetClass,
      region: displayRegion(r.investRegion),
      ter: r.ter,
      riskSpectrum: r.riskSpectrum,
    });
  }

  return out;
}

export function isCatalogHolding(ticker: string): boolean {
  return catalogMetadataForHoldings([ticker]).has(ticker.trim().toUpperCase());
}

/**
 * Overlay live catalog metadata onto holdings (#235). Each holding is resolved to
 * its current share class through {@link resolveCatalogSymbol} — by the stable
 * `(projId, className)` anchor first, so a fund whose SYMBOL changed still resolves
 * (its old code has left the catalog), falling back to a ticker match. The current
 * name/metadata AND the current symbol are overlaid, so a renamed fund seamlessly
 * shows its new name and code while the ledger keeps the old code as identity.
 */
export function enrichHoldingsWithCatalog<T extends Holding>(holdings: T[]): T[] {
  // Thai holdings resolve through the SEC anchor + batched catalog metadata
  // (unchanged from #235). US (`market`) holdings resolve through their own
  // FIGI anchor against us_securities — same lifecycle, separate catalog.
  const resolved = holdings.map((h) => ({
    h,
    sym:
      h.quoteSource === "market"
        ? null
        : resolveCatalogSymbol({
            ticker: h.ticker,
            catalogProjId: h.catalogProjId,
            catalogClassName: h.catalogClassName,
            catalogIsin: h.catalogIsin,
          }),
  }));
  const metadata = catalogMetadataForHoldings(
    resolved
      .filter((r) => r.h.quoteSource !== "market")
      .map((r) => r.sym?.currentTicker ?? r.h.ticker),
  );
  return resolved.map(({ h, sym }) => {
    if (h.quoteSource === "market") {
      const us = resolveUsHolding({ ticker: h.ticker, catalogFigi: h.catalogFigi });
      if (!us) return h;
      // Catalog owns the name; keep a non-null asset class the catalog lacks, and
      // overlay the CURRENT symbol after a rename (ledger keeps the old code).
      const tickerOverlay = us.currentSymbol !== h.ticker ? { ticker: us.currentSymbol } : {};
      return {
        ...h,
        englishName: cleanUsSecurityName(us.name),
        assetClass: us.assetClass ?? h.assetClass,
        region: "United States",
        // Overlay the catalog ETF TER so blended-fee/health count US ETFs — but a
        // user-entered TER wins (broker fee on top, or a stock the user set).
        ter: h.ter ?? us.ter,
        instrumentType: us.securityType,
        exposureRegion: us.exposureRegion,
        ...tickerOverlay,
      } as T;
    }
    const lookupTicker = sym?.currentTicker ?? h.ticker;
    const meta = metadata.get(lookupTicker.trim().toUpperCase());
    if (!meta) return h;
    // Show the CURRENT symbol when the fund was renamed (stored ledger ticker is
    // the old code); a no-op when the held ticker is already current.
    const tickerOverlay =
      sym && sym.currentTicker !== h.ticker ? { ticker: sym.currentTicker } : {};
    const enriched = { ...h, ...meta, ...tickerOverlay } as T;
    // Balanced Thai funds (SEC policy ผสม) carry no catalog asset_class, so they'd
    // fall into "Unclassified". Classify them "mixed" from the translated policy so
    // they read as a real (opaque, un-decomposed) sleeve; genuinely unclassifiable
    // funds keep the empty class (#267).
    if (!enriched.assetClass && translateThaiPolicy(meta.category) === "Mixed") {
      enriched.assetClass = "mixed";
    }
    return enriched;
  });
}
