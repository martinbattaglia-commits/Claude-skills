// Per-worker test database isolation.
//
// lib/db/client.ts runs drizzle `migrate()` against process.env.DB_PATH and
// process.env.MARKET_DB_PATH (defaults data/app.db, data/market.db) at import
// time. Vitest runs test files across several worker processes; without
// isolation they all migrate the SAME files at once, and drizzle's migrator is
// not concurrency-safe — two workers each see zero applied migrations and both
// replay 0000, throwing "table `buckets` already exists". (Most suites use the
// in-memory freshDb helpers and are unaffected; the few that import the real
// client transitively are the ones that raced.)
//
// Giving each worker its own files makes the migrate idempotent per process and
// keeps tests from dirtying the repo's data/*.db. `??=` so explicitly set paths
// still win (e.g. when debugging against a specific file).
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workerId = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? "0";

// Only the files WE default into a temp path get cleaned up on exit — an
// explicitly-set DB_PATH (e.g. debugging against a real file) is left alone.
const ours: string[] = [];
function defaultToTemp(envVar: "DB_PATH" | "MARKET_DB_PATH", name: string): void {
  if (process.env[envVar]) return;
  const path = join(tmpdir(), `macrotide-test-${name}-${process.pid}-${workerId}.db`);
  process.env[envVar] = path;
  ours.push(path);
}

defaultToTemp("DB_PATH", "app");
defaultToTemp("MARKET_DB_PATH", "market");

// Remove the per-worker temp DBs (and their WAL sidecars — journal_mode=WAL is
// set in lib/db/client.ts) when the worker process exits, so repeated local
// runs don't accumulate stale files in the OS temp dir.
process.on("exit", () => {
  for (const path of ours) {
    for (const f of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        unlinkSync(f);
      } catch {
        // already gone (never opened, or removed by the OS) — nothing to do.
      }
    }
  }
});
