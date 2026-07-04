// OpenFIGI client — maps a US ticker to its composite FIGI, the rename-PERSISTENT
// security-level identifier we anchor US holdings on (the analogue of a Thai
// fund's ISIN). FIGI is MIT-licensed and freely redistributable (unlike CUSIP /
// ISIN, which are license-restricted), survives ticker renames (FB→META keep one
// composite FIGI), and covers US stocks + ETFs.
//
// Endpoint: POST https://api.openfigi.com/v3/mapping
// Body: [{ idType:"TICKER", idValue:"META", exchCode:"US" }, …]  (exchCode US →
// the composite FIGI). Response is a parallel array of { data:[{compositeFigi,…}] }
// or { warning }. An optional free OPENFIGI_API_KEY raises the rate limit
// (25 req/6s, 100 jobs/batch) over the anonymous tier (25 req/min, 10 jobs/batch).

import "server-only";

const MAPPING_URL = "https://api.openfigi.com/v3/mapping";

function apiKey(): string | undefined {
  const k = process.env.OPENFIGI_API_KEY?.trim();
  return k ? k : undefined;
}

// Batch size + inter-batch delay honour the documented limits of whichever tier
// is active, so a large catalog backfill self-throttles instead of getting 429'd.
function limits(): { batch: number; delayMs: number } {
  return apiKey() ? { batch: 100, delayMs: 300 } : { batch: 10, delayMs: 2500 };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface OpenFigiResult {
  // OpenFIGI capitalizes "FIGI" in these field names (compositeFIGI, not -Figi).
  data?: { compositeFIGI?: string; figi?: string; ticker?: string }[];
  warning?: string;
}

/** The security-id types OpenFIGI can map to a ticker (both license-free to send). */
export type SecurityIdType = "ID_ISIN" | "ID_CUSIP";

/**
 * Map US tickers → composite FIGI. Returns a Map of symbol → FIGI for the symbols
 * OpenFIGI resolved (unmatched symbols are simply absent). `fetchImpl` is
 * injectable for tests. Self-throttles to the active tier's rate limit.
 */
export async function mapTickersToFigi(
  symbols: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (unique.length === 0) return out;

  const { batch, delayMs } = limits();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = apiKey();
  if (key) headers["X-OPENFIGI-APIKEY"] = key;

  for (let i = 0; i < unique.length; i += batch) {
    const chunk = unique.slice(i, i + batch);
    const body = chunk.map((idValue) => ({ idType: "TICKER", idValue, exchCode: "US" }));
    const res = await fetchImpl(MAPPING_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) {
      // A rate-limit/transient error shouldn't lose the symbols already mapped;
      // stop this run and let the next one resume the remainder.
      break;
    }
    const json = (await res.json()) as OpenFigiResult[];
    json.forEach((r, idx) => {
      // Prefer the composite FIGI (stable across exchanges); the exchange-level
      // `figi` is the fallback (equals composite for an exchCode=US query).
      const figi = r.data?.[0]?.compositeFIGI ?? r.data?.[0]?.figi;
      if (figi) out.set(chunk[idx], figi);
    });
    if (i + batch < unique.length) await sleep(delayMs);
  }
  return out;
}

/**
 * Map US security IDs (ISIN or CUSIP) → ticker (US composite). Returns a Map of
 * idValue → ticker for the IDs OpenFIGI resolved to a US listing (unmatched IDs
 * are simply absent). This is the reverse of a fund's holdings file, which carries
 * CUSIP/ISIN but no ticker — the crosswalk that makes ETF holdings tappable and a
 * stock's "held via" list computable. Batched + rate-limited like the FIGI path;
 * `fetchImpl` is injectable for tests.
 */
export async function mapIdsToTickers(
  ids: { idType: SecurityIdType; idValue: string }[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  const unique = ids
    .map((x) => ({ idType: x.idType, idValue: x.idValue.trim() }))
    .filter((x) => {
      if (!x.idValue || seen.has(x.idValue)) return false;
      seen.add(x.idValue);
      return true;
    });
  if (unique.length === 0) return out;

  const { batch, delayMs } = limits();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = apiKey();
  if (key) headers["X-OPENFIGI-APIKEY"] = key;

  for (let i = 0; i < unique.length; i += batch) {
    const chunk = unique.slice(i, i + batch);
    const body = chunk.map((x) => ({ idType: x.idType, idValue: x.idValue, exchCode: "US" }));
    const res = await fetchImpl(MAPPING_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
    });
    // A rate-limit/transient error shouldn't lose what's already mapped; stop and
    // let the next run resume the remainder.
    if (!res.ok) break;
    const json = (await res.json()) as OpenFigiResult[];
    json.forEach((r, idx) => {
      const ticker = r.data?.[0]?.ticker;
      if (ticker) out.set(chunk[idx].idValue, ticker.trim().toUpperCase());
    });
    if (i + batch < unique.length) await sleep(delayMs);
  }
  return out;
}

/** Map a single ticker → composite FIGI (or null). Used at holding-creation time. */
export async function figiForTicker(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const m = await mapTickersToFigi([symbol], fetchImpl);
  return m.get(symbol.trim().toUpperCase()) ?? null;
}
