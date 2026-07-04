// CLI entry point for the popular US-securities prewarm job.
//
// Usage:
//   npm run jobs:refresh-popular [-- [--top=N] [--keep=N]]
//
// Derives the popular set from Alpaca's most-actives screener (dollar-volume
// ranked, leveraged/inverse filtered), blends in recent user demand, and warms
// it all into the NAV cache so the charts open instantly. No-op for the most-
// actives half when ALPACA creds are unset (still warms the demand half).
//
// Set DISABLE_JOBS=1 to make the script exit cleanly without doing anything.
// Loads .env.local via tsx's --env-file flag (configured in package.json).

import { fileURLToPath } from "node:url";
import { refreshPopular } from "../lib/jobs/refresh-popular";

export interface CliArgs {
  top: number;
  keep: number;
}

/** Parse CLI argv into typed options. Pure — safe to unit-test. */
export function parseArgs(argv: string[]): CliArgs {
  let top = 0;
  let keep = 0;
  for (const arg of argv) {
    const t = arg.match(/^--top=(\d+)$/);
    if (t) top = Number.parseInt(t[1], 10);
    const k = arg.match(/^--keep=(\d+)$/);
    if (k) keep = Number.parseInt(k[1], 10);
  }
  return { top, keep };
}

async function main() {
  if (process.env.DISABLE_JOBS === "1") {
    console.log("DISABLE_JOBS=1 — skipping popular prewarm.");
    return;
  }
  const { top, keep } = parseArgs(process.argv.slice(2));
  console.log("Warming popular US securities…");
  const r = await refreshPopular({
    candidateTop: top > 0 ? top : undefined,
    popularKeep: keep > 0 ? keep : undefined,
  });
  console.log("\nDone.");
  console.log(`  Most-actives:   ${r.actives}`);
  console.log(`  Warmed (cand):  ${r.warmed}`);
  console.log(`  Scored popular: ${r.scored}`);
  console.log(`  Demand warmed:  ${r.demandWarmed}`);
  console.log(`  Decayed:        ${r.decayed}`);
  if (r.errors.length > 0) console.log(`  Warm failures:  ${r.errors.length}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
