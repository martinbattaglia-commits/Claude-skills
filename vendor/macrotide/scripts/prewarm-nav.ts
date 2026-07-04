// CLI entry point for the all-funds NAV pre-warm crawler (issue #104).
//
// Usage:
//   npm run jobs:prewarm-nav [-- [--limit=N] [--concurrency=N] [--range=R] [--retail-only]]
//
// --limit=N        Warm at most N tickers (spike/dev). Default: all active classes.
// --concurrency=N  In-flight fetches (the SEC rate gate caps real throughput).
//                  Default 6.
// --range=R        History depth: 1mo|3mo|6mo|1y|5y|max. Default "max" (backfill).
//                  Use --range=1mo for the cheap daily append.
// --retail-only    Skip institutional/insurance classes (cuts crawl volume).
//
// Set DISABLE_JOBS=1 to make the script exit cleanly without doing anything.
// Loads .env.local via tsx's --env-file flag (configured in package.json).
//
// This is the *coverage* crawl — heavy, off-peak. For *freshness* of held +
// indicator NAV, see `jobs:refresh-market` (issue #23).

import { fileURLToPath } from "node:url";
import { prewarmNav } from "../lib/jobs/prewarm-nav";
import type { SeriesRange } from "../lib/market/providers/types";

const RANGES: SeriesRange[] = ["1mo", "3mo", "6mo", "1y", "5y", "max"];

// A large slice of registered retail share classes genuinely publish no NAV
// (newly-launched or never-funded class variants — e.g. dividend/electronic/SSF
// classes an AMC pre-registers but hasn't seeded), so they throw and count as
// failed. Measured ~25-27% on the live retail universe, so tolerate up to ~35%
// before treating a run as a real outage; both the floor and the rate must be
// exceeded so a tiny dev run isn't tripped by a handful of errors.
export const ERROR_FLOOR = 50;
export const ERROR_RATE = 0.35;

export function exceedsErrorThreshold(errorCount: number, seen: number): boolean {
  if (seen <= 0) return false;
  return errorCount > ERROR_FLOOR && errorCount / seen > ERROR_RATE;
}

export interface CliArgs {
  limit: number;
  concurrency: number;
  range: SeriesRange;
  retailOnly: boolean;
}

/** Parse CLI argv into typed options. Pure — safe to unit-test. */
export function parseArgs(argv: string[]): CliArgs {
  let limit = 0;
  let concurrency = 6;
  let range: SeriesRange = "max";
  let retailOnly = false;

  for (const arg of argv) {
    if (arg === "--retail-only") {
      retailOnly = true;
      continue;
    }
    const limitMatch = arg.match(/^--limit=(\d+)$/);
    if (limitMatch) {
      const n = Number.parseInt(limitMatch[1], 10);
      if (n >= 0) limit = n;
      continue;
    }
    const concMatch = arg.match(/^--concurrency=(\d+)$/);
    if (concMatch) {
      const n = Number.parseInt(concMatch[1], 10);
      if (n >= 1) concurrency = n;
      continue;
    }
    const rangeMatch = arg.match(/^--range=(\w+)$/);
    if (rangeMatch && RANGES.includes(rangeMatch[1] as SeriesRange)) {
      range = rangeMatch[1] as SeriesRange;
    }
  }

  return { limit, concurrency, range, retailOnly };
}

async function main() {
  if (process.env.DISABLE_JOBS === "1") {
    console.log("DISABLE_JOBS=1 — skipping NAV pre-warm.");
    return;
  }

  const { limit, concurrency, range, retailOnly } = parseArgs(process.argv.slice(2));
  const scope = retailOnly ? "retail classes" : "all active classes";
  const limitDesc = limit > 0 ? `, limit=${limit}` : "";
  console.log(
    `Pre-warming NAV history (${scope}, range=${range}, concurrency=${concurrency}${limitDesc})…`,
  );

  let lastReport = 0;
  const result = await prewarmNav({
    limit,
    concurrency,
    range,
    retailOnly,
    onProgress({ index, total, ticker, ok, error }) {
      if (index - lastReport >= 100 || index === total - 1) {
        console.log(`  [${index + 1}/${total}] ${ticker} — ${ok ? "ok" : `ERROR: ${error}`}`);
        lastReport = index;
      }
    },
  });

  console.log("\nDone.");
  console.log(`  Tickers seen: ${result.tickersSeen}`);
  console.log(`  Warmed (ok):  ${result.ok}`);
  console.log(`  Failed:       ${result.failed}`);
  if (exceedsErrorThreshold(result.failed, result.tickersSeen)) {
    console.error(
      `Error rate ${result.failed}/${result.tickersSeen} exceeds threshold ` +
        `(>${ERROR_FLOOR} and >${ERROR_RATE * 100}%) — failing the job.`,
    );
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
