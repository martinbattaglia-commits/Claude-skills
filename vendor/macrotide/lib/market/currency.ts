// Native-currency inference for a holding's NAV.
//
// `nav_history` / `fund_quotes` store whatever currency the upstream provider
// returned — there is no currency column (see lib/db/schema/market.ts). Thai
// mutual funds report NAV in THB; Yahoo-style symbols (^GSPC, US ETFs, ^N225)
// report in their listing currency. To sum a mixed-currency book into one base
// currency we first need each holding's native currency, derived from its
// routing key (`quoteSource` + `ticker`).
//
// Pure + client-safe: no DB, no network. The actual FX rates come from the
// keyless Frankfurter chain (see lib/market/fx.ts).

/** The portfolio's reporting/base currency. Everything converts into this. */
export const BASE_CURRENCY = "THB";

// Yahoo-style suffix → listing currency. Yahoo appends an exchange suffix to
// non-US symbols (".BK" Bangkok, ".T" Tokyo, ".HK" Hong Kong, …); bare symbols
// and US carets (^GSPC, ^NDX) are USD. Indices carry the same currency as the
// exchange they price.
const SUFFIX_CURRENCY: Record<string, string> = {
  BK: "THB", // Stock Exchange of Thailand (^SET.BK, PTT.BK)
  T: "JPY", // Tokyo
  HK: "HKD", // Hong Kong
  L: "GBP", // London
  DE: "EUR", // Xetra
  PA: "EUR", // Paris
  AS: "EUR", // Amsterdam
  MI: "EUR", // Milan
  SW: "CHF", // Swiss
  TO: "CAD", // Toronto
  AX: "AUD", // Australia
  SI: "SGD", // Singapore
  KS: "KRW", // Korea
  SS: "CNY", // Shanghai
  SZ: "CNY", // Shenzhen
  TW: "TWD", // Taiwan
};

// Specific Yahoo index symbols whose currency the suffix rule misses (they have
// no ".XX" exchange suffix). Indices that ARE USD (^GSPC, ^NDX, ^IXIC, ^DJI)
// fall through to the USD default, so only non-USD carets need listing here.
const SYMBOL_CURRENCY: Record<string, string> = {
  "^N225": "JPY", // Nikkei 225
  "^HSI": "HKD", // Hang Seng
  "^FTSE": "GBP", // FTSE 100
  "^GDAXI": "EUR", // DAX
  "^FCHI": "EUR", // CAC 40
  "^STOXX50E": "EUR", // Euro Stoxx 50
  "^KS11": "KRW", // KOSPI
  "^STI": "SGD", // Straits Times
};

/**
 * Infer the native currency a holding's NAV is denominated in, from its
 * `quoteSource` + `ticker`. Thai mutual funds are always THB. Cash carries its
 * currency explicitly (the holding's `currency` column, since the ticker is the
 * account name, not a symbol) — passed as `storedCurrency`. Yahoo symbols use the
 * exchange suffix (or a known-index override); everything else — bare US tickers,
 * US-index carets — defaults to USD, which is how those quotes arrive.
 *
 * This is a best-effort heuristic, not authoritative metadata. It exists so the
 * value series can FX-convert instead of summing raw mixed-currency NAVs; an
 * unknown symbol degrades to USD (the dominant foreign case) rather than
 * silently treating a USD ETF as THB.
 */
export function inferHoldingCurrency(
  quoteSource: string,
  ticker: string,
  storedCurrency?: string | null,
): string {
  // Cash holds real bank balances in a known currency (the row's `currency`),
  // defaulting to the base currency when unset.
  if (quoteSource === "cash") {
    const c = (storedCurrency ?? "").trim().toUpperCase();
    return c || BASE_CURRENCY;
  }
  // Thai funds and manually-priced custom assets are entered in THB (the app's
  // base currency) — no FX is applied to their price.
  if (quoteSource === "thai_mutual_fund" || quoteSource === "manual") return "THB";

  const t = ticker.trim().toUpperCase();
  if (SYMBOL_CURRENCY[t]) return SYMBOL_CURRENCY[t];

  // Yahoo exchange suffix: the segment after the LAST dot (PTT.BK → BK,
  // ^SET.BK → BK). Carets without a suffix fall through to the default.
  const dot = t.lastIndexOf(".");
  if (dot > 0) {
    const suffix = t.slice(dot + 1);
    if (SUFFIX_CURRENCY[suffix]) return SUFFIX_CURRENCY[suffix];
  }

  // Bare US tickers (SPY, VOO), US carets (^GSPC, ^NDX), and gold (GC=F) all
  // quote in USD.
  return "USD";
}
