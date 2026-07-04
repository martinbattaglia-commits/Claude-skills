import "server-only";
import { quoteCacheKey } from "@/lib/market/sources";
import type { TxnKind } from "@/lib/portfolio/lots";
import { isAnchorKind, isCashKind, signedAmount, signFor } from "@/lib/portfolio/txn-import";
import { deriveUnits } from "@/lib/portfolio/value-ledger";
import { listFundQuotes, navOnDates } from "./quotes";
import type { Transaction } from "./transactions";

// Facts-only ledger (ADR 0004): the ledger stores only the money fact the user gave
// — a read `units`, a Balance's ฿ `value`, or a trade's ฿ `amount`. This pre-pass
// turns the *missing* unit count into the fold's input WITHOUT writing it back:
//   • a value-only Balance  → units = value ÷ NAV(tradeDate)
//   • an amount-only trade  → units = amount ÷ (execution price ?? NAV(tradeDate))
// It runs on EVERY fold — every holdings rebuild AND every analytics read — so the
// derived units self-correct the moment that date's NAV lands or is corrected;
// nothing derived is ever frozen in the ledger. NAV(tradeDate) is preferred, the
// latest quote a fall-back (still self-correcting); a row with no NAV anywhere is
// left unresolved (held/recorded, units pending) rather than priced off a wrong NAV.

const DERIVABLE_TRADE = new Set(["buy", "sell", "reinvest"]);

const cacheKey = (r: Transaction): string => quoteCacheKey(r.quoteSource, r.ticker);

/** A row whose unit count is missing and must be derived from a money total. */
const needsUnits = (r: Transaction): boolean => {
  if (r.units != null && r.units > 0) return false;
  return isAnchorKind(r.kind)
    ? r.value != null && r.value > 0 // a value-only Balance
    : DERIVABLE_TRADE.has(r.kind) && Math.abs(r.amount) > 0; // an amount-only trade
};

/**
 * A units-only delta trade — the symmetric twin: it carries a unit count but no cash,
 * so its ฿ amount derives from units × NAV(tradeDate) at the fold (you transact at the
 * fund's NAV). Lets a catalog-fund buy/sell be just units, with the cash filled in.
 */
const needsTradeAmount = (r: Transaction): boolean =>
  DERIVABLE_TRADE.has(r.kind) && r.units != null && r.units > 0 && Math.abs(r.amount) === 0;

const isDerivable = (r: Transaction): boolean => needsUnits(r) || needsTradeAmount(r);

/** The ฿ money fact a row's units derive from: a Balance's value, else the trade amount. */
const moneyTotal = (r: Transaction): number =>
  isAnchorKind(r.kind) ? (r.value ?? 0) : Math.abs(r.amount);

/**
 * Resolve every row whose units must be derived (value-only Balances + amount-only
 * trades) into folded inputs. Returns a new array; rows that already carry a read
 * unit count pass through untouched. Server-only — reads NAV from the shared
 * market.db. Call before mapping rows into the pure lot engine (`reduceLots`).
 */
export function resolveDerivedUnits(rows: readonly Transaction[]): Transaction[] {
  const targets = rows.filter(isDerivable);
  if (targets.length === 0) return [...rows];

  const keys = [...new Set(targets.map(cacheKey))];
  const latest = new Map<string, number>();
  for (const q of listFundQuotes(keys)) if (q.nav > 0) latest.set(q.ticker, q.nav);
  // One scan resolves every distinct trade date (was a navOnDate query per date).
  const navByDate = navOnDates(keys, [...new Set(targets.map((r) => r.tradeDate))]);

  return rows.map((r) => {
    if (!isDerivable(r)) return r;
    const key = cacheKey(r);
    // Cash has no market NAV — it is priced at 1.0 in its own currency, so a
    // value-only cash_balance derives units = value ÷ 1 = the asserted balance
    // (its money fact stays NATIVE; the FX to THB happens at valuation, not here).
    //
    // A non-cash NAV comes from the provider in the holding's NATIVE currency (USD
    // for a US ETF), but the money total we divide it into (`value`/`amount`) was
    // stored in THB — native × the trade-date `fxToThb` at entry. So convert
    // the divisor to THB with that SAME trade-date rate: units = value_THB ÷
    // (NAV_native × fxToThb) then comes out as a native share count. THB holdings
    // carry fxToThb 1, so this is a no-op for them (and for the `pricePerUnit`
    // divisor below, which is already stored in THB — no conversion needed there).
    const fx = r.fxToThb && r.fxToThb > 0 ? r.fxToThb : 1;
    const navNative = navByDate.get(r.tradeDate)?.get(key) ?? latest.get(key) ?? null;
    const nav = isCashKind(r.kind) ? 1 : navNative == null ? null : navNative * fx;

    // Units-only delta trade → derive the cash: units × (execution price ?? NAV), with
    // the fee folded in like a normal trade, then signed by kind (buy = cash out). No
    // price/NAV → leave amount 0 (the position holds units at unknown cost).
    if (needsTradeAmount(r)) {
      const price = r.pricePerUnit && r.pricePerUnit > 0 ? r.pricePerUnit : nav;
      if (price == null) return r;
      const kind = r.kind as TxnKind; // narrowed by needsTradeAmount (a delta trade)
      const gross = (r.units as number) * price;
      const f = r.fee ?? 0;
      const magnitude = signFor(kind) < 0 ? gross + f : Math.max(0, gross - f);
      return { ...r, amount: signedAmount(kind, magnitude) };
    }

    const anchor = isAnchorKind(r.kind);
    // Balance: value ÷ NAV(date), falling back to the row's own current price
    // (`marketPrice`) — that's how a CUSTOM/self-priced asset with no NAV gets valued.
    // Trade: amount ÷ (execution price ?? NAV(date)).
    const units = deriveUnits({
      units: null,
      total: moneyTotal(r),
      price: anchor ? null : (r.pricePerUnit ?? null),
      navOnDate: anchor ? (nav ?? r.marketPrice ?? null) : nav,
    }).units;
    if (units == null) return r; // no NAV anywhere → leave unresolved (units pending)
    if (!anchor) return { ...r, units }; // a trade's cost basis is its `amount`; no avg cost to set
    // A Balance's cost basis can ride in as a ฿ TOTAL (the signed `amount`, −cost) OR
    // as a per-unit fact (`pricePerUnit`). Derive whichever is missing from the other
    // — the per-unit avg cost from amount ÷ units, or the cost magnitude from
    // pricePerUnit × units — so an opening's cash always reaches XIRR and the figures
    // agree. An uncosted value anchor (no amount, no price) stays cost-unknown; a
    // restatement (snapshot) moves no cash, so its amount stays 0.
    const costBasis = Math.abs(r.amount);
    const pricePerUnit = r.pricePerUnit ?? (costBasis > 0 ? costBasis / units : null);
    const amount =
      costBasis === 0 && pricePerUnit != null && r.kind === "opening"
        ? -(units * pricePerUnit)
        : r.amount;
    return { ...r, units, pricePerUnit, amount };
  });
}

/**
 * The fold-ready event set: resolve derived units, then DROP any anchor whose units
 * still couldn't be derived (no NAV anywhere). An unresolved anchor folded as zero
 * units would WIPE the position (an anchor asserts an ABSOLUTE balance); dropping it
 * leaves the prior position intact, and it self-corrects into view the moment that
 * date's NAV lands. A delta TRADE with unknown units is kept — its cash (`amount`)
 * is still real and additive, never destructive. Call this (not raw resolve) before
 * folding into positions/analytics.
 */
export function foldableEvents(rows: readonly Transaction[]): Transaction[] {
  return resolveDerivedUnits(rows).filter((r) => !(isAnchorKind(r.kind) && r.units == null));
}
