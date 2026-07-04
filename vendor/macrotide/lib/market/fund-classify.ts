// Classification of raw SEC fund-profile fields into the catalog's normalized
// columns. This is the shared contract between the ingestion job (which maps
// each `/v2/fund/general-info/profiles` row through these helpers) and the
// catalog schema.
//
// IMPORTANT: the v2 profiles endpoint does NOT return `fund_type_en`/`fund_type_th`
// (they 404 / are absent). Asset class is derived from `policy_desc` (a short
// Thai asset-type label) instead. See the data-inventory findings.

/** Raw SEC `fund_status` values, and the rule for "currently offered". */
export const ACTIVE_SEC_STATUSES = ["Registered", "IPO"] as const;

export function statusFromSec(secStatus: string | null | undefined): "active" | "inactive" {
  return secStatus && (ACTIVE_SEC_STATUSES as readonly string[]).includes(secStatus)
    ? "active"
    : "inactive";
}

/**
 * Whether to spend an API call fetching this fund's fees. Only `Registered`
 * funds have meaningful fee data: inactive funds are dead, and `IPO` funds
 * return truncated/unparseable fee JSON until they transition to Registered.
 */
export function shouldFetchFees(secStatus: string | null | undefined): boolean {
  return secStatus === "Registered";
}

/**
 * Index/passive funds are the `PM` (passive/index-tracking) and `PN` (feeder
 * whose MASTER fund is passive) management styles — nothing else. Notably
 * `SM` ("index tracking with occasional alpha", i.e. enhanced index) and `AN`
 * (feeder whose master is active) stay OUT: only pure passive earns "index"
 * in an index-investor app.
 */
export function isIndexStyle(managementStyle: string | null | undefined): boolean {
  return managementStyle === "PN" || managementStyle === "PM";
}

/**
 * The screener's index/active facet, derived from `management_style` on read
 * (a pure 1:1 function of a stored, indexed column — no catalog column needed).
 * 'active' is the complement bucket: AM/AN active, SM enhanced-index, BH
 * buy-and-hold, IM/IN inverse, LM/LN leveraged, OT other, and NULL (the SEC
 * didn't publish a style — certainly not a verified index fund).
 */
export function indexTypeFromManagementStyle(
  managementStyle: string | null | undefined,
): "index" | "active" {
  return isIndexStyle(managementStyle) ? "index" : "active";
}

// policy_desc (Thai short label) → normalized asset class. `ผสม` (mixed) and
// anything unrecognized stay NULL so allocation math doesn't bucket a balanced
// fund into one class. Matched by substring to tolerate trailing qualifiers.
const ASSET_CLASS_BY_POLICY: ReadonlyArray<readonly [string, string]> = [
  ["ตราสารหนี้", "bond"], // fixed income
  ["ตราสารทุน", "equity"], // equity
  ["ทรัพย์สินทางเลือก", "alternative"], // alternatives (REITs, gold, etc.)
];

/**
 * Normalized asset class from the SEC's coarse `policy_desc` label, refined by
 * the fund name.
 *
 * Money market is a distinct cash-equivalent bucket the screener filters on, but
 * the v2 `policy_desc` field has no money-market value — every money-market fund
 * is labelled `ตราสารหนี้` (fixed income), so a `cash` class derived from
 * `policy_desc` alone is empty by construction. The fund NAME reliably carries
 * the money-market marker instead — Thai `ตลาดเงิน` or English `money market`
 * (some funds spell it only one way, e.g. `ดาโอ มันนี่ มาร์เก็ต` /
 * `DAOL Money Market`) — and nothing else does (verified: every name match is
 * otherwise a bond, zero equity/mixed false positives), so we recover `cash`
 * from the name before falling back to the policy label.
 */
export function inferAssetClass(
  policyDescTh: string | null | undefined,
  nameTh?: string | null | undefined,
  nameEn?: string | null | undefined,
): string | null {
  // money market → cash-equivalent, recovered from either-language name
  if (nameTh?.includes("ตลาดเงิน") || /money\s*market/i.test(nameEn ?? "")) return "cash";
  if (!policyDescTh) return null;
  for (const [needle, cls] of ASSET_CLASS_BY_POLICY) {
    if (policyDescTh.includes(needle)) return cls;
  }
  return null; // ผสม (mixed) and unknowns
}

// SEC `risk_spectrum` code → normalized asset class. The risk spectrum is the
// AMC-reported regulatory risk level on the fund factsheet — a structured signal
// that, unlike the coarse `policy_desc`, cleanly separates money market from bond
// and recovers asset classes `policy_desc` leaves blank. It is the PRIMARY asset-
// class signal; `inferAssetClass` (policy_desc + the money-market name match) is
// the FALLBACK for the handful of funds with no risk-spectrum record.
//
// The Thai SEC scale (verified live against the universe):
//   RS1  domestic money market            → cash
//   RS2  money market incl. some foreign   → cash
//   RS3  government bond                    → bond
//   RS4  general fixed income              → bond
//   RS5  mixed/allocation OR high-yield bond → AMBIGUOUS (defer to policy)
//   RS6  equity (≥80% NAV)                 → equity
//   RS7  sector / concentrated equity      → equity
//   RS8  alternative (REITs, infra, oil…)  → alternative
//   RS81, RS8+  concentrated / complex (bond, private equity, …) → AMBIGUOUS
//
// RS1/RS2 are authoritative for cash: the cross-check found zero name-detected
// money-market funds without an RS1/RS2 code, and RS recovers ~25 more (e.g.
// treasury / cash-management funds whose names omit "money market"). RS5 and the
// RS8x complex codes mix asset classes within one code, so they return undefined
// and let the policy/name fallback decide rather than forcing a wrong bucket.
//
// Returns `undefined` (not null) for "no opinion — fall back": null is a real
// answer (mixed/unclassifiable), so the caller distinguishes the two via `??`.
const ASSET_CLASS_BY_RISK_SPECTRUM: Readonly<Record<string, string>> = {
  RS1: "cash",
  RS2: "cash",
  RS3: "bond",
  RS4: "bond",
  RS6: "equity",
  RS7: "equity",
  RS8: "alternative",
};

export function assetClassFromRiskSpectrum(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  return ASSET_CLASS_BY_RISK_SPECTRUM[code]; // undefined for RS5 / RS81 / RS8+ / unknown
}

/**
 * Normalized asset class, risk-spectrum first then policy/name. The SEC risk
 * code is the structured primary signal; for funds without one (or with an
 * ambiguous RS5/RS8x code) we fall back to {@link inferAssetClass}.
 */
export function deriveAssetClass(
  riskSpectrum: string | null | undefined,
  policyDescTh: string | null | undefined,
  nameTh?: string | null | undefined,
  nameEn?: string | null | undefined,
): string | null {
  return assetClassFromRiskSpectrum(riskSpectrum) ?? inferAssetClass(policyDescTh, nameTh, nameEn);
}

// fund_class_tax_incentive_type (Thai) → wrapper code.
const TAX_INCENTIVE_BY_LABEL: ReadonlyArray<readonly [string, string]> = [
  ["เพื่อการออม", "SSF"], // กองทุนรวมเพื่อการออม
  ["ไทยเพื่อความยั่งยืน", "ThaiESG"], // กองทุนรวมไทยเพื่อความยั่งยืน
  ["เพื่อการเลี้ยงชีพ", "RMF"], // กองทุนรวมเพื่อการเลี้ยงชีพ
];

export function classifyTaxIncentive(label: string | null | undefined): string | null {
  if (!label) return null;
  for (const [needle, code] of TAX_INCENTIVE_BY_LABEL) {
    if (label.includes(needle)) return code;
  }
  return null;
}

// fund_class_detail (Thai) → distribution policy.
export function classifyDistribution(detail: string | null | undefined): string | null {
  if (!detail) return null;
  if (detail.includes("จ่ายเงินปันผล")) return "dividend";
  if (detail.includes("สะสมมูลค่า")) return "accumulating";
  return null;
}

// fund_class_detail (Thai) → investor audience. Drives the screener's
// retail-default + ranking: some classes have NAV but the general public can't
// (or wouldn't) subscribe to them directly.
//   สำหรับผู้ลงทุนทั่วไป              → retail (general public)
//   ผู้ลงทุนกลุ่ม / ผู้ลงทุนพิเศษ      → restricted (provident/private/special-group)
//   ควบประกัน / กรมธรรม์ประกันชีวิต    → insurance (unit-linked policy)
//   สำหรับผู้ลงทุนสถาบัน             → institutional
// A bare/absent detail (single-class "main" funds) is retail by default.
//
// Precedence matters:
//  - **ทั่วไป (general public) wins first.** A dual-purpose class offered to the
//    general public AND via an insurance/group channel (e.g. an "RU" class) is
//    retail-buyable, so it must not be mislabeled insurance/restricted.
//  - **Insurance keys on "ควบประกัน" / "กรมธรรม์ประกันชีวิต", never bare "ประกัน"**
//    — some details say "…ไม่มีสิทธิประโยชน์ประกัน" (explicitly *without* insurance).
export function classifyInvestorType(detail: string | null | undefined): string | null {
  if (!detail) return "retail";
  if (detail.includes("ทั่วไป")) return "retail";
  if (detail.includes("ควบประกัน") || detail.includes("กรมธรรม์ประกันชีวิต")) return "insurance";
  if (detail.includes("สถาบัน")) return "institutional";
  // Provident-fund / private-fund / special-group classes: have NAV but aren't
  // sold to the general public. Kept visible in the screener but DOWN-RANKED
  // below retail (not hidden) — unlike institutional/insurance, which are hidden.
  if (detail.includes("ผู้ลงทุนกลุ่ม") || detail.includes("ผู้ลงทุนพิเศษ")) return "restricted";
  // Anything unrecognized: leave null so the screener neither hides nor mislabels.
  return null;
}

// invest_country_flag → geographic mandate.
export function classifyInvestRegion(flag: string | null | undefined): string | null {
  switch (flag) {
    case "1":
      return "foreign";
    case "3":
      return "mixed";
    case "4":
      return "domestic";
    default:
      return null;
  }
}

/**
 * Formal factsheet dividend-policy code (fund_dividend_policy) → the catalog's
 * distribution vocabulary. Authoritative when present — prefer it over the
 * Thai-text parsing of fund_class_detail (classifyDistribution), which stays
 * as the fallback for the ~20% of classes without a landed code.
 */
export function distributionFromDividendPolicy(
  code: string | null | undefined,
): "dividend" | "accumulating" | null {
  switch (code?.trim().toUpperCase()) {
    case "Y":
      return "dividend";
    case "N":
      return "accumulating";
    default:
      return null;
  }
}

// exchange_rate_protection_policy (Thai label, free-ish text with parentheticals)
// → normalized FX-hedging policy, matched by prefix on the leading Thai phrase;
// the raw label stays verbatim in sec_raw. Observed values (live probe):
//   ทั้งหมด / ทั้งหมด/เกือบทั้งหมด (fully hedged)   → 'full'
//   ดุลยพินิจ (dynamic/discretionary hedging)       → 'discretionary'
//   บางส่วน (partial)                               → 'partial'
//   ไม่ป้องกัน (no hedge)                           → 'none'
//   กำหนดในระดับชนิดหน่วยลงทุน (set per share class) → 'per-class'
const FX_HEDGING_BY_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ["ทั้งหมด", "full"],
  ["ดุลยพินิจ", "discretionary"],
  ["บางส่วน", "partial"],
  ["ไม่ป้องกัน", "none"],
  ["กำหนดในระดับชนิดหน่วยลงทุน", "per-class"],
];

/**
 * Normalized FX-hedging policy for foreign-exposure funds:
 * 'full' | 'discretionary' | 'partial' | 'none' | 'per-class' | null (not
 * stated — typically domestic funds with no FX risk to hedge). A hedged and an
 * unhedged class of the same exposure are different products — this feeds
 * like-for-like comparison and a future screener facet.
 */
export function classifyFxHedging(label: string | null | undefined): string | null {
  const t = label?.trim();
  if (!t) return null;
  for (const [prefix, value] of FX_HEDGING_BY_PREFIX) {
    if (t.startsWith(prefix)) return value;
  }
  return null;
}

/**
 * investment_policy_desc arrives as HTML (`<p>…`, entities). Strip tags and
 * collapse whitespace so the catalog column holds plain searchable text; the
 * verbatim HTML stays in sec_raw. Returns null for empty/whitespace-only input.
 */
export function stripPolicyHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // &amp; last, so a double-encoded entity ("&amp;lt;") unescapes only once.
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}
