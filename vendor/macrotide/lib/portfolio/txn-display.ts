// Shared display vocabulary for the ledger event kinds — one source of truth so
// every editor (the Add sheet, the inline History editor) shows the same labels
// and the same plain-English explanation. The collapsed-row PAST tense
// ("Bought", "Sold") lives with EventLine; this is the editor's imperative label
// plus a one-liner that tells the user what each kind does.
//
// The two anchor kinds (opening / snapshot) are ONE user-facing concept,
// "Balance": the first you record per fund is your starting balance; a later one
// re-states the position. Which one it is, is decided behind the scenes (see
// promoteAnchorKinds), so the user only ever picks "Balance".

import type { TxnKind } from "@/lib/portfolio/lots";
import { CASH_KINDS, TXN_KINDS } from "@/lib/portfolio/txn-import";

const isAnchor = (k: TxnKind): boolean => k === "opening" || k === "snapshot";

/** Imperative label for the Type <select>. Both fund anchors read as "Balance". */
export const TXN_KIND_LABEL: Record<TxnKind, string> = {
  opening: "Balance",
  snapshot: "Balance",
  buy: "Buy",
  sell: "Sell",
  dividend: "Dividend",
  reinvest: "Reinvest",
  fee: "Fee",
  split: "Split",
  deposit: "Deposit",
  withdraw: "Withdraw",
  // Parallels the investment "Balance" — sets the account's current total; the
  // sibling Deposit/Withdraw options make "total vs add/remove" unambiguous.
  cash_balance: "Balance",
};

// The one explanation shared by both anchor kinds. Calls out that avg cost is
// what you PAID (today's value comes from the live price), and that a rise in
// units × avg cost is read as money you added.
const BALANCE_HELP =
  "Units you hold + the avg cost you PAID (not today's value). Re-add later to update — adding more counts as money in.";

/** One-line, plain-English explanation shown under the Type picker so the user
 *  never has to guess what a kind does. */
export const TXN_KIND_HELP: Record<TxnKind, string> = {
  opening: BALANCE_HELP,
  snapshot: BALANCE_HELP,
  buy: "Bought units — adds to your position and to the amount you’ve invested.",
  sell: "Sold units — books a realized gain or loss.",
  dividend: "Cash the fund paid you — income; your unit count doesn’t change.",
  reinvest: "A dividend put back into more units instead of taken as cash.",
  fee: "A cost you paid (platform or switching) — lowers return, not your units.",
  split: "The fund split or merged units — your unit count changes, the total value doesn’t.",
  deposit: "Cash you moved into this account — funds future buys and counts as money in.",
  withdraw: "Cash you took out of this account — counts as money out.",
  cash_balance:
    "The cash in this account now — its change since last time counts as money in or out.",
};

/**
 * Options for the Type / Action <select>, scoped to the row's FAMILY (#149). A cash
 * row (deposit / withdraw / set balance) shows only the cash actions; a fund row shows
 * a SINGLE "Balance" entry (the fund anchors) then the fund trade kinds. The family is
 * chosen by the Add modal's Investment | Cash segment, not switched mid-row — so the two
 * worlds never blur (a buy can't become a deposit by accident). The Balance entry's value
 * is the row's current anchor kind (so editing a Restatement keeps it), or "opening" for a
 * fresh/non-anchor row; the route auto-promotes a repeat opening to a snapshot on save.
 */
export function typeSelectOptions(currentKind: TxnKind): { value: TxnKind; label: string }[] {
  if ((CASH_KINDS as readonly TxnKind[]).includes(currentKind)) {
    // Anchor FIRST, then the flows — parallels the investment list (Balance, Buy, Sell…).
    const order: TxnKind[] = ["cash_balance", "deposit", "withdraw"];
    return order.map((k) => ({ value: k, label: TXN_KIND_LABEL[k] }));
  }
  const balanceValue: TxnKind = isAnchor(currentKind) ? currentKind : "opening";
  return [
    { value: balanceValue, label: "Balance" },
    ...TXN_KINDS.map((k) => ({ value: k, label: TXN_KIND_LABEL[k] })),
  ];
}
