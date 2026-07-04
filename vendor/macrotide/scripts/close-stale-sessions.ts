// CLI entrypoint for the stale-session backstop sweep.
//
// Usage:
//   npm run jobs:close-stale [-- [--idle-days=N] [--dry-run]]
//
// --idle-days=N   Idle threshold in days (default: 7).
// --dry-run       Report what WOULD close without making any changes.
//
// Loads .env.local via tsx's --env-file flag (configured in package.json).

import { fileURLToPath } from "node:url";
import { runWithUserScope } from "../lib/db/context";
import { listUserIds } from "../lib/db/queries/admin";
import { findIdleThreads } from "../lib/db/queries/chat";
import { closeStaleSessions, DEFAULT_IDLE_DAYS } from "../lib/jobs/close-stale-sessions";

export interface CliArgs {
  idleDays: number;
  dryRun: boolean;
}

/**
 * Parse CLI argv into typed options for the close-stale-sessions sweep.
 * Pure function — no I/O; safe to unit-test in isolation.
 *
 * Supported flags:
 *   --idle-days=N   positive integer, default DEFAULT_IDLE_DAYS
 *   --dry-run       boolean flag
 */
export function parseArgs(argv: string[]): CliArgs {
  let idleDays = DEFAULT_IDLE_DAYS;
  let dryRun = false;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else {
      const match = arg.match(/^--idle-days=(\d+)$/);
      if (match) {
        const n = Number.parseInt(match[1], 10);
        if (n > 0) idleDays = n;
      }
    }
  }

  return { idleDays, dryRun };
}

async function main() {
  if (process.env.DISABLE_JOBS === "1") {
    console.log("DISABLE_JOBS=1 — skipping stale-session sweep.");
    return;
  }

  const { idleDays, dryRun } = parseArgs(process.argv.slice(2));

  if (dryRun) {
    // Mirror the real sweep's scope iteration: NULL single-owner set + every user.
    const scopes: (string | null)[] = [null, ...listUserIds()];
    console.log(`[dry-run] idle-days=${idleDays} scopes=${scopes.length}`);
    let total = 0;
    for (const userId of scopes) {
      await runWithUserScope(userId, () => {
        const candidates = findIdleThreads(idleDays);
        total += candidates.length;
        for (const t of candidates) {
          console.log(`  - ${t.id}  (scope: ${userId ?? "owner"}, last activity: ${t.updatedAt})`);
        }
      });
    }
    if (total === 0) console.log("[dry-run] No stale sessions found — nothing to close.");
    else console.log(`[dry-run] Would close ${total} thread(s).`);
    console.log("[dry-run] No changes made.");
    return;
  }

  console.log(`Running stale-session sweep (idle-days=${idleDays})…`);
  const result = await closeStaleSessions({ idleDays });

  console.log("\nDone.");
  console.log(`  Scopes:    ${result.scopesSwept.length} (owner + registered users)`);
  console.log(`  Closed:    ${result.closedCount}`);
  console.log(`  Extracted: ${result.extractedCount} durable fact(s)`);
  console.log(`  Purged:    ${result.purgedCount} expired deleted thread(s)`);
  if (result.closedThreadIds.length > 0) {
    console.log("  Thread IDs:");
    for (const id of result.closedThreadIds) {
      console.log(`    - ${id}`);
    }
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
