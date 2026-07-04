// One-shot snapshot of the AIMC peer-group category from the LEGACY v1
// FundFactsheet API — deliberately NOT part of the nightly crawl.
//
// The v1 portal retires 2026-06-30; this script works only until then. The
// category has no v2 equivalent, so we snapshot it into sec_raw (verbatim,
// durable) and let the API-free transform derive fund_catalog.aimc_category +
// the facet ranking from the snapshot forever after. AIMC classifications
// rarely change; funds registered after the portal dies simply have no code
// and fall through to the benchmark/name facet derivation.
//
// Usage:
//   SEC_V1_API_KEY=<v1 FundFactsheet subscription key> in .env.local, then
//   npx tsx --tsconfig tsconfig.scripts.json --env-file=.env.local scripts/backfill-aimc-v1.ts
//
// Re-run any time before the portal retires to refresh the snapshot (idempotent
// — re-landing overwrites in place). Recommended: one final run in late June.

import { fileURLToPath } from "node:url";
import { getMarketDb } from "../lib/db/context";
import { makeSecRaw, SEC_ENDPOINTS, upsertSecRaw } from "../lib/db/queries/sec-raw";
import { fundCatalog } from "../lib/db/schema";
import { transformFundCatalog } from "../lib/jobs/transform-fund-catalog";
import { fetchFundCompareV1, hasV1ApiKey } from "../lib/market/providers/sec-thailand";

const CONCURRENCY = 6;

async function main() {
  if (!hasV1ApiKey()) {
    console.error("SEC_V1_API_KEY is not set — get a v1 FundFactsheet subscription key.");
    process.exit(1);
  }

  // ALL funds, including liquidated/expired — their codes are now-or-never data
  // (the portal retires), and closed-fund classifications back survivorship-aware
  // analytics + context for past holdings.
  const ids = getMarketDb()
    .select({ projId: fundCatalog.projId })
    .from(fundCatalog)
    .all()
    .map((r) => r.projId);
  console.log(`Snapshotting AIMC category for ${ids.length} funds (incl. closed)…`);

  let done = 0;
  let landed = 0;
  let errors = 0;
  const pool = new Set<Promise<void>>();
  for (const projId of ids) {
    if (pool.size >= CONCURRENCY) await Promise.race(pool);
    const task = (async () => {
      try {
        const payload = await fetchFundCompareV1(projId);
        if (payload != null) {
          upsertSecRaw([makeSecRaw(SEC_ENDPOINTS.aimcCategory, projId, "", payload)]);
          landed++;
        }
      } catch {
        errors++;
      }
      done++;
      if (done % 250 === 0)
        console.log(`  ${done}/${ids.length} (landed ${landed}, errors ${errors})`);
    })().finally(() => pool.delete(task));
    pool.add(task);
  }
  await Promise.all(pool);
  console.log(`Landed ${landed}/${done} (${errors} errors). Running transform…`);

  const result = transformFundCatalog();
  console.log(`Done — funds with an AIMC category: ${result.fundsWithAimcCategory}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
