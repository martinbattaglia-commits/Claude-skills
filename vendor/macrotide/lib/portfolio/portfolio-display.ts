// Display transform for a fund's full portfolio (fund_portfolio rows).
//
// The SEC /outstanding/portfolio feed itemizes every line as its own row, with
// no de-duplication. Two failure modes drown the real holdings:
//   1. A currency-hedged feeder fund (e.g. K-US500X) holds one master ETF plus a
//      ladder of dozens of FX-forward contracts — each an anonymous row (no
//      issuer, no ISIN).
//   2. A money-market / bond fund (e.g. TCMF-M) holds the same security split
//      across dozens of tranches — 47 promissory notes from one issuer, each a
//      separate NAMED row with identical issuer + description.
// Both render as a wall of near-identical lines. We collapse rows that share an
// identity (ISIN if present, else issuer + description) into one net row,
// summing %NAV, and keep single-member identities as individual lines (a
// feeder's single master ETF must stay one normal row).
//
// Each row leads with the security's OWN name (ticker when listed, else issuer),
// and `buildPortfolioGroups` buckets rows by SEC asset category — so the generic
// category ("หน่วยลงทุน…") is a subheader shown once, not repeated as every row's
// label.
//
// Pure + framework-free so it can be unit-tested without React.

import type { FundPortfolioRow } from "@/lib/db/queries/fund-enrichment";

export interface PortfolioDisplayRow {
  /** Stable React key. */
  key: string;
  /** Primary label — the security's own identity (ticker / issuer), NOT its
   * category. The category is the group header (see PortfolioGroup). */
  label: string;
  /** Secondary line (issuer). Null when it would just repeat the label. */
  issuer: string | null;
  isin: string | null;
  percentNav: number | null;
  /** SEC asset category (assetliab_desc) — used to bucket rows under a header. */
  category: string;
  /** The holding's US ticker (resolved from its ISIN), when it's a single US-listed
   *  security the app can open — makes the row a drill-in. Null for collapsed
   *  groups, UCITS masters, deposits, and FX forwards. */
  resolvedSymbol: string | null;
  /** Underlying rows when this is a collapsed group (>1 member); else undefined. */
  members?: FundPortfolioRow[];
}

/** Holdings sharing one SEC asset category (assetliab_desc), with a summed weight. */
export interface PortfolioGroup {
  category: string;
  totalPct: number;
  rows: PortfolioDisplayRow[];
}

/** A row identifies a specific security when it carries an issuer or an ISIN. */
function hasIdentity(row: FundPortfolioRow): boolean {
  return Boolean(row.issuer?.trim() || row.isinCode?.trim());
}

/** SEC asset category (the group header), e.g. "หน่วยลงทุน", "เงินฝากธนาคาร". */
function categoryOf(row: FundPortfolioRow): string {
  return row.assetliabDesc?.trim() || "อื่นๆ";
}

/**
 * The security's own name, leading with the most specific identifier — NOT the
 * generic category (that's the group header). A listed security (has an ISIN)
 * reads best as its ticker ("EWT US"); otherwise the issuer names it (a bank
 * deposit reads as its bank); an anonymous derivative falls back to its code.
 */
function securityLabel(row: FundPortfolioRow): string {
  const ticker = row.issueCode?.trim();
  const issuer = row.issuer?.trim();
  if (row.isinCode?.trim() && ticker) return ticker;
  return issuer || ticker || row.assetliabDesc?.trim() || "—";
}

/**
 * Identity key used to collapse duplicate line-items. Prefer ISIN (a globally
 * unique security id); otherwise fall back to issuer + instrument description so
 * the dozens of "PN Term" notes from a single issuer fold into one row. Anonymous
 * rows (no issuer/ISIN — FX forwards) group by their description alone.
 */
function identityKey(row: FundPortfolioRow): string {
  const isin = row.isinCode?.trim();
  if (isin) return `isin:${isin}`;
  if (hasIdentity(row)) {
    const issuer = row.issuer?.trim() ?? "";
    const desc = row.assetliabDesc?.trim() ?? "";
    return `id:${issuer}|${desc}`;
  }
  return `anon:${row.assetliabDesc ?? row.assetliabId ?? "อื่นๆ"}`;
}

/** Base name for a collapsed group's net row — the shared issuer/ISIN that
 * identifies the security, or empty for an anonymous bucket (FX forwards). */
function collapsedBase(first: FundPortfolioRow): string {
  return first.issuer?.trim() || first.isinCode?.trim() || "";
}

/**
 * Build display rows from raw portfolio rows: every row is grouped by an identity
 * key (ISIN, else issuer + description, else description for anonymous rows).
 * Single-member identities pass through as individual lines; any identity with
 * more than one member collapses into one net row (label "<desc> (net · N)")
 * summing %NAV, with its members attached for inline expansion. Sorted by weight
 * descending so the real holdings lead and net hedges sink.
 */
export function buildPortfolioDisplayRows(rows: FundPortfolioRow[]): PortfolioDisplayRow[] {
  const groups = new Map<string, FundPortfolioRow[]>();
  // Preserve first-seen order of keys so deterministic ties keep input order.
  for (const row of rows) {
    const key = identityKey(row);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const display: PortfolioDisplayRow[] = [];
  for (const [key, members] of groups) {
    const first = members[0];
    const multi = members.length > 1;
    const named = hasIdentity(first);
    const issuer = first.issuer?.trim() || null;
    if (!multi) {
      // Single line — leads with the security's own name (ticker/issuer); the
      // issuer is dropped from the secondary line when it already IS the name.
      const label = securityLabel(first);
      display.push({
        key: named ? `n-${first.id}` : `g-${key}`,
        label,
        issuer: issuer && issuer !== label ? issuer : null,
        isin: first.isinCode?.trim() || null,
        percentNav: first.percentNav ?? null,
        category: categoryOf(first),
        resolvedSymbol: first.resolvedSymbol ?? null,
      });
      continue;
    }
    // Collapsed net row across the group's members. Its base names the shared
    // security (issuer/ISIN); the category lives in the group header, so the
    // label doesn't repeat it. Anonymous buckets read as plain "Net · N".
    const sum = members.reduce((acc, m) => acc + (m.percentNav ?? 0), 0);
    const base = collapsedBase(first);
    display.push({
      key: `g-${key}`,
      label: base ? `${base} (net · ${members.length})` : `Net · ${members.length}`,
      issuer: null, // the base already carries the issuer; no secondary line
      isin: named ? first.isinCode?.trim() || null : null,
      percentNav: sum,
      category: categoryOf(first),
      // A collapsed group is a ladder of tranches/hedges, not one openable
      // security — never a drill-in even if a member happens to resolve.
      resolvedSymbol: null,
      members,
    });
  }

  return display.sort(
    (a, b) =>
      (b.percentNav ?? Number.NEGATIVE_INFINITY) - (a.percentNav ?? Number.NEGATIVE_INFINITY),
  );
}

/**
 * Bucket display rows by SEC asset category for a grouped table: one subheader
 * per category (with its summed weight), holdings nested under it. Categories
 * are ordered by total weight (the fund's main exposure leads); within a
 * category rows keep their weight-descending order. Surfaces the category once
 * per group instead of repeating it on every row.
 */
export function buildPortfolioGroups(rows: FundPortfolioRow[]): PortfolioGroup[] {
  const byCategory = new Map<string, PortfolioDisplayRow[]>();
  for (const row of buildPortfolioDisplayRows(rows)) {
    const bucket = byCategory.get(row.category);
    if (bucket) bucket.push(row);
    else byCategory.set(row.category, [row]);
  }
  return [...byCategory.entries()]
    .map(([category, groupRows]) => ({
      category,
      rows: groupRows,
      totalPct: groupRows.reduce((sum, r) => sum + (r.percentNav ?? 0), 0),
    }))
    .sort((a, b) => b.totalPct - a.totalPct);
}
