// CLI entry point for the US dividend refresh job (Alpaca corporate actions).
//
// Usage:
//   npm run jobs:refresh-dividends [-- [--limit=N] [--symbols=A,B] [--stale-days=N]]

import { fileURLToPath } from "node:url";
import { refreshDividends } from "../lib/jobs/refresh-dividends";

export interface CliArgs {
  limit: number;
  symbols?: string[];
  staleDays?: number;
}

/** Parse CLI argv into typed options. Pure — safe to unit-test. */
export function parseArgs(argv: string[]): CliArgs {
  let limit = 50;
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
    console.log("DISABLE_JOBS=1 — skipping dividend refresh.");
    return;
  }
  const { limit, symbols, staleDays } = parseArgs(process.argv.slice(2));
  const staleBefore =
    staleDays != null ? new Date(Date.now() - staleDays * 86_400_000).toISOString() : undefined;
  const scope = symbols ? `${symbols.length} explicit symbols` : `limit=${limit}`;
  console.log(`Refreshing US dividends (${scope})…`);

  const r = await refreshDividends({ limit, symbols, staleBefore });
  console.log("\nDone.");
  console.log(`  Selected:       ${r.selected}`);
  console.log(`  With dividends: ${r.withDividends}`);
  console.log(`  Errored:        ${r.errored}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
