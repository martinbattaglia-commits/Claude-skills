// CLI entry point for the ETF-holding ticker resolution job.
//
// Resolves ETF constituents' CUSIP/ISIN → ticker via OpenFIGI, caches the
// crosswalk, and stamps us_etf_holdings.resolved_symbol. Bounded per run to
// respect the OpenFIGI rate limit; the long tail fills in over nightly runs.
//
// Usage:
//   npm run jobs:resolve-etf-tickers [-- [--limit=N] [--stale-days=N]]

import { fileURLToPath } from "node:url";
import { resolveEtfTickers } from "../lib/jobs/resolve-etf-tickers";

export interface CliArgs {
  limit: number;
  staleDays?: number;
}

/** Parse CLI argv into typed options. Pure — safe to unit-test. */
export function parseArgs(argv: string[]): CliArgs {
  let limit = 500;
  let staleDays: number | undefined;
  for (const arg of argv) {
    const limitM = arg.match(/^--limit=(\d+)$/);
    const staleM = arg.match(/^--stale-days=(\d+)$/);
    if (limitM) {
      limit = Number.parseInt(limitM[1], 10);
    } else if (staleM) {
      staleDays = Number.parseInt(staleM[1], 10);
    }
  }
  return { limit, staleDays };
}

async function main() {
  if (process.env.DISABLE_JOBS === "1") {
    console.log("DISABLE_JOBS=1 — skipping ETF ticker resolution.");
    return;
  }
  const { limit, staleDays } = parseArgs(process.argv.slice(2));
  const staleBefore =
    staleDays != null ? new Date(Date.now() - staleDays * 86_400_000).toISOString() : undefined;
  console.log(`Resolving ETF-holding tickers (limit=${limit})…`);

  const r = await resolveEtfTickers({ limit, staleBefore });
  console.log("\nDone.");
  console.log(`  Candidates: ${r.candidates}`);
  console.log(`  Attempted:  ${r.attempted}`);
  console.log(`  Resolved:   ${r.resolved}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
