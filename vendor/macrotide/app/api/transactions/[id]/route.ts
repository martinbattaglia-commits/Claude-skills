import { NextResponse } from "next/server";
import { z } from "zod";
import { withDb } from "@/lib/api/with-db";
import { listBuckets } from "@/lib/db/queries/buckets";
import { canonicalTicker, catalogQuoteSource } from "@/lib/db/queries/funds";
import { deleteTransaction, updateTransaction } from "@/lib/db/queries/transactions";
import { tickerKey } from "@/lib/market/sources";
import { nativeInputsSchema } from "@/lib/portfolio/native-inputs";
import {
  isAnchorKind,
  isCashAnchorKind,
  LEDGER_KINDS,
  signedAmount,
} from "@/lib/portfolio/txn-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PATCH / DELETE a single ledger event — the inline-edit path for the Activity
// view (ADR 0004). Editing or deleting an event rebuilds the bucket's derived
// holdings. Scoped through the caller's buckets (transactions have no user_id).
//
// FACTS-ONLY (mirrors POST /api/transactions): the edit stores only the money fact
// — a read `units`, a Balance's ฿ `value`, or a trade's ฿ `amount` (a positive
// magnitude the server signs by kind). The missing side (a value-only Balance, an
// amount-only or units-only trade) derives at the projection fold, never frozen here.
const patchBody = z
  .object({
    // Anchored: a full datetime ("…T00:00:00+07:00") must be rejected, not
    // prefix-matched — a stored datetime breaks every date-only fold downstream.
    tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "tradeDate must be ISO (YYYY-MM-DD)"),
    kind: z.enum(LEDGER_KINDS),
    ticker: z.string().trim().min(1).max(64),
    englishName: z.string().trim().max(200).nullish(),
    units: z.number().finite().nonnegative().nullish(),
    pricePerUnit: z.number().finite().nonnegative().nullish(),
    marketPrice: z.number().finite().nonnegative().nullish(),
    // A Balance's stated current ฿ VALUE (units derive from value ÷ NAV(date) at the fold).
    value: z.number().finite().nonnegative().nullish(),
    // "No money moved" override on a Set balance (cash_balance) — see settlement-cash.ts.
    reconcile: z.boolean().nullish(),
    amount: z.number().finite().nonnegative().default(0),
    fee: z.number().finite().nonnegative().nullish(),
    quoteSource: z.string().trim().min(1).max(40),
    // Currency + trade-date FX for a non-THB cost basis; default THB / 1 so an
    // omitted pair (a THB edit) leaves the row THB-denominated.
    tradeCurrency: z.string().trim().min(1).max(8).default("THB"),
    fxToThb: z.number().finite().positive().default(1),
    // Verbatim native figures the user typed (non-THB rows) — provenance only,
    // never folded. See POST /api/transactions.
    nativeInputs: nativeInputsSchema.nullish(),
  })
  // A trade needs the money fact: a positive ฿ amount OR a unit count (units-only
  // trades derive their amount from NAV). Anchors and splits may carry amount 0.
  .refine(
    (r) =>
      r.kind === "split" ||
      isAnchorKind(r.kind) ||
      r.amount > 0 ||
      (r.units != null && r.units > 0),
    { message: "a trade needs a ฿ amount or a unit count", path: ["amount"] },
  );

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isInteger(numId)) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = patchBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const t = parsed.data;

  return withDb(() => {
    const owned = listBuckets().map((b) => b.id);
    const anchor = isAnchorKind(t.kind);
    const pricePerUnit = t.pricePerUnit ?? null;
    const ticker = canonicalTicker(t.ticker);
    const catalogSource = catalogQuoteSource([ticker]).get(tickerKey(ticker));
    const quoteSource = catalogSource === "thai_mutual_fund" ? catalogSource : t.quoteSource;
    const updated = updateTransaction(numId, owned, {
      tradeDate: t.tradeDate,
      kind: t.kind,
      ticker,
      englishName: t.englishName ?? null,
      // Facts: a read unit count, else NULL for the fold to derive.
      units: t.units ?? null,
      // The stated current value — the fact for a value-only Balance; NULL otherwise.
      value: anchor ? (t.value ?? null) : null,
      // "No money moved" override — only on a Set balance (cash_balance).
      reconcile: isCashAnchorKind(t.kind) ? (t.reconcile ?? false) : null,
      pricePerUnit,
      marketPrice: t.marketPrice ?? (anchor ? null : pricePerUnit),
      // Client sends a positive magnitude; sign it by the (possibly anchor) kind.
      amount: signedAmount(t.kind, t.amount),
      fee: t.fee ?? null,
      quoteSource,
      // Non-THB cost basis: the money fields above are already THB (native ×
      // this rate at entry); the pair records the currency + trade-date rate.
      tradeCurrency: t.tradeCurrency,
      fxToThb: t.fxToThb,
      // Verbatim native figures — kept only for a non-THB row (a THB edit clears them).
      nativeInputs: t.tradeCurrency === "THB" ? null : (t.nativeInputs ?? null),
    });
    if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(updated);
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isInteger(numId)) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }
  return withDb(() => {
    const owned = listBuckets().map((b) => b.id);
    const removed = deleteTransaction(numId, owned);
    if (removed === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  });
}
