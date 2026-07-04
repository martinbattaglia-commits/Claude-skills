import { COLLECTOR_PROTOCOL_VERSION, resolveCollectorShape } from "@macrotide/connector-sdk";
import { NextResponse } from "next/server";
import { withImportToken } from "@/lib/api/broker-token-auth";
import { brokerInstallUrl } from "@/lib/portfolio/broker-install";
import { getConnector, getConnectors } from "@/lib/portfolio/connector";

// Runtime config for the installed userscript loader. The loader fetches this on
// each run (token in a header, never a URL) and uses it to drive the gather — so
// the broker's endpoints + response shape can change with NO reinstall. Only a
// bump of the gather ALGORITHM (`collectorVersion`) needs a reinstall, which the
// loader detects by comparing this value to its own baked protocol version.
//
// Authenticated by the import token alone (the loader has no cookies). Returns
// only the user's own connector config + version — no secrets, no DB writes.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // The global userscript resolves its connector by the page's `?host=`; a `?c=`
  // (explicit id) still works. Absent → the first configured.
  const sp = new URL(req.url).searchParams;
  const connectorId = sp.get("c")?.trim() || undefined;
  const host = sp.get("host")?.trim() || undefined;
  let connector: Awaited<ReturnType<typeof getConnector>> = null;
  if (connectorId) {
    connector = await getConnector(connectorId);
  } else if (host) {
    const all = await getConnectors();
    connector = all.find((c) => c.host === host || host.endsWith(`.${c.host}`)) ?? null;
  } else {
    connector = await getConnector();
  }
  if (!connector) return NextResponse.json({ error: "not_configured" }, { status: 404 });

  const token = req.headers.get("x-import-token")?.trim() ?? "";
  if (!token) return NextResponse.json({ error: "missing_token" }, { status: 401 });

  const res = await withImportToken(token, () =>
    NextResponse.json(
      {
        source: connector.sourceTag,
        host: connector.host,
        displayName: connector.displayName,
        planPath: connector.planPath,
        historyPath: connector.historyPath,
        pendingPath: connector.pendingPath ?? null,
        openUrl: connector.openUrl ?? null,
        // Where the loader's "Update" button points (the .user.js → manager reinstall).
        installUrl: brokerInstallUrl(req, token),
        // Fully-resolved collector shape (defaults merged) so the loader has no gaps.
        shape: resolveCollectorShape(connector.shape),
        collectorVersion: COLLECTOR_PROTOCOL_VERSION,
      },
      // Per-user; never let a shared cache hold it.
      { headers: { "Cache-Control": "no-store" } },
    ),
  );
  if (!res.ok) return NextResponse.json({ error: "invalid_token" }, { status: 401 });
  return res.value;
}
