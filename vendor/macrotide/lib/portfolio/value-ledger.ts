// Value-based ledger: derive a row's UNIT count from the money facts a broker app
// actually shows — its ฿ value/amount — when the unit count itself isn't printed.
// Pure, deterministic, DB- and network-free: the caller looks up NAV(date) and
// hands it in, so this stays trivially testable (see value-ledger.test.ts) and the
// engine in lots.ts keeps consuming already-resolved units (ADR 0004 unchanged).
//
// THE RULE (issue #130): units is a fact fixed to a row's OWN date. When it isn't
// read directly, derive it from the value on that date ÷ the price on that date —
// always the row's own date's NAV, never today's moving NAV (pairing a dated value
// with today's NAV makes the unit count drift).
//
// THE TRAP (do not regress): a Balance's `value` is its CURRENT market value; its
// `avgCost` is what was PAID. They use DIFFERENT prices. Units come from the
// current price — units = value ÷ NAV(date) — NEVER value ÷ avgCost. avgCost only
// ever feeds the cost basis (cost = units × avgCost). So the divisor passed here as
// `price`/`navOnDate` must be a CURRENT/market price, never the average cost. This
// helper has no way to tell them apart — keeping avgCost out is the caller's job.

/** What a statement row gave us, plus the NAV the caller resolved for its date. */
export interface DeriveUnitsInput {
  /** Units read straight off the statement (preferred when present). */
  units: number | null;
  /** The ฿ money fact: a Balance's current value, or a trade's gross ฿ (fee-netted). */
  total: number | null;
  /** A CURRENT/market per-unit price read off the row (a trade's price, a Balance's
   *  current price). NEVER the average cost. Null when none was printed. */
  price: number | null;
  /** NAV on the row's OWN date (nav_history, looked up by the caller). Null when
   *  the date has no NAV on file yet. Never today's moving NAV for a past date. */
  navOnDate: number | null;
}

/** Which money fact the unit count came from — drives the "needs units" flag. */
export type DeriveBasis = "units" | "price" | "nav" | "none";

export interface DeriveUnitsResult {
  /** Resolved units, or null when nothing could price the row (flag needs-units). */
  units: number | null;
  /** How `units` was obtained — `none` means unresolved (no units, price, or NAV). */
  basis: DeriveBasis;
}

const POS = (n: number | null | undefined): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * Resolve a row's unit count from the money facts, following the #130 case table:
 *
 *   | read                         | units come from           | basis   |
 *   | units (+ maybe total)        | units as-is               | "units" |
 *   | total only + price           | total ÷ price             | "price" |
 *   | total only, no price, w/ NAV | total ÷ NAV(date)         | "nav"   |  ← core case
 *   | total only, no price, no NAV | unresolved                | "none"  |
 *   | nothing usable               | unresolved                | "none"  |
 *
 * Prefer units when present (the statement's amount stays authoritative elsewhere —
 * callers must NOT recompute the ฿ amount from units × price, to keep fees/rounding
 * exact). Total is the fallback, divided by the most specific CURRENT price we have:
 * the row's own price first, then NAV(date). The avgCost the caller paid is never a
 * divisor here (see THE TRAP above).
 */
export function deriveUnits(input: DeriveUnitsInput): DeriveUnitsResult {
  const { units, total, price, navOnDate } = input;
  if (POS(units)) return { units, basis: "units" };
  if (POS(total)) {
    if (POS(price)) return { units: total / price, basis: "price" };
    if (POS(navOnDate)) return { units: total / navOnDate, basis: "nav" };
  }
  return { units: null, basis: "none" };
}
