// CLI entry point for the total-return benchmark series pre-warm.
//
// Usage:
//   npm run jobs:prewarm-benchmark [-- [--range=R]]
//
// --range=R   History depth: 1mo|3mo|6mo|1y|5y|max. Default "max" (backfill).
//             Use --range=1mo for the cheap daily append (the depth-aware cache
//             keeps prior "max" depth).
//
// Warms the `benchmark_tr` source for every curated proxy in BENCHMARK_TR_OPTIONS
// so the portfolio "All" chart has a deep, like-for-like benchmark to overlay.
// A handful of symbols at ~1 call each — trivially within free-tier quota.
//
// Set DISABLE_JOBS=1 to make the script exit cleanly without doing anything.
// Loads .env.local via tsx's --env-file flag (configured in package.json).

import { fileURLToPath } from "node:url";
import { prewarmBenchmark } from "../lib/jobs/prewarm-benchmark";
import type { SeriesRange } from "../lib/market/providers/types";

const RANGES: SeriesRange[] = ["1mo", "3mo", "6mo", "1y", "5y", "max"];

export interface CliArgs {
  range: SeriesRange;
}

/** Parse CLI argv into typed options. Pure — safe to unit-test. */
export function parseArgs(argv: string[]): CliArgs {
  let range: SeriesRange = "max";
  for (const arg of argv) {
    const rangeMatch = arg.match(/^--range=(\w+)$/);
    if (rangeMatch && RANGES.includes(rangeMatch[1] as SeriesRange)) {
      range = rangeMatch[1] as SeriesRange;
    }
  }
  return { range };
}

async function main() {
  if (process.env.DISABLE_JOBS === "1") {
    console.log("DISABLE_JOBS=1 — skipping benchmark pre-warm.");
    return;
  }

  const { range } = parseArgs(process.argv.slice(2));
  console.log(`Pre-warming total-return benchmark series (range=${range})…`);

  const result = await prewarmBenchmark({
    range,
    onProgress({ index, total, key, ticker, ok, error }) {
      console.log(
        `  [${index + 1}/${total}] ${key} (${ticker}) — ${ok ? "ok" : `ERROR: ${error}`}`,
      );
    },
  });

  console.log("\nDone.");
  console.log(`  Requested: ${result.requested}`);
  console.log(`  OK:        ${result.ok}`);
  console.log(`  Failed:    ${result.failed}`);
  if (result.errors.length > 0) {
    for (const e of result.errors) {
      console.log(`    - ${e.key} (${e.ticker}) — ${e.error}`);
    }
  }

  // Only a *total* wipeout signals a real outage (bad key, network, provider
  // down). Individual provider blips must not page a nightly timer. The set is
  // tiny, so the prewarm-nav floor/rate thresholds don't apply here.
  if (result.requested > 0 && result.ok === 0) {
    console.error("All benchmark warms failed — treating as a systemic failure.");
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
