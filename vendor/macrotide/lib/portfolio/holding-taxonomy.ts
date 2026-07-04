// Display taxonomy for a holdings-list row: the facets a row surfaces beside its
// ticker, each orthogonal so none restates another.
//
//   • KIND (structure)  — Fund / ETF / Stock / Cash, the line-1 chip. Answers
//     "what kind of instrument is this". Cash is always "Cash"; the set-aside
//     (Reserved) status is NOT a kind — it rides as a separate lock marker.
//   • CATEGORY (asset class) — Equity / Fixed Income / Mixed / Alternative, the
//     first line-2 token. Thai SEC policy text is translated to English here.
//   • GEOGRAPHY (exposure) — US / Intl / EM / Global, the second line-2 token,
//     shown only where we're confident (a single stock, a known index ETF, a
//     Thai fund's SEC region) and omitted otherwise — never guessed from the
//     listing country, which for a US-listed ETF says nothing about exposure.
//
// Pure + framework-free (no DB, no network) so the holdings list and its tests
// can import it directly.

import type { Holding } from "@/lib/static/types";

export type HoldingKind = "Fund" | "ETF" | "Stock" | "Cash";

/**
 * The line-1 type chip: instrument structure only. Thai fund → "Fund"; US security
 * → "ETF"/"Stock" from its catalog type; cash → "Cash" (the Reserved earmark is a
 * status marker, not a kind). `null` — no guessed chip — for an unresolved US
 * holding or a custom self-priced asset.
 */
export function holdingKind(h: Holding): HoldingKind | null {
  if (h.quoteSource === "thai_mutual_fund") return "Fund";
  if (h.quoteSource === "market") {
    if (h.instrumentType === "etf") return "ETF";
    if (h.instrumentType === "stock") return "Stock";
  }
  if (h.quoteSource === "cash") return "Cash";
  return null;
}

// Thai SEC investment-policy text → English, matched by leading canonical term.
// The catalog stores verbose variants ("ผสม (ไม่กำหนดสัดส่วน…)") that all begin
// with one of these prefixes, so a startsWith match collapses them to the clean
// asset class. Order matters only in that each key is a distinct prefix.
const THAI_POLICY_PREFIXES: [string, string][] = [
  ["ตราสารหนี้", "Fixed Income"],
  ["ตราสารทุน", "Equity"],
  ["ผสม", "Mixed"],
  ["ทรัพย์สินทางเลือก", "Alternative"],
  ["อื่น", "Other"], // "อื่น ๆ" / "อื่นๆ"
];

/** Translate a Thai SEC policy description to its English asset class, or null
 *  when it isn't one of the known policy families (caller keeps the original). */
export function translateThaiPolicy(category: string | null | undefined): string | null {
  const c = category?.trim();
  if (!c) return null;
  for (const [prefix, en] of THAI_POLICY_PREFIXES) {
    if (c.startsWith(prefix)) return en;
  }
  return null;
}

const CLASS_LABEL: Record<string, string> = {
  equity: "Equity",
  bond: "Fixed Income",
  mixed: "Mixed",
  alternative: "Alternative",
  cash: "Cash",
};

/**
 * The line-2 category tag: the holding's ASSET CLASS, structure-free so it never
 * doubles the kind chip.
 *   • Thai fund  → the SEC policy family, translated to English ("Equity", "Mixed",
 *     "Fixed Income", …); the raw text is kept only if it isn't a known family.
 *   • US security → its asset class ("Equity" / "Fixed Income" / "Alternative"). A
 *     single stock is equity by definition; an ETF's class comes from the catalog
 *     (absent → no tag, the chip still says ETF).
 *   • Cash → empty (the chip carries the type; the caller appends the earmark
 *     purpose separately).
 */
export function holdingCategoryLabel(h: Holding): string {
  if (h.quoteSource === "cash") return "";
  if (h.quoteSource === "thai_mutual_fund") {
    return translateThaiPolicy(h.category) ?? h.category ?? "";
  }
  if (h.quoteSource === "market") {
    if (h.instrumentType === "stock") return "Equity";
    return CLASS_LABEL[h.class] ?? "";
  }
  return h.category ?? "";
}

type Region = "US" | "Intl" | "EM" | "Global";

// Curated exposure region for the well-known index ETFs — the "high confidence"
// tier that lets us show geography without asserting it from the listing country
// (the catalog's own geo columns are too sparse: tracks_index covers only a handful
// of ETFs, and N-PORT look-through country data only the funds we've fetched). Kept
// as space-separated lists per region so it's easy to scan and extend; a ticker in
// no list shows no region rather than a guess. Region is EXPOSURE, independent of
// asset class — a US-Treasury ETF is "US", an ex-US bond ETF is "Intl". Single-
// country funds follow their index provider (MSCI: Korea/Taiwan = EM).
const ETF_REGION_LISTS: Record<Region, string> = {
  US:
    // broad / style / factor / dividend / sector / REIT
    "VTI VOO SPY IVV ITOT SCHB SCHX VV MGC IWV VXF VTWO VUG VTV VB VO VBR VBK VOT VOE " +
    "IJH IJR MDY VYM VIG SCHD DGRO DGRW NOBL SDY HDV DVY SCHG SCHV SCHM SCHA SPTM SPMD " +
    "SPSM MTUM QUAL USMV VLUE QQQ QQQM DIA IWM IWB IWD IWF IWN IWO IWP IWS SPLG SPYG SPYV " +
    "MGK RSP VOOG VOOV JEPI JEPQ AVUV DFAC XLK XLF XLE XLV XLY XLP XLI XLU XLB XLRE XLC " +
    "SMH SOXX VFH VHT VDC VDE VIS VGT VOX VPU VNQ IYR SCHH " +
    // US bonds
    "BND AGG SCHZ GOVT TLT IEF SHY LQD HYG JNK MUB VCIT VCSH TIP BSV BIV BLV VGSH VGIT " +
    "VGLT VMBS MBB IGSB IGIB VTEB SHV BIL SGOV USFR FBND TLH EDV MINT",
  Intl:
    // developed ex-US: broad, style, single-country, bonds
    "VXUS VEA IEFA EFA SCHF IXUS VEU IDEV EFV EFG DFAI AVDV SCHC VSS VGK IEUR IEV FEZ " +
    "HEFA DBEF VNQI ACWX EWJ EWU EWG EWQ EWL EWA EWC EWS BNDX IAGG BWX FNDF",
  EM: "VWO IEMG EEM SCHE SPEM FNDE AVEM DFEM FXI MCHI KWEB ASHR INDA EWZ EWW EZA EMXC EWY EWT EMB VWOB",
  Global: "VT ACWI URTH VXC IOO DGT SPGM REET RWO",
};

const ETF_REGION: Record<string, Region> = Object.fromEntries(
  (Object.entries(ETF_REGION_LISTS) as [Region, string][]).flatMap(([region, list]) =>
    list.split(/\s+/).map((ticker) => [ticker, region] as const),
  ),
);

/**
 * Confidence-tiered exposure geography — "US" / "Intl" / "EM" / "Global" — or null
 * when we can't stand behind a value (never guessed from listing country):
 *   • US single stock → "US" (a listed company is domestic exposure).
 *   • US ETF → the DERIVED N-PORT region (`exposureRegion`, broad coverage) if
 *     present, else the curated {@link ETF_REGION} starter map, else null.
 *   • Thai fund → its SEC investment region ("Thailand" / "Foreign"); "Mixed" and
 *     unknowns are omitted rather than shown as an ambiguous label.
 *   • Cash / custom → null.
 */
export function holdingGeography(h: Holding): string | null {
  if (h.quoteSource === "thai_mutual_fund") {
    const r = h.region?.trim();
    return r === "Thailand" || r === "Foreign" ? r : null;
  }
  if (h.quoteSource === "market") {
    if (h.instrumentType === "stock") return "US";
    if (h.instrumentType === "etf")
      return h.exposureRegion ?? ETF_REGION[h.ticker.trim().toUpperCase()] ?? null;
  }
  return null;
}
