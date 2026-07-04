// CLI entry point for the tracked-market refresh job (issue #23).
//
// Usage:
//   npm run jobs:refresh-market
//
// Refreshes cached NAV/quote for every catalog indicator + every distinct held
// position — the *freshness* job. Run it on a daily timer after the Thai SEC
// ~17:30 Bangkok NAV window so charts are current without a user trigger. For
// full-catalog *coverage*, see `jobs:prewarm-nav` (issue #104).
//
// Set DISABLE_JOBS=1 to make the script exit cleanly without doing anything.
// Loads .env.local via tsx's --env-file flag (configured in package.json).

import { fileURLToPath } from "node:url";
import { refreshTrackedMarket } from "../lib/jobs/refresh-tracked-market";

async function main() {
  if (process.env.DISABLE_JOBS === "1") {
    console.log("DISABLE_JOBS=1 — skipping tracked-market refresh.");
    return;
  }

  console.log("Refreshing tracked market data (indicators + held positions)…");
  const r = await refreshTrackedMarket();

  console.log("\nDone.");
  console.log(`  Requested: ${r.requested}`);
  console.log(`  OK:        ${r.ok}`);
  console.log(`  Failed:    ${r.failed}`);
  if (r.errors.length > 0) {
    for (const e of r.errors) {
      console.log(`    - ${e.source}:${e.ticker} — ${e.error ?? "unknown error"}`);
    }
  }

  // Only treat a *total* wipeout as a job failure. Individual provider blips
  // (a single 429) are normal and must not page a nightly timer; an all-failed
  // run signals a real outage (bad key, network, every provider down).
  if (r.requested > 0 && r.ok === 0) {
    console.error("All refreshes failed — treating as a systemic failure.");
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
