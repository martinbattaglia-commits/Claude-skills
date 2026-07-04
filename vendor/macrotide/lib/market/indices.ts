// Index membership for US stocks (S&P 500 / Nasdaq 100 / Dow), from public open
// datasets — the detail page's "member of" chips. Keyless, redistributable:
//   • S&P 500   — datahub constituents (ODC-PDDL)
//   • Nasdaq 100 / Dow — yfiua/index-constituents (Apache-2.0)
// A symbol can belong to several, so membership is a set per symbol.

import "server-only";
import { splitCsvLine } from "./gics";

export type IndexKey = "sp500" | "nasdaq100" | "dow";

export const INDEX_LABELS: Record<IndexKey, string> = {
  sp500: "S&P 500",
  nasdaq100: "Nasdaq 100",
  dow: "Dow Jones",
};

// Stable display order (also the order stored in the comma-joined column).
export const INDEX_KEYS: IndexKey[] = ["sp500", "nasdaq100", "dow"];
const INDEX_ORDER = INDEX_KEYS;

// The 11 GICS sectors — the S&P 500 partitioned by sector, which is exactly what
// the Select Sector SPDRs (XLK, XLF, …) and Vanguard sector ETFs track. `sector`
// matches us_securities.gics_sector verbatim (only S&P 500 members carry it, so a
// sector set IS the S&P 500 slice); `key` is stored in tracks_index; `label` is
// the display string. Sector membership + tracking derive from the same public
// S&P 500 GICS dataset that already populates gics_sector — no new source.
export interface SectorIndex {
  key: string;
  sector: string;
  label: string;
}
export const SP500_SECTORS: SectorIndex[] = [
  { key: "sector:energy", sector: "Energy", label: "Energy sector" },
  { key: "sector:materials", sector: "Materials", label: "Materials sector" },
  { key: "sector:industrials", sector: "Industrials", label: "Industrials sector" },
  {
    key: "sector:discretionary",
    sector: "Consumer Discretionary",
    label: "Consumer Discretionary sector",
  },
  { key: "sector:staples", sector: "Consumer Staples", label: "Consumer Staples sector" },
  { key: "sector:health", sector: "Health Care", label: "Health Care sector" },
  { key: "sector:financials", sector: "Financials", label: "Financials sector" },
  { key: "sector:it", sector: "Information Technology", label: "Information Technology sector" },
  {
    key: "sector:communication",
    sector: "Communication Services",
    label: "Communication Services sector",
  },
  { key: "sector:utilities", sector: "Utilities", label: "Utilities sector" },
  { key: "sector:realestate", sector: "Real Estate", label: "Real Estate sector" },
];

const SECTOR_BY_KEY = new Map(SP500_SECTORS.map((s) => [s.key, s]));
const SECTOR_BY_NAME = new Map(SP500_SECTORS.map((s) => [s.sector, s]));

const warnedSectors = new Set<string>();

/** The tracks_index key for a us_securities.gics_sector value, or null. */
export function sectorKeyForGics(gicsSector: string | null | undefined): string | null {
  if (!gicsSector) return null;
  const key = SECTOR_BY_NAME.get(gicsSector)?.key ?? null;
  // A present-but-unmapped sector means the upstream GICS dataset drifted from the
  // 11 names we hardcode (e.g. a rename) — it silently drops that stock's sector
  // cross-links, so surface it in dev (once per distinct value).
  if (!key && process.env.NODE_ENV !== "production" && !warnedSectors.has(gicsSector)) {
    warnedSectors.add(gicsSector);
    console.warn(`[indices] unmapped GICS sector "${gicsSector}" — check SP500_SECTORS for drift`);
  }
  return key;
}

/** Display label for any tracking/membership key (broad index or S&P sector). */
export function trackingLabel(key: string): string {
  if (key in INDEX_LABELS) return INDEX_LABELS[key as IndexKey];
  return SECTOR_BY_KEY.get(key)?.label ?? key;
}

const SOURCES: Record<IndexKey, string> = {
  sp500:
    "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv",
  nasdaq100:
    "https://raw.githubusercontent.com/yfiua/index-constituents/main/docs/constituents-nasdaq100.csv",
  dow: "https://raw.githubusercontent.com/yfiua/index-constituents/main/docs/constituents-dowjones.csv",
};

/** Symbols from the "Symbol" column of a constituents CSV. Pure. */
export function parseSymbolColumn(text: string): string[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const si = header.indexOf("Symbol");
  if (si < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(1)) {
    const s = (splitCsvLine(line)[si] ?? "").trim().toUpperCase();
    if (s) out.push(s);
  }
  return out;
}

export interface IndexMembership {
  symbol: string;
  /** Index keys this symbol belongs to, in stable order. */
  indices: IndexKey[];
}

/** Fetch all three index lists → per-symbol membership (a failed list is skipped). */
export async function fetchIndexMembership(
  fetchImpl: typeof fetch = fetch,
): Promise<IndexMembership[]> {
  const sets = new Map<string, Set<IndexKey>>();
  for (const key of INDEX_ORDER) {
    try {
      const res = await fetchImpl(SOURCES[key], {
        headers: { Accept: "text/csv" },
        cache: "no-store",
      });
      if (!res.ok) continue;
      for (const s of parseSymbolColumn(await res.text())) {
        const set = sets.get(s) ?? new Set<IndexKey>();
        set.add(key);
        sets.set(s, set);
      }
    } catch {
      // skip this list; partial membership is better than none
    }
  }
  return [...sets].map(([symbol, set]) => ({
    symbol,
    indices: INDEX_ORDER.filter((k) => set.has(k)),
  }));
}
