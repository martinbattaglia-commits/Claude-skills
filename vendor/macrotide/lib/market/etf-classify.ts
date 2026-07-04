// Derive an ETF's normalized asset class + exposure geography from its SEC
// N-PORT holdings (asset-category + country mix). Pure — no DB, no network — so
// the nightly holdings refresh classifies from the rows it just stored and tests
// need no fixtures.
//
// N-PORT carries no fund-level rollup, so both attributes are inferred from the
// per-constituent weights: the dominant asset-category family names the class,
// the dominant country region names the exposure. A holding whose category or
// country we don't map contributes to no bucket, so a fund we can't stand behind
// (too little classified weight) returns null rather than a guess.

export type EtfAssetClass = "equity" | "bond" | "alternative" | "cash";
export type EtfRegion = "US" | "Intl" | "EM" | "Global";

export interface EtfHoldingInput {
  /** Human asset-category label as stored (edgar-nport's ASSET_CAT_LABELS). */
  assetCat: string | null;
  /** ISO-2 country of the investment (N-PORT invCountry). */
  country: string | null;
  /** Percent of NAV (8.04 = 8.04%). */
  weightPct: number | null;
}

// N-PORT asset-category label → normalized class. Keyed by the human labels
// edgar-nport writes (ASSET_CAT_LABELS); an unmapped label (e.g. a forward/FX
// derivative, or a raw code fallback) contributes to no class. Debt-like
// derivatives (rate/credit) and structured/loan paper roll up to bond; repos and
// short-term investments are cash; commodities and real estate are alternative.
const ASSET_CAT_CLASS: Record<string, EtfAssetClass> = {
  "Equity (common)": "equity",
  "Equity (preferred)": "equity",
  "Equity derivative": "equity",
  Debt: "bond",
  "Asset-backed": "bond",
  "Mortgage-backed": "bond",
  "Structured note": "bond",
  Loan: "bond",
  "Rate derivative": "bond",
  "Credit derivative": "bond",
  "Repurchase agreement": "cash",
  "Short-term investment": "cash",
  Commodity: "alternative",
  "Commodity derivative": "alternative",
  "Real estate": "alternative",
};

// Region gazetteer by ISO-2 country. US is its own bucket; the MSCI developed
// markets (ex-US) are "Intl", the MSCI emerging markets are "EM". A country in
// neither set (or missing) contributes to no region. Exposure is EXPOSURE, so a
// US-listed ETF holding Japanese equities counts toward Intl, not US.
//
// Hong Kong (HK) is deliberately in NEITHER set: it is a developed venue that
// predominantly hosts Chinese (EM) issuers, so counting it as developed wrongly
// dilutes emerging-market funds (which hold their China exposure via HK-listed
// shares). Leaving it uncounted lets a fund's unambiguous holdings decide the
// region rather than mislabel it — an EM fund reads EM, a rare HK-only fund abstains.
const DEVELOPED_EX_US = new Set([
  "CA",
  "GB",
  "FR",
  "DE",
  "IT",
  "ES",
  "NL",
  "BE",
  "AT",
  "FI",
  "IE",
  "PT",
  "DK",
  "NO",
  "SE",
  "CH",
  "IL",
  "JP",
  "SG",
  "AU",
  "NZ",
  "LU",
]);
const EMERGING = new Set([
  "CN",
  "TW",
  "KR",
  "IN",
  "BR",
  "ZA",
  "MX",
  "SA",
  "ID",
  "TH",
  "MY",
  "PH",
  "TR",
  "PL",
  "GR",
  "HU",
  "CZ",
  "QA",
  "AE",
  "KW",
  "CL",
  "CO",
  "PE",
  "EG",
]);

// A class needs a clear majority of classified weight to be named — else the
// fund is genuinely blended and we leave it unclassified rather than mislabel.
const CLASS_DOMINANCE = 0.6;
// A single region this dominant names the exposure; otherwise the fund is spread
// across regions and reads as "Global".
const REGION_DOMINANCE = 0.7;

function countryRegion(country: string | null): "US" | "Intl" | "EM" | null {
  if (!country) return null;
  const c = country.trim().toUpperCase();
  if (c === "US") return "US";
  if (DEVELOPED_EX_US.has(c)) return "Intl";
  if (EMERGING.has(c)) return "EM";
  return null;
}

/** Sum positive weights into the buckets a mapper assigns; unmapped rows ignored. */
function bucketWeights<K extends string>(
  holdings: EtfHoldingInput[],
  keyOf: (h: EtfHoldingInput) => K | null,
): { totals: Map<K, number>; classified: number } {
  const totals = new Map<K, number>();
  let classified = 0;
  for (const h of holdings) {
    const w = h.weightPct ?? 0;
    if (w <= 0) continue;
    const k = keyOf(h);
    if (!k) continue;
    totals.set(k, (totals.get(k) ?? 0) + w);
    classified += w;
  }
  return { totals, classified };
}

/**
 * Dominant asset class from the holdings' category mix, or null when too little
 * weight is classifiable or no class reaches {@link CLASS_DOMINANCE}.
 */
export function classifyEtfAssetClass(holdings: EtfHoldingInput[]): EtfAssetClass | null {
  const { totals, classified } = bucketWeights(holdings, (h) =>
    h.assetCat ? (ASSET_CAT_CLASS[h.assetCat] ?? null) : null,
  );
  if (classified <= 0) return null;
  let best: EtfAssetClass | null = null;
  let bestW = 0;
  for (const [cls, w] of totals) {
    if (w > bestW) {
      best = cls;
      bestW = w;
    }
  }
  return best && bestW / classified >= CLASS_DOMINANCE ? best : null;
}

/**
 * Exposure region from the holdings' country mix: the dominant region when one
 * clears {@link REGION_DOMINANCE}, else "Global" for a spread-across-regions
 * fund. Null when too little country weight is classifiable.
 */
export function classifyEtfRegion(holdings: EtfHoldingInput[]): EtfRegion | null {
  const { totals, classified } = bucketWeights(holdings, (h) => countryRegion(h.country));
  if (classified <= 0) return null;
  for (const [region, w] of totals) {
    if (w / classified >= REGION_DOMINANCE) return region;
  }
  return "Global";
}

/** Both derived attributes in one pass. Either side is null when undecidable. */
export function classifyEtf(holdings: EtfHoldingInput[]): {
  assetClass: EtfAssetClass | null;
  exposureRegion: EtfRegion | null;
} {
  return {
    assetClass: classifyEtfAssetClass(holdings),
    exposureRegion: classifyEtfRegion(holdings),
  };
}
