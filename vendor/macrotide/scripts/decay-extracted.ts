// CLI entrypoint for the auto-extracted-memory confidence-decay sweep.
//
// Usage:
//   npm run jobs:decay-extracted [-- [--min-age-days=N] [--step=0.1]]
//
// --min-age-days=N   Age before an unconfirmed extracted note decays (default: 30).
// --step=F           Confidence subtracted per run (default: 0.1).
//
// Loads .env.local via tsx's --env-file flag (configured in package.json).

import { fileURLToPath } from "node:url";
import {
  DEFAULT_DECAY_STEP,
  DEFAULT_MIN_AGE_DAYS,
  decayStaleExtractedMemory,
} from "../lib/jobs/decay-extracted";

export interface CliArgs {
  minAgeDays: number;
  step: number;
}

/** Parse CLI argv into typed options. Pure — safe to unit-test. */
export function parseArgs(argv: string[]): CliArgs {
  let minAgeDays = DEFAULT_MIN_AGE_DAYS;
  let step = DEFAULT_DECAY_STEP;
  for (const arg of argv) {
    const age = arg.match(/^--min-age-days=(\d+)$/);
    if (age) {
      const n = Number.parseInt(age[1], 10);
      if (n > 0) minAgeDays = n;
      continue;
    }
    const s = arg.match(/^--step=(0?\.\d+|1(?:\.0+)?)$/);
    if (s) {
      const f = Number.parseFloat(s[1]);
      if (f > 0 && f <= 1) step = f;
    }
  }
  return { minAgeDays, step };
}

function main() {
  if (process.env.DISABLE_JOBS === "1") {
    console.log("DISABLE_JOBS=1 — skipping extracted-memory decay sweep.");
    return;
  }
  const { minAgeDays, step } = parseArgs(process.argv.slice(2));
  console.log(`Running extracted-memory decay sweep (min-age-days=${minAgeDays}, step=${step})…`);
  const result = decayStaleExtractedMemory({ minAgeDays, step });
  console.log("\nDone.");
  console.log(`  Scopes:  ${result.scopesSwept.length} (owner + registered users)`);
  console.log(`  Decayed: ${result.decayedCount} unconfirmed extracted note(s)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
