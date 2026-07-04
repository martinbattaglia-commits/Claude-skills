// Alpaca most-actives screener — the DERIVED popularity signal for the
// US popular-prewarm warm set. One call returns the day's most-active US symbols
// (stocks AND ETFs) by share volume; the refresh-popular job re-ranks them by
// dollar volume and filters leveraged/inverse names. No hardcoded ticker list.
//
// Shares the Alpaca credential reader with the price provider, so it's keyed by
// the same ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY and is a no-op (empty) when
// they're unset. Credentials ride request headers, never the URL, never logged.
//
// Endpoint: https://data.alpaca.markets/v1beta1/screener/stocks/most-actives
// Response: { most_actives: [{ symbol, volume, trade_count }], last_updated }

import "server-only";
import { readAlpacaCreds } from "./providers/alpaca";

const SCREENER_URL = "https://data.alpaca.markets/v1beta1/screener/stocks/most-actives";

export interface MostActive {
  symbol: string;
  /** Day's share volume. */
  volume: number;
  /** Day's trade count (a secondary popularity signal). */
  tradeCount: number;
}

interface AlpacaMostActivesResponse {
  most_actives?: { symbol: string; volume: number; trade_count: number }[];
  message?: string;
}

/**
 * Fetch the top-`top` most-active US symbols by share volume. Returns [] when
 * Alpaca creds aren't configured (so the job degrades to demand-only). Throws on
 * an HTTP/shape error so the job can log and tolerate it.
 */
export async function fetchMostActives(top = 100): Promise<MostActive[]> {
  const creds = readAlpacaCreds();
  if (!creds) return [];

  const url = new URL(SCREENER_URL);
  url.searchParams.set("by", "volume");
  url.searchParams.set("top", String(top));

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "APCA-API-KEY-ID": creds.keyId,
      "APCA-API-SECRET-KEY": creds.secretKey,
    },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Alpaca most-actives screener returned ${res.status}`);
  }
  const json = (await res.json()) as AlpacaMostActivesResponse;
  const list = json.most_actives ?? [];
  return list
    .map((a) => ({ symbol: a.symbol, volume: Number(a.volume), tradeCount: Number(a.trade_count) }))
    .filter((a) => a.symbol && Number.isFinite(a.volume));
}
