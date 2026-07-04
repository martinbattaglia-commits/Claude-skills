// Suggestions for a holding's `source` label (where the holding is held). Free
// text — these are only hints: the user's own previously-used sources surface
// first, then these open-architecture Thai fund platforms/brokers (one account,
// funds from many AMCs). Single-AMC apps and plain bank apps are deliberately
// omitted — there you'd only ever hold that one AMC's funds. `source` is
// cosmetic — it does NOT affect pricing (that's `quoteSource`).

export const BROKERAGE_SUGGESTIONS = [
  "Dime!",
  "Finnomena",
  "InnovestX",
  "Krungsri Securities",
  "Phillip",
  "Pi",
] as const;

/**
 * Distinct, trimmed source labels — the user's own (from existing holdings)
 * first, then the brokerage starters. Drives the source combobox's datalist.
 */
export function mergeSourceSuggestions(
  holdingSources: readonly (string | null | undefined)[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...holdingSources, ...BROKERAGE_SUGGESTIONS]) {
    const v = raw?.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
