// CLI entry point for the US securities detail-enrichment job.
//
// Fills profile + fundamentals + ratios on us_securities from SEC public-domain
// data (no API key). Bounded per run (popularity/views first); a large catalog
// fills in over several nights.
//
// Usage:
//   npm run jobs:enrich-us-securities [-- [--limit=N] [--symbols=A,B] [--stale-days=N]]
//
// --limit=N         Max symbols this run (default 200).
// --symbols=A,B,C   Enrich exactly these (overrides the ranked selection).
// --stale-days=N    Only re-enrich rows older than N days (omit = include never-enriched).
//
// Set DISABLE_JOBS=1 to exit cleanly without doing anything.

import { fileURLToPath } from "node:url";
import { enrichUsSecurities } from "../lib/jobs/enrich-us-securities";

export interface CliArgs {
  limit: number;
  symbols?: string[];
  staleDays?: number;
}

/** Parse CLI argv into typed options. Pure — safe to unit-test. */
export function parseArgs(argv: string[]): CliArgs {
  let limit = 200;
  let symbols: string[] | undefined;
  let staleDays: number | undefined;
  for (const arg of argv) {
    const limitM = arg.match(/^--limit=(\d+)$/);
    const symbolsM = arg.match(/^--symbols=(.+)$/);
    const staleM = arg.match(/^--stale-days=(\d+)$/);
    if (limitM) {
      limit = Number.parseInt(limitM[1], 10);
    } else if (symbolsM) {
      symbols = symbolsM[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (staleM) {
      staleDays = Number.parseInt(staleM[1], 10);
    }
  }
  return { limit, symbols, staleDays };
}

async function main() {
  if (process.env.DISABLE_JOBS === "1") {
    console.log("DISABLE_JOBS=1 — skipping US securities enrichment.");
    return;
  }

  const { limit, symbols, staleDays } = parseArgs(process.argv.slice(2));
  const staleBefore =
    staleDays != null ? new Date(Date.now() - staleDays * 86_400_000).toISOString() : undefined;

  const scope = symbols ? `${symbols.length} explicit symbols` : `limit=${limit}`;
  console.log(
    `Enriching US securities (${scope}${staleBefore ? `, stale<${staleBefore.slice(0, 10)}` : ""})…`,
  );

  // A full nightly run also bulk-applies GICS sectors + index membership; a
  // symbol-scoped run doesn't.
  const r = await enrichUsSecurities({
    limit,
    symbols,
    staleBefore,
    applyGics: !symbols,
    applyIndices: !symbols,
  });
  console.log("\nDone.");
  console.log(`  Selected:          ${r.selected}`);
  console.log(`  With profile:      ${r.withProfile}`);
  console.log(`  With fundamentals: ${r.withFundamentals}`);
  console.log(`  Rows enriched:     ${r.enriched}`);
  console.log(`  GICS applied:      ${r.gicsApplied}`);
  console.log(`  Indices applied:   ${r.indicesApplied}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
