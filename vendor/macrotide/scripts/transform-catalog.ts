// CLI entry point for the catalog TRANSFORM — the API-free half of the ELT crawl.
//
// Re-derives fund_catalog + fund_fees from the verbatim SEC payloads already
// landed in `sec_raw` (by `jobs:refresh-catalog`). No SEC API calls: this is the
// seconds-long re-run you use after changing a classification/derivation rule,
// instead of an ~80-min re-crawl.
//
// Usage:
//   npm run jobs:transform-catalog
//
// Set DISABLE_JOBS=1 to make the script exit cleanly without doing anything.
//
// Loads .env.local via tsx's --env-file flag (configured in package.json) — only
// for MARKET_DB_PATH; no SEC_API_KEY is needed.

import { fileURLToPath } from "node:url";
import { countSecRaw, SEC_ENDPOINTS } from "../lib/db/queries/sec-raw";
import { transformFundCatalog } from "../lib/jobs/transform-fund-catalog";

async function main() {
  if (process.env.DISABLE_JOBS === "1") {
    console.log("DISABLE_JOBS=1 — skipping catalog transform.");
    return;
  }

  const landedProfiles = countSecRaw(SEC_ENDPOINTS.profiles);
  if (landedProfiles === 0) {
    console.error(
      "No landed profiles in sec_raw — run `npm run jobs:refresh-catalog` first " +
        "to land raw SEC payloads, then re-run the transform.",
    );
    process.exit(1);
  }

  console.log(`Transforming ${landedProfiles} landed fund profile(s)…`);
  const result = transformFundCatalog();

  console.log("\nDone.");
  console.log(`  Funds upserted:    ${result.fundsUpserted}`);
  console.log(`  Funds with fees:   ${result.fundsWithFees}`);
  console.log(`  Fee rows upserted: ${result.feeRowsUpserted}`);
}

// Run only when invoked directly — prevents main() from firing on import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
