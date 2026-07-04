// CLI entrypoint for the memory consolidation sweep (#221 ⑨).
//
// Usage:
//   npm run jobs:consolidate-memory
//
// Holistic: hands each category's memories to a reasoning model (CONSOLIDATE_MODELS)
// to merge near-dups + retire stale contradictions. Loads .env.local via tsx's
// --env-file flag (configured in package.json). Exits non-zero when the model chain
// is degraded (every call unparseable) so the host's job-failure alert fires.

import { fileURLToPath } from "node:url";
import { consolidateMemory } from "../lib/jobs/consolidate-memory";

async function main() {
  if (process.env.DISABLE_JOBS === "1") {
    console.log("DISABLE_JOBS=1 — skipping memory consolidation sweep.");
    return;
  }
  console.log("Running memory consolidation sweep…");
  const result = await consolidateMemory();
  console.log("\nDone.");
  console.log(`  Scopes swept:        ${result.scopesSwept.length} (owner + registered users)`);
  console.log(`  With work:           ${result.scopesWorked}`);
  console.log(`  Merged (near-dups):  ${result.mergedCount}`);
  console.log(`  Superseded (stale):  ${result.supersededCount}`);
  console.log(`  Reshaped (→ detail): ${result.reshapedCount}`);
  console.log(`  Recategorized:       ${result.recategorizedCount}`);
  console.log(`  Model calls:         ${result.modelCalls} (unparseable: ${result.parseFailures})`);

  // Degraded-chain guard: if the model was invoked but EVERY call (across scopes + the
  // in-proposer retries) returned unparseable output, nothing got consolidated and the
  // CONSOLIDATE_MODELS chain is broken. Exit non-zero so systemd's OnFailure fires the
  // host job-failure alert. A clean store (0 ops, model answered) stays exit 0.
  if (result.modelCalls > 0 && result.parseFailures === result.modelCalls) {
    console.error(
      `consolidation: model chain DEGRADED — all ${result.modelCalls} call(s) returned ` +
        "unparseable JSON. Memory was not consolidated; check CONSOLIDATE_MODELS.",
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
