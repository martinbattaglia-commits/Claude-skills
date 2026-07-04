// US securities catalog refresh — fetch the official Nasdaq Trader symbol
// directory and upsert the listed universe into `us_securities`.
//
// Source: https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt — the
// CONSOLIDATED, keyless, daily-updated directory of every US-listed symbol
// across NYSE / NYSE American / NYSE Arca / Cboe / Nasdaq, with an ETF flag,
// the security name, listing exchange, and a test-issue flag. Pipe-delimited.
//
// This is a single flat file, so there is no sec_raw-style raw landing: parse →
// upsert directly. Symbols the latest directory no longer lists are flipped to
// 'delisted' (kept so a held, since-delisted ticker still resolves a name).

import "server-only";
import {
  findUsRenames,
  listSymbolsMissingFigi,
  markDelistedExcept,
  repointUsNav,
  setUsSecurityFigis,
  type UsSecurityInsert,
  upsertUsSecurities,
} from "../db/queries/us-securities";
import { mapTickersToFigi } from "../market/figi";
import { invalidateUsSecurityIndex } from "../search/us-security-index";

const DIRECTORY_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt";

// Nasdaq directory "Listing Exchange" single-letter code → display name.
const EXCHANGE_MAP: Record<string, string> = {
  A: "NYSE American",
  N: "NYSE",
  P: "NYSE Arca",
  Z: "Cboe BZX",
  V: "IEX",
  Q: "Nasdaq",
  G: "Nasdaq",
  S: "Nasdaq",
};

/**
 * Parse the pipe-delimited directory into catalog rows. Pure — no I/O — so it
 * is unit-testable against a synthetic fixture.
 *
 * Columns (header row):
 *   0 Nasdaq Traded | 1 Symbol | 2 Security Name | 3 Listing Exchange |
 *   4 Market Category | 5 ETF | 6 Round Lot | 7 Test Issue | …
 *
 * Skips: the header row, the trailing "File Creation Time" footer, test issues,
 * and any malformed / symbol-less line.
 */
export function parseNasdaqDirectory(text: string): UsSecurityInsert[] {
  const rows: UsSecurityInsert[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("File Creation Time")) continue;
    const cols = line.split("|");
    if (cols.length < 8) continue;
    // Header row: first field is the literal label, not a Y/N flag.
    if (cols[0] === "Nasdaq Traded") continue;

    const symbol = cols[1]?.trim();
    const name = cols[2]?.trim();
    if (!symbol || !name) continue;
    // Test issues (flag = Y) are not real tradable securities — skip.
    if (cols[7]?.trim() === "Y") continue;
    // Guard against duplicate symbols within one file (keep the first).
    const key = symbol.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const isEtf = cols[5]?.trim() === "Y";
    const exchange = EXCHANGE_MAP[cols[3]?.trim()] ?? null;
    rows.push({
      symbol,
      name,
      securityType: isEtf ? "etf" : "stock",
      exchange,
    });
  }
  return rows;
}

export interface RefreshUsSecuritiesResult {
  parsed: number;
  upserted: number;
  delisted: number;
  active: number;
  /** Symbols newly assigned a composite FIGI this run. */
  figiEnriched: number;
  /** Ticker renames detected via FIGI and bridged in the NAV cache. */
  renamed: number;
}

/** Fetch the directory (overridable for tests via `fetchText`). */
async function defaultFetchText(): Promise<string> {
  const res = await fetch(DIRECTORY_URL, {
    headers: { Accept: "text/plain" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Nasdaq directory fetch returned ${res.status}`);
  }
  return res.text();
}

export interface RefreshUsSecuritiesOptions {
  /** Cap rows processed (dev/spike runs). 0 / undefined = all. */
  limit?: number;
  /** Inject a fetcher for tests; defaults to the live directory. */
  fetchText?: () => Promise<string>;
  /** Run marker; defaults to now. Stamped on every upserted row. */
  seenAt?: string;
  /**
   * How many still-unenriched symbols to map to a composite FIGI this run
   * (popularity/views first). Bounds the OpenFIGI spend so a 12.9k backfill spreads
   * over several nights. 0 / undefined = skip enrichment (also when OpenFIGI is
   * unreachable — it just returns nothing).
   */
  figiBatch?: number;
  /** Inject the FIGI mapper for tests; defaults to the live OpenFIGI client. */
  mapFigis?: (symbols: string[]) => Promise<Map<string, string>>;
}

export async function refreshUsSecurities(
  options: RefreshUsSecuritiesOptions = {},
): Promise<RefreshUsSecuritiesResult> {
  const fetchText = options.fetchText ?? defaultFetchText;
  const seenAt = options.seenAt ?? new Date().toISOString();

  const text = await fetchText();
  let rows = parseNasdaqDirectory(text);
  if (rows.length === 0) {
    // A well-formed-but-empty parse means the upstream shape changed; refuse to
    // delist the whole catalog on a bad fetch.
    throw new Error("Nasdaq directory parsed to zero rows — aborting (upstream shape changed?)");
  }
  if (options.limit && options.limit > 0) rows = rows.slice(0, options.limit);

  const upserted = upsertUsSecurities(rows, seenAt);
  // Skip the delist sweep on a partial (--limit) run — it would wrongly delist
  // everything past the cap.
  const delisted = options.limit && options.limit > 0 ? 0 : markDelistedExcept(seenAt);

  // Enrich a bounded batch of still-unmapped symbols with their composite FIGI
  // (the rename-persistent anchor), then bridge any FIGI-detected rename in the
  // NAV cache. Both are no-ops when figiBatch is unset / OpenFIGI returns nothing.
  let figiEnriched = 0;
  let renamed = 0;
  if (options.figiBatch && options.figiBatch > 0) {
    const mapFigis = options.mapFigis ?? mapTickersToFigi;
    const missing = listSymbolsMissingFigi(options.figiBatch);
    if (missing.length > 0) {
      const figis = await mapFigis(missing);
      figiEnriched = setUsSecurityFigis([...figis].map(([symbol, figi]) => ({ symbol, figi })));
    }
    for (const { oldSymbol, newSymbol } of findUsRenames()) {
      repointUsNav(oldSymbol, newSymbol);
      renamed++;
    }
  }

  // Rebuild the in-memory search index next time it's queried (belt-and-braces —
  // the index's own staleness signature already covers a catalog change).
  invalidateUsSecurityIndex();

  return { parsed: rows.length, upserted, delisted, active: upserted, figiEnriched, renamed };
}
