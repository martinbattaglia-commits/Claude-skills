import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { listBuckets } from "@/lib/db/queries/buckets";
import {
  managedSourceLabels,
  renameHoldingSource,
  sourceLabelSummary,
} from "@/lib/db/queries/holdings";

// The caller's source labels: distinct values across their holdings, with counts
// and a `managed` flag (label belongs to a live broker connection). Drives
// Settings → Sources. Scoped to the user's own buckets (listBuckets is
// user-scoped), so it can never reveal another user's data.
export function GET() {
  return withDb(() => {
    const bucketIds = listBuckets().map((b) => b.id);
    return NextResponse.json({ sources: sourceLabelSummary(bucketIds) });
  });
}

// Rename a `source` label across all of the caller's holdings. Scoped to the
// user's own buckets. Empty `to` clears the label. A label managed by a live
// broker connection is refused: renaming it would desync from the connector (the
// next sync re-stamps the old label and the source splits in two).
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { from?: unknown; to?: unknown } | null;
  const from = typeof body?.from === "string" ? body.from.trim() : "";
  const to = typeof body?.to === "string" ? body.to.trim() : "";
  if (!from) {
    return NextResponse.json({ error: "missing_from" }, { status: 400 });
  }
  return withDb(() => {
    const bucketIds = listBuckets().map((b) => b.id);
    const managed = managedSourceLabels(bucketIds);
    // Can't rename a managed label (it's owned by the connection)…
    if (managed.has(from)) {
      return NextResponse.json({ error: "managed_source" }, { status: 409 });
    }
    // …nor rename a manual label INTO a managed one: that would fold manual
    // holdings under a connection-managed source and trap them (managed labels
    // are read-only), re-creating the manual/synced conflation this guards.
    if (to && managed.has(to)) {
      return NextResponse.json({ error: "managed_target", broker: to }, { status: 409 });
    }
    const renamed = renameHoldingSource(bucketIds, from, to);
    return NextResponse.json({ renamed });
  });
}
