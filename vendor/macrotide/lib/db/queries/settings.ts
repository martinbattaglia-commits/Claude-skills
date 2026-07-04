import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "../context";
import { settings } from "../schema";

export function getSetting<T = unknown>(key: string): T | undefined {
  const row = getDb().select().from(settings).where(eq(settings.key, key)).get();
  return row?.value as T | undefined;
}

export function setSetting(key: string, value: unknown): void {
  getDb()
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value },
    })
    .run();
}

export function listSettings(): Array<{ key: string; value: unknown }> {
  return getDb().select().from(settings).all();
}

export function deleteSetting(key: string): void {
  getDb().delete(settings).where(eq(settings.key, key)).run();
}
