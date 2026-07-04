import "server-only";

// The `.user.js` filename the userscript install URL ends in. The serving route
// (`/api/import/broker/userscript/[token]/[name]`) ignores the name — it only has
// to end in `.user.js` so a userscript manager offers a one-click install.
// Centralized so the install wizard (token route) and the loader's runtime config
// (`/runtime`) agree on one URL.
export const USERSCRIPT_FILE = "macrotide-connector.user.js";

// The metadata-only filename a manager re-fetches for its `@updateURL` version
// check (must end in `.meta.js`). The serving route returns just the
// `// ==UserScript==` block for this name, the full script for `USERSCRIPT_FILE`.
export const USERSCRIPT_META_FILE = "macrotide-connector.meta.js";

/**
 * Absolute install URL for the ONE global userscript, derived from the request
 * origin. A single install covers every configured broker — the script @matches
 * all their hosts and resolves the connector at run time from the page hostname.
 *
 * The per-user import token rides in the URL PATH (not a header) because the
 * userscript manager fetches this URL from its own cookie-less context — it can't
 * present a session cookie or set headers. Some managers (Userscripts on Safari/
 * iOS) re-fetch the URL in the background to show the install prompt, so the route
 * must authenticate from the token alone. Path, not query/hash: managers only
 * recognize an installable script when the URL PATH ends in `.user.js`.
 */
export function brokerInstallUrl(req: Request, token: string): string {
  return `${userscriptBase(req, token)}/${USERSCRIPT_FILE}`;
}

/**
 * The `@updateURL` / `@downloadURL` pair baked into the served userscript so a
 * manager can auto-update on a protocol bump. Same token-in-path base as the
 * install URL, so the manager's cookie-less update fetch authenticates too.
 */
export function brokerUpdateUrls(
  req: Request,
  token: string,
): { downloadUrl: string; updateUrl: string } {
  const base = userscriptBase(req, token);
  return {
    downloadUrl: `${base}/${USERSCRIPT_FILE}`,
    updateUrl: `${base}/${USERSCRIPT_META_FILE}`,
  };
}

function userscriptBase(req: Request, token: string): string {
  const origin = process.env.PUBLIC_APP_URL?.trim() || new URL(req.url).origin;
  return `${origin}/api/import/broker/userscript/${encodeURIComponent(token)}`;
}
