// Investor-eligibility tier derived from the SEC `proj_retail_type` code.
//
// The SEC marks each fund with who it may be offered to (spec field
// `proj_retail_type`). That single code spans three very different audiences,
// which the screener must treat differently:
//   • individuals can subscribe directly (retail), or if they qualify
//     (accredited / ultra-high-net-worth) — these belong in the buy list;
//   • provident funds are employer-sponsored — an individual can hold one but
//     not subscribe directly;
//   • institutional-only funds an individual cannot buy at all.
//
// `retailTier` collapses the raw code into those buckets so the list/search
// split (lib/db/queries/funds.ts) and the row badges (FundSelect) can reason
// about eligibility instead of memorizing SEC letters.
//
// Raw codes (SEC Open Data API spec, categories/fund.json → proj_retail_type):
//   A = non-retail investors            H = non-retail + high-net-worth
//   B = high-net-worth investors        N = institutional investors
//   F = corporate-bond liquidity (BSF)  R = general investors (retail)
//   G = special government-policy fund   V = provident funds
//   X = institutional + ultra-HNW (UI)

export type RetailTier = "retail" | "accredited" | "ultra" | "provident" | "institutional";

/**
 * Map a raw SEC `proj_retail_type` to an investor-eligibility tier.
 * NULL/unknown (pre-crawl) and `G` (special funds, e.g. the exchange-listed
 * VAYU1) fall back to `retail` — a safe no-op that never hides a fund we can't
 * positively classify as restricted.
 */
export function retailTier(projRetailType: string | null | undefined): RetailTier {
  switch (projRetailType) {
    case "A": // non-retail (AI-suffixed accredited funds)
    case "B": // high-net-worth
    case "H": // non-retail + high-net-worth
      return "accredited";
    case "X": // institutional + ultra-HNW (UI funds)
      return "ultra";
    case "V": // provident funds
      return "provident";
    case "N": // institutional
    case "F": // corporate-bond liquidity support (institutional)
      return "institutional";
    default: // R, G, null/unknown
      return "retail";
  }
}

/** Short row-badge label per tier; `retail` shows none. */
export const RETAIL_TIER_BADGE: Record<RetailTier, string | null> = {
  retail: null,
  accredited: "Accredited",
  ultra: "Ultra",
  provident: "Provident",
  institutional: "Inst.",
};

/**
 * The "Access" facet value — which restricted audience the browse list filters
 * to. `undefined` = the retail buy list (default). Provident/institutional funds
 * aren't individually buyable, so they aren't a browse choice — search still
 * finds them on an exact match.
 */
export type AccessTier = "accredited" | "ultra" | "both";

/**
 * Which tiers the browse list shows at the chosen access level — an EXCLUSIVE
 * filter, like every other facet (picking "Ultra" shows ultra funds, not retail
 * + ultra). The default (`undefined`) is the retail buy list. Provident and
 * institutional are never a browse choice (no individual can subscribe to them);
 * search surfaces them on an exact match.
 */
export function browseTiers(access?: AccessTier): Set<RetailTier> {
  switch (access) {
    case "accredited":
      return new Set(["accredited"]);
    case "ultra":
      return new Set(["ultra"]);
    case "both":
      return new Set(["accredited", "ultra"]);
    default:
      return new Set(["retail"]);
  }
}

/**
 * Whether a tier counts as "buyable" for SEARCH ranking (not demoted): retail
 * always, plus whatever the access facet opted into. Unlike browse, retail is
 * never demoted even when a restricted audience is selected — a search must
 * still surface the retail fund you typed.
 */
export function isTierBuyable(tier: RetailTier, access?: AccessTier): boolean {
  if (tier === "retail") return true;
  return browseTiers(access).has(tier);
}
