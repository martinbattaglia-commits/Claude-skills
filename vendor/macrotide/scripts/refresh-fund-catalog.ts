// CLI entry point for the fund-catalog refresh job.
//
// Usage:
//   npm run jobs:refresh-catalog [-- [--limit=N] [--dry-run]]
//
// --limit=N   Process at most N funds (for spike/dev runs). Default: all.
// --dry-run   Enumerate funds and report counts without writing to the DB.
//
// Set DISABLE_JOBS=1 to make the script exit cleanly without doing anything
// (useful for environments where the job should not run, e.g. CI or preview).
//
// Loads .env.local via tsx's --env-file flag (configured in package.json).

import { fileURLToPath } from "node:url";
import { refreshFundCatalog } from "../lib/jobs/refresh-fund-catalog";
import { enumerateFundProfiles } from "../lib/market/providers/sec-thailand";

export interface CliArgs {
  limit: number;
  dryRun: boolean;
}

// Per-fund errors are mostly transient upstream blips (the Thai SEC API
// occasionally 400s an individual factsheet sub-endpoint). A handful out of
// thousands of funds is normal and must NOT fail the whole job — otherwise
// systemd marks a 99.9%-successful crawl as failed and pages every night.
// We fail the job only when errors look systemic: more than ERROR_FLOOR funds
// AND more than ERROR_RATE of those processed. Both must be exceeded so that
// tiny runs (e.g. --limit=5 in dev) aren't tripped by a single error.
export const ERROR_FLOOR = 10;
export const ERROR_RATE = 0.05;

/**
 * Decide whether the run's error count is bad enough to fail the job (exit 1).
 * Pure — safe to unit-test. Returns false (tolerate) when fundsSeen is 0.
 */
export function exceedsErrorThreshold(errorCount: number, fundsSeen: number): boolean {
  if (fundsSeen <= 0) return false;
  return errorCount > ERROR_FLOOR && errorCount / fundsSeen > ERROR_RATE;
}

/**
 * Parse CLI argv into typed options.
 * Pure function — no I/O; safe to unit-test in isolation.
 *
 * Supported flags:
 *   --limit=N   non-negative integer; 0 means no limit
 *   --dry-run   boolean flag
 */
export function parseArgs(argv: string[]): CliArgs {
  let limit = 0;
  let dryRun = false;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else {
      const match = arg.match(/^--limit=(\d+)$/);
      if (match) {
        const n = Number.parseInt(match[1], 10);
        if (n >= 0) limit = n;
      }
    }
  }

  return { limit, dryRun };
}

async function main() {
  if (process.env.DISABLE_JOBS === "1") {
    console.log("DISABLE_JOBS=1 — skipping fund-catalog refresh.");
    return;
  }

  const { limit, dryRun } = parseArgs(process.argv.slice(2));

  if (dryRun) {
    const limitDesc = limit > 0 ? `limit=${limit}` : "no limit";
    console.log(`[dry-run] Enumerating fund profiles (${limitDesc})…`);
    const profiles = await enumerateFundProfiles(limit);
    console.log(`[dry-run] Would process ${profiles.length} fund(s).`);
    console.log("[dry-run] No changes made.");
    return;
  }

  const limitDesc = limit > 0 ? `limit=${limit}` : "all funds";
  console.log(`Running fund-catalog refresh (${limitDesc})…`);

  let lastReport = 0;
  const result = await refreshFundCatalog({
    limit,
    concurrency: 4,
    onProgress({ index, total, projId, ok, error }) {
      // Log every 50 funds to show progress without flooding stdout.
      if (index - lastReport >= 50 || index === total - 1) {
        console.log(`  [${index + 1}/${total}] ${projId} — ${ok ? "ok" : `ERROR: ${error}`}`);
        lastReport = index;
      }
    },
  });

  console.log("\nDone.");
  console.log(`  Funds seen:          ${result.fundsSeen}`);
  console.log(`  Funds upserted:      ${result.fundsUpserted}`);
  console.log(`  Fee rows upserted:   ${result.feeRowsUpserted}`);
  console.log(`  Benchmarks landed:   ${result.benchmarksLanded}`);
  console.log(`  Statistics landed:   ${result.statisticsLanded}`);
  if (result.errors.length > 0) {
    console.log(`  Errors (${result.errors.length}):`);
    for (const { projId, error } of result.errors) {
      console.log(`    - ${projId}: ${error}`);
    }
    if (exceedsErrorThreshold(result.errors.length, result.fundsSeen)) {
      console.error(
        `Error rate ${result.errors.length}/${result.fundsSeen} exceeds threshold ` +
          `(>${ERROR_FLOOR} and >${ERROR_RATE * 100}%) — failing the job.`,
      );
      process.exit(1);
    }
    console.log(
      `  ${result.errors.length}/${result.fundsSeen} errors — within tolerance, exiting 0.`,
    );
  }
}

// Run only when invoked directly — prevents main() from firing when the module
// is imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
