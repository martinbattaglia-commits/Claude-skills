// US ETF expense ratio (TER) from the SEC 485BPOS prospectus inline-XBRL — the one
// detail field with no clean free API, but public-domain in EDGAR. A fund files a
// 485BPOS whose iXBRL carries `oef:ExpensesOverAssets` (the total annual operating
// expense, a decimal like 0.0003 = 0.03%) per share class, keyed by a contextRef
// that embeds the EDGAR seriesId + classId.
//
// Flow: resolve ticker → cik/seriesId/classId (company_tickers_mf.json) → newest
// 485BPOS accession (submissions) → its extracted XBRL instance (the *_htm.xml in
// the filing dir) → the ExpensesOverAssets whose context matches the class.
//
// Best-effort: returns null on any miss (filename varies, older filings predate
// iXBRL). TER then stays null and the UI falls back to the broker-fee / manual
// field — never blocks the page.

import { secEdgarUserAgent } from "./user-agent";

const ARCHIVES = "https://www.sec.gov/Archives/edgar/data";
const BROWSE_EDGAR = "https://www.sec.gov/cgi-bin/browse-edgar";

const userAgent = secEdgarUserAgent;

/**
 * Parse a 485BPOS XBRL instance for a class's expense ratio. Pure. Picks the
 * `oef:ExpensesOverAssets` whose contextRef references BOTH the seriesId and
 * classId (the share class); falls back to a series-only match. Returns the
 * decimal fraction (0.0003 = 0.03%) or null. A value > 1 is treated as a percent.
 */
export function parseExpenseRatio(xml: string, seriesId: string, classId: string): number | null {
  const re = /<oef:ExpensesOverAssets\b([^>]*)>([^<]*)<\/oef:ExpensesOverAssets>/g;
  let classMatch: number | null = null;
  let seriesMatch: number | null = null;
  for (const m of xml.matchAll(re)) {
    const attrs = m[1];
    const raw = m[2].trim();
    if (!raw) continue;
    const ctx = (attrs.match(/contextRef="([^"]*)"/) || [])[1] ?? "";
    if (!ctx.includes(seriesId)) continue;
    let val = Number.parseFloat(raw.replace(/[%,\s]/g, ""));
    if (!Number.isFinite(val)) continue;
    if (val > 1) val = val / 100; // a percent slipped through → normalise to a fraction
    if (ctx.includes(classId)) {
      classMatch ??= val;
    } else {
      seriesMatch ??= val;
    }
  }
  return classMatch ?? seriesMatch;
}

async function fetchText(url: string, accept: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": userAgent(), Accept: accept },
      cache: "no-store",
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

interface FetchEtfExpenseDeps {
  resolve: (symbol: string) => Promise<{ cik: string; seriesId: string; classId: string } | null>;
}

/**
 * Fetch a US ETF's expense ratio (decimal fraction) or null. `deps.resolve` is
 * injectable for tests; defaults to the live company_tickers_mf resolution.
 */
export async function fetchEtfExpenseRatio(
  symbol: string,
  deps?: Partial<FetchEtfExpenseDeps>,
): Promise<number | null> {
  const resolve =
    deps?.resolve ??
    (async (s: string) => (await import("./providers/edgar-nport")).resolveEtfClass(s));
  const ref = await resolve(symbol);
  if (!ref) return null;

  // The newest 485BPOS for THIS series. EFTS full-text search doesn't index
  // 485BPOS seriesIds, but EDGAR's series-scoped browse feed (CIK={seriesId}) lists
  // exactly the filings covering this fund — so we pick the right one even when a
  // multi-fund registrant (Vanguard, iShares) bundles many funds per filing.
  const browseUrl = `${BROWSE_EDGAR}?action=getcompany&CIK=${ref.seriesId}&type=485BPOS&dateb=&owner=include&count=5&output=atom`;
  const atom = await fetchText(browseUrl, "application/atom+xml");
  if (!atom) return null;
  // The atom feed is newest-first; take the first accession.
  const adsh = (atom.match(/<accession-number>([^<]+)<\/accession-number>/) || [])[1];
  if (!adsh) return null;
  const acc = adsh.replace(/-/g, "");

  // Find the extracted XBRL instance(s) in the filing dir (name varies → *_htm.xml).
  const index = await fetchText(`${ARCHIVES}/${ref.cik}/${acc}/index.json`, "application/json");
  if (!index) return null;
  let names: string[];
  try {
    const items =
      (JSON.parse(index) as { directory?: { item?: { name?: string }[] } }).directory?.item ?? [];
    names = items.map((i) => i.name ?? "").filter((n) => /_htm\.xml$/i.test(n));
  } catch {
    return null;
  }

  for (const name of names) {
    const xml = await fetchText(`${ARCHIVES}/${ref.cik}/${acc}/${name}`, "*/*");
    if (!xml) continue;
    const ter = parseExpenseRatio(xml, ref.seriesId, ref.classId);
    if (ter != null) return ter;
  }
  return null;
}
