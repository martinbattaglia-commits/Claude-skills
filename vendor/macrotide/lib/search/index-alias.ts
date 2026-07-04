// Index-family aliases for the Explore screener — CLIENT-SAFE (no DB imports).
//
// Maps what a user types ("sp500", "S&P 500", "qqq") to the canonical
// fund_catalog.index_family value ("S&P 500", "NASDAQ-100") so the UI can
// offer the precise "Tracks: <index>" facet instead of a fuzzy text search.
// Sibling of the term-expansion ALIASES in fund-index.ts (server-side), which
// broadens free-text recall; this one resolves a whole query to ONE family.
// Keep both curated and small. (The Tracks menu itself is NOT curated here —
// it's served live by /api/funds/index-families from the catalog.)

// Normalized whole-query → canonical index family. Keys are the query after
// lowercasing and stripping every non-alphanumeric character, so "S&P 500",
// "s&p500", "S and P 500" and "sp500" all collide on "sp500" / "sandp500".
const QUERY_TO_FAMILY: Readonly<Record<string, string>> = {
  // S&P 500
  sp500: "S&P 500",
  sandp500: "S&P 500",
  spx: "S&P 500",
  us500: "S&P 500",
  sp500index: "S&P 500",
  // NASDAQ-100
  nasdaq: "NASDAQ-100",
  nasdaq100: "NASDAQ-100",
  ndx: "NASDAQ-100",
  ndx100: "NASDAQ-100",
  qqq: "NASDAQ-100",
  // Thai families
  set50: "SET50",
  set100: "SET100",
  sethd: "SETHD",
  // Global / EM
  msciworld: "MSCI World",
  world: "MSCI World",
  acwi: "MSCI ACWI",
  msciacwi: "MSCI ACWI",
  allcountryworld: "MSCI ACWI",
  msciem: "MSCI EM",
  emerging: "MSCI EM",
  emergingmarkets: "MSCI EM",
  // Europe
  stoxx600: "STOXX Europe 600",
  stoxxeurope600: "STOXX Europe 600",
  eurostoxx: "EURO STOXX",
  // Country indices
  mscichina: "MSCI China",
  setesg: "SET ESG",
  nikkei: "Nikkei 225",
  nikkei225: "Nikkei 225",
  topix: "TOPIX",
  csi300: "CSI 300",
  hangseng: "Hang Seng",
  hsi: "Hang Seng",
  nifty: "Nifty 50",
  nifty50: "Nifty 50",
  vn30: "VN30",
  dax: "DAX",
  ftse100: "FTSE 100",
  russell2000: "Russell 2000",
  dowjones: "Dow Jones",
  djia: "Dow Jones",
};

/**
 * Resolve a free-text search to the canonical index family it names, or null
 * when the query isn't (just) an index name. Whole-query match by design: a
 * longer query ("S&P 500 RMF") expresses more than the family, so the text
 * path should keep handling it.
 */
export function matchIndexFamily(query: string): string | null {
  const norm = query.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!norm) return null;
  return QUERY_TO_FAMILY[norm] ?? null;
}
