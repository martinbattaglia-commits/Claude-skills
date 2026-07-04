// Fund facet derivation — region/country focus, sector focus, and index family
// from the fund's declared benchmarks (primary) with a name/policy-text
// gazetteer fallback. Pure functions, shared by the transform and tests.
//
// Source ranking (per the #127 recon): the factsheet benchmark string is the
// authoritative classification signal — it names the index, the geography, and
// the hedging variant, and ~94% of active funds declare one. Fund names and
// policy text are the fallback for funds whose benchmark carries no geography
// (e.g. feeders benchmarked to "the master fund's performance"). We only claim
// a facet when the signal is unambiguous — conflicting matches yield null.

/** One benchmark string's classification. All fields optional — a deposit-rate
 * benchmark names no index; a gold benchmark names a sector but no region. */
export interface BenchmarkSignal {
  region?: string;
  sector?: string;
  indexFamily?: string;
}

export interface FundFacets {
  /** Geographic focus: 'thailand' | 'us' | 'japan' | 'europe' | 'china' |
   * 'india' | 'vietnam' | 'korea' | 'singapore' | 'asia' | 'asean' |
   * 'emerging' | 'global' | null (unknown / genuinely mixed). */
  regionFocus: string | null;
  /** Where regionFocus came from: 'aimc' | 'benchmark' | 'invest-flag' | 'name' | null. */
  regionFocusSource: string | null;
  /** Sector/theme focus: 'technology' | 'healthcare' | 'energy' | 'financials'
   * | 'consumer' | 'gold' | 'commodities' | 'property' | null (diversified). */
  sectorFocus: string | null;
  /** Normalized index family ("SET50", "S&P 500", "MSCI ACWI"…) when the fund
   * benchmarks a recognizable index; null otherwise. */
  indexFamily: string | null;
}

// Ordered pattern table: first match wins WITHIN a category, but every pattern
// is tested so one string can yield region + sector + family. Patterns are
// case-insensitive substring/regex matches against the verbatim benchmark
// (Thai/EN mixed). Keep specific families above generic ones (SET50 before SET).
const BENCHMARK_PATTERNS: ReadonlyArray<{
  re: RegExp;
  region?: string;
  sector?: string;
  indexFamily?: string;
}> = [
  // ── Thai equity index families ──
  { re: /SET\s?50/i, region: "thailand", indexFamily: "SET50" },
  { re: /SET\s?100/i, region: "thailand", indexFamily: "SET100" },
  { re: /SETHD|High Dividend 30/i, region: "thailand", indexFamily: "SETHD" },
  { re: /SET ESG/i, region: "thailand", indexFamily: "SET ESG" },
  { re: /sSET/, region: "thailand", indexFamily: "sSET" },
  { re: /\bMAI\b|ตลาดหลักทรัพย์เอ็มเอไอ/i, region: "thailand", indexFamily: "MAI" },
  { re: /SET TRI|ตลาดหลักทรัพย์แห่งประเทศไทย/i, region: "thailand", indexFamily: "SET" },
  // Thai sector total-return indices (SET industry groups).
  { re: /ENERG|ธุรกิจพลังงาน/i, region: "thailand", sector: "energy" },
  { re: /\bICT\b|เทคโนโลยีสารสนเทศ/i, region: "thailand", sector: "technology" },
  { re: /\bBANK\b|ธุรกิจธนาคาร/i, region: "thailand", sector: "financials" },
  { re: /\bHELTH\b|การแพทย์/i, region: "thailand", sector: "healthcare" },
  { re: /\bCOMM\b|ธุรกิจพาณิชย์/i, region: "thailand", sector: "consumer" },
  { re: /\bFOOD\b|อาหารและเครื่องดื่ม/i, region: "thailand", sector: "consumer" },
  // Thai property/REIT.
  { re: /PF\s?&\s?REIT/i, region: "thailand", sector: "property" },
  // Thai fixed income / money market: ThaiBMA families, government bonds,
  // corporate bonds, bank deposit rates, fixed-tenor (ZRR) bonds.
  { re: /ThaiBMA|สมาคมตลาดตราสารหนี้ไทย|สมาคมตราสารหนี้ไทย/i, region: "thailand" },
  { re: /พันธบัตรรัฐบาล|ตราสารหนี้ภาคเอกชน|ตราสารหนี้ภาครัฐ/, region: "thailand" },
  { re: /อัตราดอกเบี้ยเงินฝาก/, region: "thailand" },
  { re: /\(ZRR\)/, region: "thailand" },
  // ── US ──
  { re: /S\s?&\s?P\s?500/i, region: "us", indexFamily: "S&P 500" },
  { re: /NASDAQ[\s-]?100|NDX/i, region: "us", indexFamily: "NASDAQ-100" },
  { re: /Dow Jones Industrial|DJIA/i, region: "us", indexFamily: "Dow Jones" },
  { re: /Russell 2000/i, region: "us", indexFamily: "Russell 2000" },
  { re: /NYSE FANG/i, region: "us", sector: "technology", indexFamily: "NYSE FANG+" },
  { re: /US (Generic )?Government|US T-Bill|US Treasury|Short Treasury/i, region: "us" },
  { re: /MSCI USA/i, region: "us", indexFamily: "MSCI USA" },
  // ── Japan ──
  { re: /TOPIX/i, region: "japan", indexFamily: "TOPIX" },
  { re: /Nikkei\s?225|Nikkei/i, region: "japan", indexFamily: "Nikkei 225" },
  { re: /MSCI Japan/i, region: "japan", indexFamily: "MSCI Japan" },
  // ── Greater China ──
  { re: /CSI\s?300/i, region: "china", indexFamily: "CSI 300" },
  { re: /Hang Seng|HSCEI|\bHSI\b/i, region: "china", indexFamily: "Hang Seng" },
  { re: /MSCI (All )?China|Golden Dragon/i, region: "china", indexFamily: "MSCI China" },
  { re: /STAR\s?50|ChiNext/i, region: "china" },
  // ── India ──
  { re: /Nifty/i, region: "india", indexFamily: "Nifty 50" },
  { re: /MSCI (Emerging Markets )?India/i, region: "india", indexFamily: "MSCI India" },
  { re: /Sensex/i, region: "india", indexFamily: "Sensex" },
  // ── Vietnam ──
  { re: /VN\s?30|VN Index|Vietnam/i, region: "vietnam", indexFamily: "VN30" },
  // ── Korea ──
  { re: /KOSPI/i, region: "korea", indexFamily: "KOSPI" },
  // ── Europe ──
  { re: /STOXX Europe 600/i, region: "europe", indexFamily: "STOXX Europe 600" },
  { re: /Euro ?STOXX/i, region: "europe", indexFamily: "EURO STOXX" },
  { re: /MSCI Europe|MSCI EMU/i, region: "europe", indexFamily: "MSCI Europe" },
  { re: /FTSE 100/i, region: "europe", indexFamily: "FTSE 100" },
  { re: /\bDAX\b/, region: "europe", indexFamily: "DAX" },
  // ── Singapore (REITs are a popular Thai feeder target) ──
  { re: /Singapore REIT|Strait[s]? Times REIT/i, region: "singapore", sector: "property" },
  { re: /Straits Times Index/i, region: "singapore" },
  // ── Asia / ASEAN / EM ──
  { re: /Asia (ex|ex-)\s?Japan|AC Asia/i, region: "asia" },
  { re: /ASEAN/i, region: "asean" },
  { re: /MSCI Emerging|Emerging Market/i, region: "emerging", indexFamily: "MSCI EM" },
  // ── Global (developed/world) ──
  { re: /MSCI ACWI|AC World/i, region: "global", indexFamily: "MSCI ACWI" },
  { re: /MSCI World/i, region: "global", indexFamily: "MSCI World" },
  { re: /FTSE All[\s-]?World/i, region: "global", indexFamily: "FTSE All-World" },
  { re: /World Large & Mid|Developed Markets/i, region: "global" },
  { re: /Global Aggregate/i, region: "global", indexFamily: "Bloomberg Global Aggregate" },
  { re: /Global High Yield/i, region: "global" },
  // ── Commodities / gold (region intentionally left null — gold is global) ──
  { re: /LBMA Gold|Gold Price|SPDR Gold|ทองคำ/i, sector: "gold" },
  { re: /Crude Oil|WTI|Brent|น้ำมัน(?!ปาล์ม)/i, sector: "commodities" },
  { re: /Commodit/i, sector: "commodities" },
  // ── Cross-region sector indices ──
  { re: /Health\s?care|MSCI World Health/i, sector: "healthcare" },
  { re: /Information Technology|Semiconductor|เซมิคอนดักเตอร์/i, sector: "technology" },
  { re: /Biotech/i, sector: "healthcare" },
  { re: /Global REIT|EPRA|REIT(s)? Index/i, sector: "property" },
];

// Official AIMC peer-group codes (legacy v1 FundFactsheet `fund_compare`) →
// facet signals. The AIMC category is the official Thai fund classification
// (43 peer groups, 2021 amendment) but reaches us as a one-shot SNAPSHOT (the
// v1 API retires mid-2026), so it ranks BELOW the living signals (benchmark,
// invest flag) and only fills the gaps they leave. Codes were enumerated from
// the live catalog; anything unknown simply claims nothing (the raw code is
// still stored verbatim in fund_catalog.aimc_category). Allocation /
// miscellaneous codes (AA/MA/CA/FIA/MIS/FF) intentionally claim no region or
// sector.
const AIMC_FACETS: Readonly<Record<string, BenchmarkSignal>> = {
  // Thai equity
  EG: { region: "thailand" }, // Equity General
  ELCE: { region: "thailand" }, // Equity Large Cap
  ESMP: { region: "thailand" }, // Equity Small–Mid Cap
  SET50: { region: "thailand", indexFamily: "SET50" }, // SET 50 Index Fund
  // Country / regional equity
  USEQ: { region: "us" },
  JPEQ: { region: "japan" },
  EUEQ: { region: "europe" },
  CHEQ: { region: "china" }, // Greater China
  EQCHA: { region: "china" }, // China A-shares
  IDEQ: { region: "india" },
  VIEQ: { region: "vietnam" },
  ASEQ: { region: "asean" },
  AEJ: { region: "asia" }, // Asia Pacific ex Japan
  GLEQ: { region: "global" }, // Global Equity
  GEEQ: { region: "emerging" }, // Emerging Market Equity
  // Sector equity
  TECHEQ: { sector: "technology" },
  HCS: { sector: "healthcare" },
  ENG: { sector: "energy" },
  EQGLAENG: { region: "global", sector: "energy" },
  EQGLCGNS: { region: "global", sector: "consumer" },
  EQGLINFRA: { region: "global", sector: "property" },
  // Thai fixed income / money market (duration buckets are all domestic)
  STGOV: { region: "thailand" }, // Short Term Government Bond
  MTGOV: { region: "thailand" },
  STGB: { region: "thailand" }, // Short Term General Bond
  MTGB: { region: "thailand" },
  LTGB: { region: "thailand" },
  MMGOV: { region: "thailand" }, // Money Market Government
  MMG: { region: "thailand" }, // Money Market General
  // Foreign fixed income
  GBF: { region: "global" }, // Global Bond Fully FX Hedged
  GBD: { region: "global" }, // Global Bond Discretionary FX Hedge
  EMBD: { region: "emerging" }, // Emerging Market Bond
  // Commodities / property
  CPM: { sector: "gold" }, // Commodities Precious Metals
  CE: { sector: "commodities" }, // Commodities Energy
  FPF: { sector: "property" }, // Fund of Property Fund
  FFT: { region: "thailand", sector: "property" }, // Fund of Property — Thai
};

/** Facet signals carried by an AIMC peer-group code; empty for unknown codes. */
export function classifyAimcCategory(code: string | null | undefined): BenchmarkSignal {
  if (!code) return {};
  return AIMC_FACETS[code.trim().toUpperCase()] ?? {};
}

/** Classify ONE benchmark string. Returns every signal the string carries. */
export function classifyBenchmarkString(benchmark: string): BenchmarkSignal {
  const out: BenchmarkSignal = {};
  for (const p of BENCHMARK_PATTERNS) {
    if (!p.re.test(benchmark)) continue;
    if (p.region && out.region === undefined) out.region = p.region;
    if (p.sector && out.sector === undefined) out.sector = p.sector;
    if (p.indexFamily && out.indexFamily === undefined) out.indexFamily = p.indexFamily;
  }
  return out;
}

// Name gazetteer — the FALLBACK when benchmarks carry no geography (feeders
// benchmarked to "the master fund", funds with no benchmark). Matched against
// english_name + thai_name + feeder_master_fund ONLY — deliberately NOT the
// investment-policy text: policy prose routinely mentions currencies
// ("ดอลลาร์สหรัฐ" → false 'us') and bank deposits ("ธนาคาร" → false
// 'financials'), which a live probe showed inflates false positives badly.
// Generic words ("asia", "global") are kept LAST so a specific country wins.
const NAME_REGION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/สหรัฐ|อเมริกา|United States|\bUSA?\b|\bU\.S\./i, "us"],
  [/ญี่ปุ่น|Japan|Nikkei|TOPIX/i, "japan"],
  [/จีน|China|Greater China|ฮ่องกง|Hong Kong/i, "china"],
  [/อินเดีย|India(?!n Ocean)/i, "india"],
  [/เวียดนาม|Vietnam/i, "vietnam"],
  [/เกาหลี|Korea/i, "korea"],
  [/สิงคโปร์|Singapore/i, "singapore"],
  // Bare EURO catches index-named funds ("EURO 50"); the lookbehind keeps a
  // future "Neuro…" thematic fund out (none exist in the catalog today).
  [/ยุโรป|ยูโร|Europe|(?<!N)EURO/i, "europe"],
  [/เกิดใหม่|Emerging/i, "emerging"],
  [/อาเซียน|ASEAN/i, "asean"],
  [/เอเชีย|Asia/i, "asia"],
  [/ทั่วโลก|โกลบอล|Global|World/i, "global"],
];

const NAME_SECTOR_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ทองคำ|Gold/i, "gold"],
  [/น้ำมัน|\bOil\b|Energy|พลังงาน/i, "energy"],
  [/เทคโนโลยี|Technology|เซมิคอนดักเตอร์|Semiconductor|\bTech\b/i, "technology"],
  [/สุขภาพ|Health|การแพทย์|Pharma|Biotech/i, "healthcare"],
  [/ธนาคาร|Bank(?:ing)?|Financial/i, "financials"],
  [/อสังหา|Property|REIT|Real Estate|Infrastructure|โครงสร้างพื้นฐาน/i, "property"],
  [/Commodit|โภคภัณฑ์/i, "commodities"],
];

function firstNameMatch(
  text: string,
  patterns: ReadonlyArray<readonly [RegExp, string]>,
): string | null {
  for (const [re, value] of patterns) {
    if (re.test(text)) return value;
  }
  return null;
}

export interface FundFacetInput {
  /** Verbatim benchmark strings (blend rows in order); empty when none declared. */
  benchmarks: string[];
  /** Official AIMC peer-group code ("USEQ", "EQLC"…), when the v1 key is configured. */
  aimcCategory?: string | null;
  englishName?: string | null;
  thaiName?: string | null;
  feederMasterFund?: string | null;
  /** Curated master-fund name from feeder_master_map (look-through), when mapped. */
  curatedMasterName?: string | null;
  /** Coarse SEC geographic mandate: 'foreign' | 'mixed' | 'domestic' | null. */
  investRegion?: string | null;
}

/**
 * Derive a fund's facets — FRESH sources outrank the frozen one:
 *   1. Benchmarks — refreshed every factsheet cycle; every blend row is
 *      classified, and a region is claimed only when all region-bearing rows
 *      AGREE (a 50/50 Thai+global blend claims none).
 *   2. invest_country_flag — 'domestic' (no foreign investment) ⇒ 'thailand',
 *      authoritative and current.
 *   3. AIMC peer-group code — the official classification, but a one-shot
 *      SNAPSHOT (the v1 API retires mid-2026 and never updates again), so it
 *      only fills gaps the living signals leave; it must never override a
 *      fresh benchmark after a fund changes mandate.
 *   4. Name gazetteer over names + master-fund name — first specific match
 *      wins; used only when everything above said nothing.
 * Sector: benchmark first, then AIMC, then names. An index family is claimed
 * from a benchmark, the AIMC code, or the MASTER fund's name — never from the
 * fund's own marketing names. The master-name exception is not inference: a
 * feeder invests ≥80% in its single master fund (SEC rule), so a master named
 * "iShares Core S&P 500 ETF" makes the feeder an S&P 500 fund as a matter of
 * fact — and feeders rarely declare a classifiable benchmark of their own
 * (they benchmark "the master fund's performance").
 */
export function deriveFundFacets(input: FundFacetInput): FundFacets {
  const aimc = classifyAimcCategory(input.aimcCategory);
  const signals = input.benchmarks.map(classifyBenchmarkString);

  // Region: benchmarks (unanimous or nothing) → domestic flag → AIMC snapshot.
  const regions = [...new Set(signals.map((s) => s.region).filter((r): r is string => !!r))];
  let regionFocus: string | null = regions.length === 1 ? regions[0] : null;
  let regionFocusSource: string | null = regionFocus ? "benchmark" : null;

  // Sector: first benchmark that names one (blends across sectors are rare and
  // the first row is the dominant component by convention) → AIMC snapshot.
  let sectorFocus = signals.find((s) => s.sector)?.sector ?? aimc.sector ?? null;
  let indexFamily = signals.find((s) => s.indexFamily)?.indexFamily ?? aimc.indexFamily ?? null;

  // Master-name fallback: the master fund's name names the index a feeder
  // tracks (see the function doc for why this isn't name inference).
  const masterText = [input.feederMasterFund, input.curatedMasterName].filter(Boolean).join(" | ");
  if (!indexFamily && masterText) {
    indexFamily = classifyBenchmarkString(masterText).indexFamily ?? null;
  }

  if (!regionFocus && input.investRegion === "domestic") {
    regionFocus = "thailand";
    regionFocusSource = "invest-flag";
  }

  if (!regionFocus && aimc.region) {
    regionFocus = aimc.region;
    regionFocusSource = "aimc";
  }

  const nameText = [
    input.englishName,
    input.thaiName,
    input.feederMasterFund,
    input.curatedMasterName,
  ]
    .filter(Boolean)
    .join(" | ");

  if (!regionFocus && nameText) {
    regionFocus = firstNameMatch(nameText, NAME_REGION_PATTERNS);
    regionFocusSource = regionFocus ? "name" : null;
  }
  if (!sectorFocus && nameText) {
    sectorFocus = firstNameMatch(nameText, NAME_SECTOR_PATTERNS);
  }

  return { regionFocus, regionFocusSource, sectorFocus, indexFamily };
}
