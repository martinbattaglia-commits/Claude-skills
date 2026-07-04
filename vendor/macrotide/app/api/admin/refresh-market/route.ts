// Internal admin endpoint: refreshes cached market data for every indicator in
// the catalog + every ticker present in `holdings`. Designed to be called from
// a cron job — but the scheduled path is now a systemd timer running
// `npm run jobs:refresh-market` (scripts/refresh-tracked-market.ts), which
// invokes the same `refreshTrackedMarket` job this route does. Both share the
// symbol-set logic so the route and the timer can never drift.
//
//   0 7 * * *  curl -s -X POST http://localhost:3000/api/admin/refresh-market
//
// Owner-only: this fans out to every paid market provider and force-expires the
// quote cache, so an unauthenticated caller could exhaust provider quotas. The
// scheduled refresh runs the same job directly via the systemd timer / CLI, so
// the HTTP route exists only for manual owner/operator use. AUTH_DISABLED
// (single-owner localhost dev) is treated as the owner.

import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/api/require-owner";
import { refreshTrackedMarket } from "@/lib/jobs/refresh-tracked-market";
import { INDICATOR_CATALOG } from "@/lib/market/indicators";

export async function POST() {
  const denied = await requireOwner();
  if (denied) return denied;

  const result = await refreshTrackedMarket();
  return NextResponse.json({
    refreshedAt: new Date().toISOString(),
    requested: result.requested,
    ok: result.ok,
    failed: result.failed,
    errors: result.errors,
  });
}

export async function GET() {
  const denied = await requireOwner();
  if (denied) return denied;

  return NextResponse.json({
    hint: "POST this endpoint to refresh market data (provider-chain cache).",
    indices: INDICATOR_CATALOG.map((i) => i.symbol),
  });
}
