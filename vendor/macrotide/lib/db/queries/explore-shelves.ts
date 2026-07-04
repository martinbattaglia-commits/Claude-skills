// Explore "All" idle browse — curated shelves instead of one blended popularity
// list. Each shelf ranks by its OWN honest signal (index ETFs are curated, Thai
// funds are cheapest-TER-first, US stocks are most-traded), so nothing forces a
// fund's AUM and a stock's dollar-volume onto one incomparable scale. Searching
// bypasses this entirely and goes flat-relevance through searchAssets.

import "server-only";
import { type AssetSearchItem, thaiToItem, usToItem } from "./asset-search";
import { findShareClasses } from "./funds";
import { getStarterIndexEtfs } from "./us-related";
import { findUsSecurities } from "./us-securities";

/** Which asset-type tab a shelf's "See all" link opens. */
export type ShelfTab = "thai" | "us_etf" | "us_stock";

export interface ExploreShelf {
  key: string;
  title: string;
  seeAll: ShelfTab;
  items: AssetSearchItem[];
}

const SHELF_SIZE = 8;

export interface ShelfDeps {
  findThai: typeof findShareClasses;
  findUs: typeof findUsSecurities;
}

export function getExploreShelves(deps: Partial<ShelfDeps> = {}): ExploreShelf[] {
  const findThai = deps.findThai ?? findShareClasses;
  const findUs = deps.findUs ?? findUsSecurities;

  // Index ETFs — the curated starter set (lib/db/queries/us-related.ts, shared
  // with the cross-link feature), cheapest live-TER first.
  const indexEtfs = getStarterIndexEtfs(SHELF_SIZE).map(usToItem);

  // Low-cost Thai INDEX funds — cheapest-TER-first, but index-style only
  // (managementStyle PN/PM). Without the index filter, "cheapest" surfaces
  // money-market and short-term bond funds (cheap because low-risk), not the
  // diversified index trackers an index-investing on-ramp should lead with.
  const thaiFunds = findThai({ indexType: "index", limit: SHELF_SIZE }).items.map(thaiToItem);

  // Popular US stocks — most-traded (popularity), stocks only.
  const usStocks = findUs({
    securityType: "stock",
    sort: "popularity",
    limit: SHELF_SIZE,
  }).items.map(usToItem);

  // Order = home market → global → advanced. Thai index funds lead: in a
  // THB-based, Thai-investor-first app they're the most actionable start (locally
  // registered, no foreign brokerage/FX/US-estate-tax friction). US index ETFs
  // follow as the cheaper global benchmark; individual US stocks last.
  const shelves: ExploreShelf[] = [];
  if (thaiFunds.length > 0) {
    shelves.push({
      key: "thai",
      title: "Low-cost Thai index funds",
      seeAll: "thai",
      items: thaiFunds,
    });
  }
  if (indexEtfs.length > 0) {
    shelves.push({
      key: "index-etfs",
      title: "Low-cost index ETFs",
      seeAll: "us_etf",
      items: indexEtfs,
    });
  }
  if (usStocks.length > 0) {
    shelves.push({
      key: "us-stocks",
      title: "Popular US stocks",
      seeAll: "us_stock",
      items: usStocks,
    });
  }
  return shelves;
}
