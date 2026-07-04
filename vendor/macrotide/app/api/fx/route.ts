import { NextResponse } from "next/server";
import { fxRateOn } from "@/lib/market/fx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Trade-date FX rate for capturing a non-THB cost basis. Reads only the
// shared market.db FX cache (global reference data — no per-user scope, so no
// withDb), and reuses the same Frankfurter cross-rate path as the value fold so an
// entered basis and its later valuation can't disagree on a rate.
//
//   GET /api/fx?from=USD&on=2026-06-30  →  { from, on, rate: number | null }
//
// `rate` is "1 `from` unit, in THB" on that date; null when the cache is cold or the
// currency is unknown, so the client falls back to a manual rate rather than guess.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const from = (url.searchParams.get("from") ?? "").trim().toUpperCase();
  const on = (url.searchParams.get("on") ?? "").trim();
  if (!from || !/^[A-Z]{3}$/.test(from)) {
    return NextResponse.json({ error: "bad_currency" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) {
    return NextResponse.json({ error: "bad_date" }, { status: 400 });
  }
  const rate = await fxRateOn(from, on);
  return NextResponse.json({ from, on, rate });
}
