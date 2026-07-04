import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";

const HOUR_MS = 3600_000;
const DAY_MS = 86_400_000;

export async function backupIfStale(
  sqlite: Database.Database,
  { maxAgeHours = 24, retentionDays = 30 }: { maxAgeHours?: number; retentionDays?: number } = {},
): Promise<string | null> {
  const dir = path.join(path.dirname(sqlite.name), "backups");
  await mkdir(dir, { recursive: true });

  const existing = (await readdir(dir)).filter((f) => f.endsWith(".db")).sort();
  const newest = existing.at(-1);
  if (newest) {
    const newestStat = await stat(path.join(dir, newest));
    if (Date.now() - newestStat.mtimeMs < maxAgeHours * HOUR_MS) return null;
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-");
  const target = path.join(dir, `app-${stamp}.db`);
  await sqlite.backup(target);

  const cutoff = Date.now() - retentionDays * DAY_MS;
  for (const f of existing) {
    const p = path.join(dir, f);
    const s = await stat(p);
    if (s.mtimeMs < cutoff) await unlink(p);
  }

  return target;
}
