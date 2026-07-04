// Assemble the full US detail payload from the catalog + holdings + dividends +
// price caches. Cache-first: returns whatever is stored NOW (the detail open also
// triggers a JIT warm via the view endpoint, and the client revalidates to pick up
// filled sections). The whole rich page in one read.

import "server-only";
import { trailingYield } from "../../market/corporate-actions";
import { quoteCacheKey } from "../../market/sources";
import { navOnDate } from "./quotes";
import { getDividends, type UsDividendRow } from "./us-dividends";
import {
  deriveExposure,
  type EtfExposure,
  type EtfHoldingRow,
  getEtfHoldings,
  getEtfsHoldingSymbol,
  type HeldViaEtf,
} from "./us-etf-holdings";
import { getRelatedByIndex, type RelatedByIndex, type RelatedEtf } from "./us-related";
import { getUsSecurity, type UsSecurity } from "./us-securities";

export interface UsSecurityDetail {
  /** Catalog row: profile, sector, ratios, TER, index membership, freshness. */
  security: UsSecurity;
  /** Latest cached USD close (drives market cap + dividend yield); null if cold. */
  price: number | null;
  dividends: {
    items: UsDividendRow[];
    asOf: string | null;
    /** Trailing-12-month yield (fraction) vs the latest price. */
    trailingYield: number | null;
  };
  /** Present only for ETFs (null for stocks). */
  holdings: {
    items: EtfHoldingRow[];
    asOf: string | null;
    exposure: EtfExposure;
  } | null;
  /** Index-investing cross-links (index labels + Thai funds). */
  related: RelatedByIndex;
  /**
   * The index ETFs to reach this security through — a single merged list of the
   * ETFs that TRACK an index it belongs to and the ETFs that HOLD it (deduped, so
   * an ETF that does both appears once with both its fee and its weight). Cheapest
   * fee first. `weightPct` is this security's weight in the ETF (null when the ETF
   * tracks a matching index but we don't have its holdings, or the subject is an ETF).
   */
  relatedEtfs: RelatedEtfRow[];
}

export interface RelatedEtfRow {
  symbol: string;
  name: string;
  ter: number | null;
  weightPct: number | null;
  securityType: "stock" | "etf";
  /** True when this ETF is a confirmed index tracker (it tracks an index the
   *  security belongs to); false when it merely holds the security (held-via),
   *  where we can't confirm it's an index fund. Drives the "Index" badge. */
  isIndex: boolean;
  /** Row group for the display: "broad" = tracks a broad index the security is in,
   *  "sector" = tracks the security's GICS sector, "holder" = holds it but we can't
   *  confirm it's an index fund. Keeps sector ETFs in their own group. */
  group: "broad" | "sector" | "holder";
  /** Popularity score (0–1) — tiebreak among equal-fee, equal-weight ETFs so the
   *  bigger/more-traded one leads (matches the Explore starter-shelf ordering). */
  popularityScore: number;
}

/** Cheapest effective TER first (null/≤0 last), then heavier weight, then the
 *  more-popular ETF, then ticker — matching the Explore starter-shelf tiebreak
 *  (popularity is populated for the big trackers; market_cap often isn't). */
function compareRelatedEtf(a: RelatedEtfRow, b: RelatedEtfRow): number {
  const ea = a.ter != null && a.ter > 0 ? a.ter : Number.POSITIVE_INFINITY;
  const eb = b.ter != null && b.ter > 0 ? b.ter : Number.POSITIVE_INFINITY;
  if (ea !== eb) return ea - eb;
  const wa = a.weightPct ?? -1;
  const wb = b.weightPct ?? -1;
  if (wa !== wb) return wb - wa;
  if (a.popularityScore !== b.popularityScore) return b.popularityScore - a.popularityScore;
  return a.symbol.localeCompare(b.symbol);
}

// Per-group caps for the merged list. Broad leads (the cheap default route);
// sector and holder are smaller supporting groups. Each is cheapest-first, and the
// UI shows the first few with a "show more" for the rest — so nothing is silently
// dropped and a higher-fee sector ETF is never crowded out by cheap broad ones.
const GROUP_LIMIT: Record<RelatedEtfRow["group"], number> = {
  broad: 8,
  sector: 6,
  holder: 6,
};

/**
 * Merge the "tracks an index this security is in" ETFs with the "holds this
 * security" ETFs into one deduped, grouped list, so an ETF that does both (QQQ
 * tracks the Nasdaq-100 AND holds AAPL) shows once with its fee and AAPL's weight,
 * not twice with two confusingly different percentages. Grouped broad → sector →
 * holder, each cheapest-first and capped, so sector ETFs keep their own group.
 */
export function mergeRelatedEtfs(usEtfs: RelatedEtf[], heldVia: HeldViaEtf[]): RelatedEtfRow[] {
  const bySymbol = new Map<string, RelatedEtfRow>();
  // Tracking-set ETFs first — confirmed index trackers, grouped broad vs sector.
  for (const e of usEtfs) {
    bySymbol.set(e.symbol.toUpperCase(), {
      symbol: e.symbol,
      name: e.name,
      ter: e.ter,
      weightPct: null,
      securityType: e.securityType,
      isIndex: true,
      group: e.group,
      popularityScore: e.popularityScore,
    });
  }
  // Held-via ETFs: attach the weight to a tracker already listed (keeping its
  // group), else add it as a holder we can't confirm is an index fund.
  for (const h of heldVia) {
    const key = h.symbol.toUpperCase();
    const existing = bySymbol.get(key);
    if (existing) existing.weightPct = h.weightPct;
    else
      bySymbol.set(key, {
        symbol: h.symbol,
        name: h.name,
        ter: h.ter,
        weightPct: h.weightPct,
        securityType: "etf",
        isIndex: false,
        group: "holder",
        popularityScore: h.popularityScore,
      });
  }
  // Cap each group independently, then emit broad → sector → holder.
  const order: RelatedEtfRow["group"][] = ["broad", "sector", "holder"];
  const all = [...bySymbol.values()].sort(compareRelatedEtf);
  return order.flatMap((g) => all.filter((r) => r.group === g).slice(0, GROUP_LIMIT[g]));
}

export function getUsSecurityDetail(
  symbol: string,
  opts: { today?: string } = {},
): UsSecurityDetail | null {
  const security = getUsSecurity(symbol);
  if (!security) return null;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);

  const key = quoteCacheKey("market", security.symbol);
  const price = navOnDate([key], today).get(key) ?? null;

  const div = getDividends(security.symbol);
  const dividends = {
    items: div.dividends,
    asOf: div.fetchedAt,
    trailingYield: trailingYield(div.dividends, price, today),
  };

  let holdings: UsSecurityDetail["holdings"] = null;
  if (security.securityType === "etf") {
    const h = getEtfHoldings(security.symbol);
    holdings = { items: h.holdings, asOf: h.asOf, exposure: deriveExposure(h.holdings) };
  }

  const related = getRelatedByIndex(security);
  return {
    security,
    price,
    dividends,
    holdings,
    related,
    relatedEtfs: mergeRelatedEtfs(related.usEtfs, getEtfsHoldingSymbol(security.symbol)),
  };
}
