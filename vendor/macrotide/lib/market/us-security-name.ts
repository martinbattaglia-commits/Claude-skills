// Display formatting for US securities catalog names.
//
// The Nasdaq directory appends a security-class suffix to stock names
// ("Apple Inc. - Common Stock", "Alphabet Inc. - Class A Common Stock") that is
// noise for a holding label. ETF and fund names arrive clean and are left as-is.
// Pure + client-safe (no server-only imports) so the Add-holding sheet, Explore,
// and tests can all share one cleaner.

/**
 * Strip a trailing share-class suffix ("- Common Stock", "- Class A Common
 * Stock", "- Ordinary Shares", …) from a US security name. Conservative: only
 * removes a clearly stock-class tail, never touches an ETF / fund name.
 */
export function cleanUsSecurityName(name: string): string {
  return name
    .replace(/\s*-\s*(Class\s+[A-Z]\s+)?(Common Stock|Ordinary Shares?|Common Shares?)\s*$/i, "")
    .trim();
}
