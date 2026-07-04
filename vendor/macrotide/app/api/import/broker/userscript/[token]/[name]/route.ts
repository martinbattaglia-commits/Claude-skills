import { NextResponse } from "next/server";
import { withImportToken } from "@/lib/api/broker-token-auth";
import { buildUserscript, buildUserscriptHeader } from "@/lib/portfolio/broker-import";
import { brokerUpdateUrls, USERSCRIPT_META_FILE } from "@/lib/portfolio/broker-install";
import { getConnectors } from "@/lib/portfolio/connector";

// Serve the install-ready userscript. The `[name]` segment selects the variant by
// extension — the full `.user.js` (what a manager intercepts for a one-click
// install) or the metadata-only `.meta.js` (what a manager re-fetches for its
// `@updateURL` version check). Both are what managers like Tampermonkey,
// Violentmonkey, Gear, and Userscripts on Safari/iOS expect. Broker endpoints stay
// server-side (env only).
//
// Authenticated by the import token in the `[token]` path segment — NOT a session
// cookie. A manager fetches these URLs from its own context with no Macrotide
// cookies (Userscripts on Safari/iOS re-fetches in the background both to render
// the install prompt AND to check for updates), so a session-gated route would 401
// those fetches and install/update silently fails. The token both authenticates
// and tells us whose token to bake into the served script, and CORS is opened so
// the manager can read the body. The served script carries `@downloadURL`/
// `@updateURL` (this same token base) so a manager auto-updates on a protocol bump.
// 404 when no broker is configured (UI hides the panel); 401 for an unknown token.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Always send these so a cross-origin manager fetch can read the response and a
// per-user script is never held by a shared cache.
const BASE_HEADERS = {
  "Content-Type": "text/javascript; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string; name: string }> },
) {
  const { token, name } = await params;
  const metaOnly = name === USERSCRIPT_META_FILE;

  // ONE global script for every configured broker — it @matches all their hosts
  // and resolves which connector applies at run time from the page's hostname.
  const connectors = await getConnectors();
  if (connectors.length === 0)
    return new NextResponse("// broker import not configured", {
      status: 404,
      headers: BASE_HEADERS,
    });

  const origin = process.env.PUBLIC_APP_URL?.trim() || new URL(req.url).origin;
  const updateUrls = brokerUpdateUrls(req, token);

  // Validate the token resolves to a real user (cookie-less; the manager fetch
  // carries no session). The builders are DB-free — withImportToken is here to
  // reject an unknown/rotated token rather than serve a dead script. `.meta.js`
  // returns ONLY the metadata block (same @version as the full script) for the
  // manager's cheap update check; `.user.js` returns the whole loader.
  const res = await withImportToken(token, () =>
    metaOnly
      ? buildUserscriptHeader(connectors, origin, updateUrls)
      : buildUserscript(connectors, origin, token, updateUrls),
  );
  if (!res.ok)
    return new NextResponse(
      "// invalid or expired import token — reinstall from Macrotide → Settings → Connections",
      { status: 401, headers: BASE_HEADERS },
    );

  return new NextResponse(res.value, { status: 200, headers: BASE_HEADERS });
}
