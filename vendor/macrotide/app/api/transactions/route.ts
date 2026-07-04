import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withDb } from "@/lib/api/with-db";
import { listBuckets } from "@/lib/db/queries/buckets";
import { listEarmarks } from "@/lib/db/queries/earmarks";
import { canonicalTickerMap, catalogQuoteSource } from "@/lib/db/queries/funds";
import { foldableEvents } from "@/lib/db/queries/resolve-derived-units";
import {
  insertTransactions,
  listTransactionsByBucket,
  listTransactionsForBuckets,
  type Transaction,
  type TransactionInsert,
} from "@/lib/db/queries/transactions";
import { tickerKey } from "@/lib/market/sources";
import { nativeInputsSchema } from "@/lib/portfolio/native-inputs";
import {
  type CashNudge,
  cashBalancesAsOf,
  foldSettlementCash,
} from "@/lib/portfolio/settlement-cash";
import { toLedgerTxn } from "@/lib/portfolio/transaction-analytics";
import {
  isAnchorKind,
  isCashAnchorKind,
  LEDGER_KINDS,
  promoteAnchorKinds,
  signedAmount,
} from "@/lib/portfolio/txn-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One submitted transaction. `amount` is a POSITIVE magnitude — the server
// applies the sign from `kind` (see signedAmount), so a client can never send a
// sign that disagrees with the kind. This is a reject-gate, not a coercer: a
// row that violates the schema (bad kind, missing/negative amount on a cash
// event) is rejected, never silently fixed.
const txnInput = z
  .object({
    // Anchored: a full datetime ("…T00:00:00+07:00") must be rejected, not
    // prefix-matched — a stored datetime breaks every date-only fold downstream.
    tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "tradeDate must be ISO (YYYY-MM-DD)"),
    // The unified ledger accepts trade deltas AND position anchors
    // (opening = Starting balance, snapshot = Restatement) — see ADR 0004.
    kind: z.enum(LEDGER_KINDS),
    ticker: z.string().trim().min(1).max(64),
    englishName: z.string().trim().max(200).optional(),
    units: z.number().finite().nonnegative().nullish(),
    pricePerUnit: z.number().finite().nonnegative().nullish(),
    // The asset's current/market price per unit (a Balance's "current price").
    // Trades derive their own from the execution price, so this is optional.
    marketPrice: z.number().finite().nonnegative().nullish(),
    // A Balance's stated current ฿ VALUE, when the source shows value not units
    // (the Thai-app case). Units are DERIVED from value ÷ NAV(tradeDate) here —
    // never required as input (#130). Ignored once `units` is given.
    value: z.number().finite().nonnegative().nullish(),
    // "No money moved" override on a Set balance (cash_balance) — see settlement-cash.ts.
    reconcile: z.boolean().nullish(),
    amount: z.number().finite().nonnegative(),
    fee: z.number().finite().nonnegative().nullish(),
    quoteSource: z.string().trim().min(1).max(40).default("market"),
    tradeCurrency: z.string().trim().min(1).max(8).default("THB"),
    fxToThb: z.number().finite().positive().default(1),
    // Raw native figures the user typed (non-THB rows), kept verbatim as
    // provenance. The THB money columns above stay authoritative; these are
    // never derived from or folded — display/audit only.
    nativeInputs: nativeInputsSchema.nullish(),
    note: z.string().trim().max(500).optional(),
    source: z.string().trim().max(120).optional(),
  })
  // A cash-moving trade must carry the money fact: a positive ฿ `amount`, OR a unit
  // count (a units-only trade — its amount derives from units × NAV(date) at the fold,
  // the symmetric twin of an amount-only trade deriving units). Splits and the
  // position anchors (opening/snapshot) carry no cash, so their amount is zero.
  .refine(
    (r) =>
      r.kind === "split" ||
      isAnchorKind(r.kind) ||
      r.amount > 0 ||
      (r.units != null && r.units > 0),
    { message: "a trade needs a ฿ amount or a unit count", path: ["amount"] },
  );

const postBody = z.object({
  bucketId: z.string().trim().min(1),
  transactions: z.array(txnInput).min(1).max(2000),
});

export async function GET(req: Request) {
  const bucket = new URL(req.url).searchParams.get("bucket") ?? undefined;
  return withDb(() => {
    const owned = listBuckets();
    if (bucket) {
      if (!owned.some((b) => b.id === bucket)) return NextResponse.json([]);
      return NextResponse.json(listTransactionsByBucket(bucket));
    }
    return NextResponse.json(listTransactionsForBuckets(owned.map((b) => b.id)));
  });
}

export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "Expected a JSON body." },
      { status: 400 },
    );
  }

  const parsed = postBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { bucketId, transactions } = parsed.data;

  return withDb(() => {
    // Scope through the bucket: a user can only write to a bucket they own.
    if (!listBuckets().some((b) => b.id === bucketId)) {
      return NextResponse.json({ error: "bucket_not_found" }, { status: 404 });
    }

    // Auto-promote anchors (ADR 0004): the FIRST anchor for a fund is its
    // Starting balance (opening); any LATER anchor — a quarterly re-paste of
    // current holdings — becomes a Restatement (snapshot), which re-bases units
    // WITHOUT re-counting the money as a new contribution. So a user who just
    // re-pastes their portfolio every few months gets correct invested/return.
    const alreadyAnchored = listTransactionsByBucket(bucketId)
      .filter((t) => isAnchorKind(t.kind))
      .map((t) => t.ticker);
    const kinds = promoteAnchorKinds(alreadyAnchored, transactions);
    const tickers = transactions.map((t) => t.ticker);
    const catalogSources = catalogQuoteSource(tickers);
    // Store the OFFICIAL catalog case (#235); a custom asset / cash name keeps the
    // typed case. Comparisons elsewhere are case-folded via tickerKey regardless.
    const canon = canonicalTickerMap(tickers);

    // FACTS-ONLY LEDGER (ADR 0004). The route does NO derivation — it stores only the
    // money facts the user gave: a read `units`, a Balance's ฿ `value`, or a trade's ฿
    // `amount`. The missing unit count (a value-only Balance, or an amount-only trade)
    // is derived from value/amount ÷ NAV(tradeDate) at the projection fold
    // (lib/db/queries/resolve-derived-units.ts), so it self-corrects when that date's
    // NAV lands or is corrected — no estimate is ever frozen here.
    const importBatchId = randomUUID();
    const rows: TransactionInsert[] = transactions.map((t, i) => {
      const kind = kinds[i];
      const anchor = isAnchorKind(kind);
      const ticker = canon.get(tickerKey(t.ticker)) ?? t.ticker.trim();
      const catalogSource = catalogSources.get(tickerKey(ticker));
      const quoteSource = catalogSource === "thai_mutual_fund" ? catalogSource : t.quoteSource;
      return {
        bucketId,
        ticker,
        englishName: t.englishName ?? null,
        quoteSource,
        kind,
        tradeDate: t.tradeDate,
        // A read unit count is a fact; a value-only Balance / amount-only trade leaves
        // it NULL for the fold to derive.
        units: t.units ?? null,
        // The stated current value — the fact for a value-only Balance; NULL otherwise.
        value: anchor ? (t.value ?? null) : null,
        // "No money moved" override — only on a Set balance (cash_balance).
        reconcile: isCashAnchorKind(kind) ? (t.reconcile ?? false) : null,
        pricePerUnit: t.pricePerUnit ?? null,
        // A Balance's user-entered current price; a trade's execution price (if given)
        // doubles as its market point. Never a value derived from units here.
        marketPrice: t.marketPrice ?? (anchor ? null : (t.pricePerUnit ?? null)),
        // Authoritative sign applied here from the (possibly promoted) kind.
        amount: signedAmount(kind, t.amount),
        fee: t.fee ?? null,
        tradeCurrency: t.tradeCurrency,
        fxToThb: t.fxToThb,
        // The verbatim native figures — kept only for a non-THB row (a THB row's
        // stored columns already ARE the native fact).
        nativeInputs: t.tradeCurrency === "THB" ? null : (t.nativeInputs ?? null),
        note: t.note ?? null,
        source: t.source ?? null,
        importBatchId,
      };
    });

    const inserted = insertTransactions(rows);
    const cashNudges = fundedFromCashNudges(bucketId, inserted);
    return NextResponse.json(
      {
        inserted,
        importBatchId,
        count: inserted.length,
        ...(cashNudges.length > 0 ? { cashNudges } : {}),
      },
      { status: 201 },
    );
  });
}

// Below this the money is in satang noise, not a real shortfall.
const NUDGE_EPSILON = 0.005;
const NUDGE_CAP = 3;

/**
 * The funded-from-cash nudge (#232). For each just-inserted buy, the part of its cost
 * the in-transit settlement heuristic did NOT already net (a reinvested switch never
 * fires) — paired with the tracked cash accounts that could have covered it at the buy
 * date. Convenience, not correctness: the client offers a one-tap matching withdraw;
 * ignoring it still reconciles at the next Set balance. Reserved accounts are set
 * aside (#149) and not offered; a non-THB account IS offered — the withdraw records in
 * native units at the buy-date FX rate. Each candidate carries its currency.
 */
function fundedFromCashNudges(bucketId: string, inserted: Transaction[]): CashNudge[] {
  const buys = inserted.filter((t) => t.kind === "buy");
  if (buys.length === 0) return [];

  // The bucket ledger including this batch, folded the same way analytics folds it
  // (derived units resolved), so the shortfall matches what the chart will show.
  const all = listTransactionsByBucket(bucketId);
  const ledger = foldableEvents(all).map(toLedgerTxn);
  const today = new Date().toISOString().slice(0, 10);
  const { buyShortfallById } = foldSettlementCash(ledger, today);

  const reserved = new Set(
    listEarmarks()
      .filter((e) => e.bucketId === bucketId && e.role === "reserved" && e.ticker)
      .map((e) => tickerKey(e.ticker as string)),
  );
  // A cash account's native currency (its rows all share one tradeCurrency); a non-THB
  // account is offered now that the withdraw records in native units at the buy-date
  // FX rate, not by storing THB as its units.
  const currencyByKey = new Map<string, string>();
  const candidates = new Map<string, string>(); // tickerKey → display ticker
  for (const r of all) {
    if (r.quoteSource !== "cash") continue;
    const key = tickerKey(r.ticker);
    currencyByKey.set(key, (r.tradeCurrency ?? "THB").toUpperCase() || "THB");
    if (reserved.has(key) || candidates.has(key)) continue;
    candidates.set(key, r.ticker);
  }
  if (candidates.size === 0) return [];

  const nudges: CashNudge[] = [];
  for (const buy of buys) {
    const shortfall = buyShortfallById.get(buy.id) ?? 0;
    if (shortfall <= NUDGE_EPSILON) continue;
    // Case-fold the per-account balances at the buy date onto the candidate keys.
    const balanceByKey = new Map<string, number>();
    for (const [ticker, balance] of cashBalancesAsOf(ledger, buy.tradeDate)) {
      const key = tickerKey(ticker);
      balanceByKey.set(key, (balanceByKey.get(key) ?? 0) + balance);
    }
    const accounts = [...candidates]
      .map(([key, ticker]) => ({
        ticker,
        balance: balanceByKey.get(key) ?? 0,
        currency: currencyByKey.get(key) ?? "THB",
      }))
      .filter((a) => a.balance >= shortfall - NUDGE_EPSILON)
      .sort((a, b) => b.balance - a.balance)
      .slice(0, NUDGE_CAP);
    if (accounts.length === 0) continue;
    nudges.push({ buyTicker: buy.ticker, tradeDate: buy.tradeDate, shortfall, accounts });
    if (nudges.length >= NUDGE_CAP) break;
  }
  return nudges;
}
