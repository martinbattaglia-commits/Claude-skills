// CLI entry point for the US ETF holdings refresh job.
//
// Fetches each ETF's latest SEC N-PORT filing and stores its top-N holdings
// (public-domain, no key). Bounded per run; the long tail fills in via JIT
// warm-on-open from the detail page.
//
// Usage:
//   npm run jobs:refresh-etf-holdings [-- [--limit=N] [--symbols=A,B] [--top=N] [--stale-days=N]]

import { fileURLToPath } from "node:url";
import { refreshEtfHoldings } from "../lib/jobs/refresh-etf-holdings";

export interface CliArgs {
  limit: number;
  symbols?: string[];
  topN: number;
  staleDays?: number;
}

/** Parse CLI argv into typed options. Pure — safe to unit-test. */
export function parseArgs(argv: string[]): CliArgs {
  let limit = 50;
  let topN = 50;
  let symbols: string[] | undefined;
  let staleDays: number | undefined;
  for (const arg of argv) {
    const limitM = arg.match(/^--limit=(\d+)$/);
    const symbolsM = arg.match(/^--symbols=(.+)$/);
    const topM = arg.match(/^--top=(\d+)$/);
    const staleM = arg.match(/^--stale-days=(\d+)$/);
    if (limitM) {
      limit = Number.parseInt(limitM[1], 10);
    } else if (symbolsM) {
      symbols = symbolsM[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (topM) {
      topN = Number.parseInt(topM[1], 10);
    } else if (staleM) {
      staleDays = Number.parseInt(staleM[1], 10);
    }
  }
  return { limit, symbols, topN, staleDays };
}

async function main() {
  if (process.env.DISABLE_JOBS === "1") {
    console.log("DISABLE_JOBS=1 — skipping ETF holdings refresh.");
    return;
  }
  const { limit, symbols, topN, staleDays } = parseArgs(process.argv.slice(2));
  const staleBefore =
    staleDays != null ? new Date(Date.now() - staleDays * 86_400_000).toISOString() : undefined;
  const scope = symbols ? `${symbols.length} explicit symbols` : `limit=${limit}`;
  console.log(`Refreshing ETF holdings (${scope}, top=${topN})…`);

  const r = await refreshEtfHoldings({ limit, symbols, topN, staleBefore });
  console.log("\nDone.");
  console.log(`  Selected:      ${r.selected}`);
  console.log(`  With holdings: ${r.withHoldings}`);
  console.log(`  Classified:    ${r.classified}`);
  console.log(`  Errored:       ${r.errored}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
