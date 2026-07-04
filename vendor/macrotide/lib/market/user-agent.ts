// User-Agents for keyless outbound market-data fetches.
//
// Yahoo Finance rejects/throttles a bare automated-tool UA (empty, "python-
// requests/…", "curl/…") but serves a normal browser, so we present a real
// browser UA for it.
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// SEC EDGAR is stricter than a bot check: www.sec.gov enforces the SEC "Fair
// Access" policy and 403s a bare bot UA AND a plain browser UA (verified from a
// datacenter IP — the browser UA only slips through from residential IPs), serving
// only a UA that declares a contact per SEC guidance. `data.sec.gov` / `efts` are
// looser but accept the declared UA too, so we send it to ALL SEC hosts. This is
// SEC's own documented sample string (public, no personal data); set
// SEC_EDGAR_USER_AGENT to override it with a real project contact.
export const SEC_EDGAR_USER_AGENT_DEFAULT = "Sample Company Name AdminContact@sample.com";

/** Resolved SEC EDGAR User-Agent: the env override, else the declared default. */
export function secEdgarUserAgent(): string {
  return process.env.SEC_EDGAR_USER_AGENT || SEC_EDGAR_USER_AGENT_DEFAULT;
}
