"use client";

// EventLine — one ledger event rendered in the app's native holdings-row
// grammar (`.holding` / `.swatch` / `.name` / `.sub` / `.value` / `.pct .delta`),
// so a list of events reads as one list with the Holdings below it: a kind-tinted
// swatch, "Bought EXAMPLE-FUND-A" as the name, a muted detail sub-line, the
// amount right-aligned, and (on a sell) the realized gain as the colored delta.

import { PrivateAmount } from "@/components/PrivateAmount";
import type { Transaction } from "@/lib/db/queries/transactions";
import { fmtDate, fmtTHBClean } from "@/lib/format";
import type { TxnKind } from "@/lib/portfolio/lots";

const VERB: Record<TxnKind, string> = {
  buy: "Bought",
  sell: "Sold",
  dividend: "Dividend",
  fee: "Fee",
  split: "Split",
  reinvest: "Reinvested",
  // Both anchors are one user-facing concept, "Balance".
  opening: "Balance",
  snapshot: "Balance",
  deposit: "Deposited",
  withdraw: "Withdrew",
  cash_balance: "Balance",
};

// Short swatch tag (mirrors the holdings swatch's 3-char abbreviation).
const ABBR: Record<TxnKind, string> = {
  buy: "BUY",
  sell: "SELL",
  dividend: "DIV",
  fee: "FEE",
  split: "SPL",
  reinvest: "RE",
  opening: "BAL",
  snapshot: "BAL",
  deposit: "DEP",
  withdraw: "WD",
  cash_balance: "CASH",
};

// Swatch colour by kind (same token palette the rest of the app uses). One hue
// per meaning so the swatches stay easy to tell apart: green = value in
// (buy/deposit), red = value out (sell/withdraw), periwinkle = income
// (dividend/reinvest), blue = a cash balance, amber = an asset balance anchor,
// grey = a neutral no-cash event (fee/split). Income and cash avoid the
// green-adjacent teal so they don't read as a green buy.
const TONE: Record<TxnKind, string> = {
  buy: "var(--accent)",
  sell: "var(--loss)",
  dividend: "var(--benchmark)",
  reinvest: "var(--benchmark)",
  fee: "var(--muted-2)",
  split: "var(--muted-2)",
  opening: "var(--amber)",
  snapshot: "var(--amber)",
  deposit: "var(--accent)",
  withdraw: "var(--loss)",
  cash_balance: "var(--info)",
};

function isAnchor(k: TxnKind): boolean {
  return k === "opening" || k === "snapshot";
}

const units = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 4 });
const price = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 4 });

export interface EventLineProps {
  txn: Transaction;
  /** Realized gain for a sell (THB), keyed by the caller from analytics. */
  realized?: number;
  onOpen: () => void;
  /** Hide the ticker in the title (on a position page the fund is implicit). */
  hideTicker?: boolean;
  /** Drop the leading verb for anchors — the amber "BAL" swatch already says
   * what these rows are, so the title shows just the fund (no "Balance ·" on
   * every anchor line). */
  hideVerb?: boolean;
}

// The native holdings-row reset for a <button> acting as a grid row.
const ROW_STYLE: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "32px 1fr auto",
  alignItems: "center",
  gap: 10,
  width: "100%",
  textAlign: "left",
  background: "none",
  border: "none",
  font: "inherit",
  color: "inherit",
  cursor: "pointer",
};

export function EventLine({
  txn,
  realized,
  onOpen,
  hideTicker = false,
  hideVerb = false,
}: EventLineProps) {
  const kind = txn.kind as TxnKind;
  const anchor = isAnchor(kind);
  const verb = VERB[kind] ?? txn.kind;
  // With hideVerb the swatch already names the row, so the verb is redundant —
  // show just the fund (or, when the fund is implicit too, fall back to the verb).
  // Cash accounts carry their display NAME in englishName (the ticker is the
  // upper-cased ledger identity); funds show their ticker symbol as-is.
  const label = txn.quoteSource === "cash" ? (txn.englishName ?? txn.ticker) : txn.ticker;
  const name =
    anchor && hideVerb
      ? hideTicker
        ? verb
        : label
      : hideTicker
        ? verb
        : `${verb}${anchor ? " · " : " "}${label}`;

  const sub: string[] = [fmtDate(txn.tradeDate)];
  if (anchor) {
    if (txn.units != null) sub.push(`${units(txn.units)} units`);
  } else if (kind === "dividend") {
    sub.push("paid in cash");
  } else if (kind === "fee") {
    sub.push("fee");
  } else if (txn.units != null && txn.pricePerUnit != null) {
    sub.push(`${units(txn.units)} @ ฿${price(txn.pricePerUnit)}`);
  }
  // A reconciled Set balance moved no money — say so on the saved row, so a
  // classification that shapes contributed capital stays auditable after save (#232).
  if (kind === "cash_balance" && txn.reconcile) sub.push("no money moved");
  if (txn.source) sub.push(txn.source);

  const costUnknown = anchor && txn.pricePerUnit == null;
  // A value-stated anchor (a `cash_balance`, or a value-only fund Balance) holds
  // its ฿ magnitude in `value` with `amount` 0 (no cash moved) — show the asserted
  // balance, not the zero flow. Every other kind shows its signed cash amount.
  const magnitude = txn.value ?? Math.abs(txn.amount);
  const amount = kind === "split" ? "" : `${kind === "fee" ? "−" : ""}${fmtTHBClean(magnitude)}`;

  return (
    <button type="button" className="holding" style={ROW_STYLE} onClick={onOpen}>
      <div className="swatch" style={{ background: TONE[kind] }}>
        {ABBR[kind]}
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="name">{name}</div>
        <div className="sub">
          {sub.join(" · ")}
          {costUnknown && <span style={{ color: "var(--amber)" }}> · cost not recorded</span>}
        </div>
      </div>
      <div className="stack-xs" style={{ alignItems: "flex-end" }}>
        {amount && (
          <div className="value">
            <PrivateAmount>{amount}</PrivateAmount>
          </div>
        )}
        {kind === "sell" && realized != null && (
          <div className={`pct delta ${realized >= 0 ? "up" : "down"}`}>
            {realized >= 0 ? "+" : "−"}
            <PrivateAmount>{fmtTHBClean(Math.abs(realized))}</PrivateAmount>
          </div>
        )}
      </div>
    </button>
  );
}
