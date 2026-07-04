// US dividend history from Alpaca's corporate-actions API — the detail page's
// dividend list + trailing yield. Alpaca is already our keyed US price fallback;
// its corporate-actions data is factual (ex/record/pay dates + cash amount) and
// carries no personal-use clause, so it's the cleanest free source we already
// hold keys for. Returns [] when unkeyed (the feature just stays empty).
//
// Endpoint: https://data.alpaca.markets/v1beta1/corporate-actions
//   ?symbols=AAPL&types=cash_dividend&start=YYYY-MM-DD&limit=1000
// Response: { corporate_actions: { cash_dividends: [{ ex_date, payable_date,
//            record_date, rate, special, symbol }] }, next_page_token }

import { readAlpacaCreds } from "./providers/alpaca";

const CA_URL = "https://data.alpaca.markets/v1beta1/corporate-actions";

export interface UsDividend {
  exDate: string;
  payableDate: string | null;
  recordDate: string | null;
  /** Cash per share (USD). */
  cashAmount: number;
  special: boolean;
}

interface AlpacaCashDividend {
  ex_date?: string;
  payable_date?: string | null;
  record_date?: string | null;
  rate?: number | string;
  special?: boolean;
}

export interface DividendFetch {
  dividends: UsDividend[];
  /** True iff Alpaca was reachable + returned 2xx (so an empty list is a GENUINE
   *  no-dividend stock, safe to cache). False = no creds / HTTP failure → the
   *  caller should NOT cache it, so it retries (don't show "no dividends" wrongly). */
  fetched: boolean;
}

/**
 * Fetch a symbol's cash-dividend history (newest first) over ~`years` (default 5).
 * Paginates Alpaca's `next_page_token`. Never throws.
 */
export async function fetchDividends(
  symbol: string,
  opts: { years?: number; fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<DividendFetch> {
  const c = readAlpacaCreds();
  if (!c) return { dividends: [], fetched: false };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? new Date();
  const start = new Date(now.getTime() - (opts.years ?? 5) * 366 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const out: UsDividend[] = [];
  let fetched = false;
  let pageToken: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const url = new URL(CA_URL);
    url.searchParams.set("symbols", symbol.trim().toUpperCase());
    url.searchParams.set("types", "cash_dividend");
    url.searchParams.set("start", start);
    url.searchParams.set("limit", "1000");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "APCA-API-KEY-ID": c.keyId,
          "APCA-API-SECRET-KEY": c.secretKey,
        },
        cache: "no-store",
      });
    } catch {
      break;
    }
    if (!res.ok) break;
    fetched = true; // a 2xx — the result (even if empty) is authoritative
    const json = (await res.json()) as {
      corporate_actions?: { cash_dividends?: AlpacaCashDividend[] };
      next_page_token?: string | null;
    };
    for (const d of json.corporate_actions?.cash_dividends ?? []) {
      const cash = Number(d.rate);
      if (!d.ex_date || !Number.isFinite(cash)) continue;
      out.push({
        exDate: d.ex_date,
        payableDate: d.payable_date ?? null,
        recordDate: d.record_date ?? null,
        cashAmount: cash,
        special: Boolean(d.special),
      });
    }
    pageToken = json.next_page_token ?? undefined;
    if (!pageToken) break;
  }
  out.sort((a, b) => b.exDate.localeCompare(a.exDate));
  return { dividends: out, fetched };
}

/**
 * Trailing-12-month dividend yield = sum(cash per share, ex-date within ~1y of
 * `asOf`) ÷ current price. Pure. Null when price is missing/≤0 or no TTM dividends.
 */
export function trailingYield(
  dividends: { exDate: string; cashAmount: number | null }[],
  price: number | null,
  asOf: string,
): number | null {
  if (!price || price <= 0) return null;
  const cutoff = new Date(new Date(asOf).getTime() - 366 * 86_400_000).toISOString().slice(0, 10);
  const ttm = dividends
    .filter((d) => d.exDate >= cutoff)
    .reduce((sum, d) => sum + (d.cashAmount ?? 0), 0);
  return ttm > 0 ? ttm / price : null;
}
