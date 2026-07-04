// GET /api/portfolio/fee-creep — fee-creep analysis for the current portfolio.
//
// Returns the list of held funds that have a cheaper active peer with the same
// exposure (asset class + geographic region). Each finding includes the held
// fund's name, current TER, up to three cheaper alternatives sorted
// cheapest-first, the potential annual fee saving in percentage-points, and its
// deterministic suppression key (so the client can Archive / reject it without
// re-deriving the key).
//
// An empty array is a valid (and happy-path) response — it means the user is
// already paying the lowest fees available for their exposure.
//
// Suppression (#74): findings the user archived or rejected are dropped — but
// the reason-aware resurface logic (lib/db/queries/action-items.listSuppressed +
// action-item-resurface) brings one back if its saving has materially worsened
// past the bar its reason selects (ratchet-protected). Applied server-side so
// the rules stay authoritative; the client never has to know them.

import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { listSuppressed } from "@/lib/db/queries/action-items";
import { feeCreepKey } from "@/lib/portfolio/action-item-key";
import { computeFeeCreep } from "@/lib/portfolio/fee-creep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return withDb(() => {
    const findings = computeFeeCreep();
    // Feed current magnitudes to the resurface check so a materially-worse
    // archived/rejected finding can come back (ratchet-protected).
    const suppressed = new Set(
      listSuppressed(
        findings.map((f) => ({ itemKey: feeCreepKey(f.heldTicker), savingsPp: f.savingsPp })),
      ).map((s) => s.itemKey),
    );
    const visible = findings
      .filter((f) => !suppressed.has(feeCreepKey(f.heldTicker)))
      // Surface the stable key alongside each finding so the UI can act on it.
      .map((f) => ({ ...f, key: feeCreepKey(f.heldTicker) }));
    return NextResponse.json(visible);
  });
}
