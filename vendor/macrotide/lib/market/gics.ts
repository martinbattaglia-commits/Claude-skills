// GICS sector / sub-industry for US stocks, from the public-domain datahub
// "S&P 500 companies" dataset (ODC-PDDL, refreshed daily on GitHub). SEC gives a
// coarse SIC industry; this adds the richer GICS sector users expect — but only
// for S&P 500 members (the only free symbol→GICS list), so non-members keep their
// SIC industry. Keyless, redistributable.

import "server-only";

const GICS_CSV_URL =
  "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv";

export interface GicsRow {
  symbol: string;
  gicsSector: string;
  gicsSubIndustry: string;
}

// Minimal RFC-4180 line splitter: handles double-quoted fields containing commas
// (e.g. "San Jose, California") and escaped quotes, so the GICS columns parse even
// when a later column has commas.
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else if (ch === '"') {
      quoted = true;
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Parse the constituents CSV into {symbol, gicsSector, gicsSubIndustry} rows. Pure. */
export function parseGicsCsv(text: string): GicsRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const si = header.indexOf("Symbol");
  const seci = header.indexOf("GICS Sector");
  const subi = header.indexOf("GICS Sub-Industry");
  if (si < 0 || seci < 0) return [];
  const rows: GicsRow[] = [];
  for (const line of lines.slice(1)) {
    const c = splitCsvLine(line);
    const symbol = (c[si] ?? "").trim().toUpperCase();
    const gicsSector = (c[seci] ?? "").trim();
    if (!symbol || !gicsSector) continue;
    rows.push({ symbol, gicsSector, gicsSubIndustry: subi >= 0 ? (c[subi] ?? "").trim() : "" });
  }
  return rows;
}

/** Fetch + parse the S&P 500 GICS constituents (empty array on any failure). */
export async function fetchGicsConstituents(fetchImpl: typeof fetch = fetch): Promise<GicsRow[]> {
  try {
    const res = await fetchImpl(GICS_CSV_URL, {
      headers: { Accept: "text/csv" },
      cache: "no-store",
    });
    if (!res.ok) return [];
    return parseGicsCsv(await res.text());
  } catch {
    return [];
  }
}
