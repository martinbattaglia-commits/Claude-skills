// CLI entry point for the US securities catalog refresh job.
//
// Usage:
//   npm run jobs:refresh-us-securities [-- [--limit=N] [--dry-run]]
//
// --limit=N   Process at most N directory rows (dev/spike runs; skips the
//             delist sweep so it can't wrongly delist everything past the cap).
// --dry-run   Fetch + parse the directory and report counts without writing.
//
// Set DISABLE_JOBS=1 to make the script exit cleanly without doing anything.
// Loads .env.local via tsx's --env-file flag (configured in package.json).

import { fileURLToPath } from "node:url";
import { parseNasdaqDirectory, refreshUsSecurities } from "../lib/jobs/refresh-us-securities";

const DIRECTORY_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt";

export interface CliArgs {
  limit: number;
  dryRun: boolean;
}

/** Parse CLI argv into typed options. Pure — safe to unit-test. */
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
    console.log("DISABLE_JOBS=1 — skipping US securities refresh.");
    return;
  }

  const { limit, dryRun } = parseArgs(process.argv.slice(2));

  if (dryRun) {
    console.log("[dry-run] Fetching Nasdaq directory…");
    const res = await fetch(DIRECTORY_URL, {
      headers: { Accept: "text/plain" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Nasdaq directory fetch returned ${res.status}`);
    const rows = parseNasdaqDirectory(await res.text());
    const etfs = rows.filter((r) => r.securityType === "etf").length;
    console.log(
      `[dry-run] Parsed ${rows.length} securities (${etfs} ETFs, ${rows.length - etfs} stocks).`,
    );
    console.log("[dry-run] No changes made.");
    return;
  }

  const limitDesc = limit > 0 ? `limit=${limit}` : "all securities";
  console.log(`Running US securities refresh (${limitDesc})…`);
  // Enrich a bounded batch of composite FIGIs each run (the rename anchor); a free
  // OPENFIGI_API_KEY makes this seconds. The 12.9k backfill spreads over a few nights.
  const result = await refreshUsSecurities({ limit, figiBatch: limit > 0 ? 0 : 500 });
  console.log("\nDone.");
  console.log(`  Parsed:        ${result.parsed}`);
  console.log(`  Upserted:      ${result.upserted}`);
  console.log(`  Delisted:      ${result.delisted}`);
  console.log(`  FIGI enriched: ${result.figiEnriched}`);
  console.log(`  Renamed:       ${result.renamed}`);
}

// Run only when invoked directly (not when imported by a test).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
