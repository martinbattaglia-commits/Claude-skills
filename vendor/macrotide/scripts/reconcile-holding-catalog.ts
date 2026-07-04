// Reconcile holdings against the live fund catalog (#235) — the seamless
// no-data → data transition. Run AFTER the nightly catalog refresh:
//   - a custom (`manual`) holding whose ticker has since JOINED the catalog is
//     promoted to `thai_mutual_fund` so it starts pricing automatically;
//   - any holding whose stable (proj_id, class_name) anchor is missing or stale
//     is (re)bound from its current ticker.
// Idempotent — a second run reports 0 changes. macrotide is MULTI-USER in prod:
// this batch runs against the persistent app.db (which holds EVERY user's rows)
// and reconciles all of them in one pass; demo DBs are ephemeral and need nothing.
//
// Usage:
//   npx tsx --tsconfig tsconfig.scripts.json scripts/reconcile-holding-catalog.ts

import { fileURLToPath } from "node:url";
import { reconcileHoldingCatalog } from "../lib/db/queries/project-holdings";

async function main() {
  if (process.env.DISABLE_JOBS === "1") {
    console.log("DISABLE_JOBS=1 — skipping holding-catalog reconcile.");
    return;
  }
  const { promoted, bound } = reconcileHoldingCatalog();
  console.log(
    `[reconcile-holding-catalog] promoted ${promoted} custom→cataloged holding(s); ` +
      `bound/refreshed ${bound} catalog anchor(s).`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
