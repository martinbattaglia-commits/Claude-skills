import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { isDemoRequest } from "@/lib/db/context";
import { getOrCreateBrokerImportToken } from "@/lib/db/queries/broker-token";
import { brokerInstallUrl } from "@/lib/portfolio/broker-install";
import { getConnectors } from "@/lib/portfolio/connector";

// Lists every configured broker connector for the Connect-a-broker picker (so the
// UI can offer more than one) — each broker's display name, host, login/open
// links, and the install URL. The install URL embeds the caller's own import token
// (its path credential); this route is session-gated, so that's the same per-user
// token the token route already returns to this user — no wider exposure.
// 404 in a demo session; an empty array when none is configured.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const connectors = await getConnectors();

  return withDb(() => {
    if (isDemoRequest()) return NextResponse.json({ error: "not_available" }, { status: 404 });
    // One global userscript covers every broker, so one token drives every row.
    const installUrl = brokerInstallUrl(req, getOrCreateBrokerImportToken());
    return NextResponse.json(
      connectors.map((c) => ({
        id: c.id,
        // The tag stamped on imported rows — lets the UI group synced accounts
        // (whose `source` is this tag) under the right broker.
        source: c.sourceTag,
        displayName: c.displayName,
        host: c.host,
        openUrl: c.openUrl ?? null,
        loginUrl: c.loginUrl ?? c.openUrl ?? null,
        installUrl,
      })),
    );
  });
}
