import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { listBuckets } from "@/lib/db/queries/buckets";
import { listEarmarks } from "@/lib/db/queries/earmarks";
import {
  listTransactionsByBucket,
  listTransactionsForBuckets,
} from "@/lib/db/queries/transactions";
import type { CostBasisMethod } from "@/lib/portfolio/lots";
import { computeTransactionAnalytics } from "@/lib/portfolio/transaction-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/transactions/analytics?bucket=ID&ticker=SYM&method=average|fifo
//
// Realized gains, money-weighted return (IRR), and the cost-basis timeline —
// scoped to the caller's buckets, and optionally narrowed to a single instrument
// (`ticker`) so a position page can show its own per-fund analytics. Holdings ARE
// the ledger's projection (ADR 0004), so there is no snapshot to reconcile
// against. The two-DB join (ledger in app.db, current NAV + FX from market.db)
// happens in the analytics orchestrator; the pure math stays DB-free.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const bucket = url.searchParams.get("bucket") ?? undefined;
  const ticker = url.searchParams.get("ticker")?.trim() || undefined;
  const method: CostBasisMethod = url.searchParams.get("method") === "fifo" ? "fifo" : "average";
  // Contribution mode (#149): `cash=funds` excludes uninvested cash from the
  // return (mode B); default counts it (mode A). Reserved cash is out either way.
  const countUninvestedCash = url.searchParams.get("cash") !== "funds";

  return withDb(async () => {
    const owned = listBuckets();
    const ownedIds = owned.map((b) => b.id);

    let bucketIds: string[];
    if (bucket) {
      if (!ownedIds.includes(bucket))
        return NextResponse.json({ error: "bucket_not_found" }, { status: 404 });
      bucketIds = [bucket];
    } else {
      bucketIds = ownedIds;
    }

    const all =
      bucketIds.length === 1
        ? listTransactionsByBucket(bucketIds[0])
        : listTransactionsForBuckets(bucketIds);
    // Optional single-instrument scope for a position page. The math is the same;
    // it just runs over that fund's events only.
    const txns = ticker ? all.filter((t) => t.ticker === ticker) : all;

    // Reserved cash accounts (#149) are excluded from the return — collect their tickers.
    const reservedTickers = new Set(
      listEarmarks()
        .filter((e) => e.role === "reserved" && e.ticker)
        .map((e) => (e.ticker as string).toUpperCase()),
    );

    const asOf = new Date().toISOString().slice(0, 10);
    const analytics = await computeTransactionAnalytics(txns, {
      method,
      asOf,
      reservedTickers,
      countUninvestedCash,
    });
    return NextResponse.json({ ...analytics, transactionCount: txns.length });
  });
}
