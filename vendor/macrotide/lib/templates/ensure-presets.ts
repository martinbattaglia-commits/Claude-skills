// Idempotent, non-destructive seeding of the factory template presets.
//
// This is the ONLY path that lands shipped templates in a real database. Unlike
// the demo/dev reseed (`lib/mock/seed.ts`), it never wipes anything: it inserts
// only the presets a DB is missing and leaves every existing row — built-in or
// user/owner fork — untouched. Safe to run on every boot and against a
// production DB full of real data.
//
// Reconciliation policy is ADDITIVE-ONLY:
//   - A preset whose id already exists is skipped (so an owner who edited a
//     built-in keeps their edit; we never overwrite).
//   - A preset id listed in the `presets_hidden` tombstone is skipped (so an
//     owner who removed a built-in does not get it resurrected on the next
//     boot). The owner-curation path (issue #25) writes that tombstone; until
//     it ships, nothing can populate it, so this is forward-compatible.
//   - New presets in a later release are inserted on the next boot. Existing
//     presets are never modified or deleted here.
import { eq } from "drizzle-orm";
import type { AppDb } from "@/lib/db/context";
import { modelPortfolios, settings } from "@/lib/db/schema";
import type { ModelPortfolio } from "@/lib/static/types";
import { PRESETS_VERSION, TEMPLATE_PRESETS } from "./presets";

/** Settings key holding the highest PRESETS_VERSION reconciled into this DB. */
export const PRESETS_VERSION_KEY = "presets_version";
/** Settings key holding preset ids the instance owner has removed (string[]). */
export const PRESETS_HIDDEN_KEY = "presets_hidden";

/** Map a UI-shaped preset to a built-in `model_portfolios` insert row. */
function presetToRow(p: ModelPortfolio, now: string) {
  return {
    id: p.id,
    // Built-ins are null-owned on purpose: shared/readable by every user on the
    // instance, and excluded from per-user write scoping (read-only → fork).
    userId: null,
    name: p.name,
    tagline: p.tagline || null,
    blurb: p.blurb || null,
    builtIn: true,
    allocation: p.mix,
    expectedReturn: p.expectedReturn,
    expectedVolatility: p.expectedVol,
    ter: p.ter,
    horizon: p.horizon || null,
    risk: p.risk,
    pros: p.pros,
    cons: p.cons,
    createdAt: now,
  };
}

export interface EnsurePresetsResult {
  /** Ids inserted this run (empty when everything was already present). */
  inserted: string[];
  /** The presets version recorded after this run. */
  version: number;
}

/**
 * Ensure every factory preset exists as a built-in model portfolio, without
 * touching existing rows. Takes an explicit app.db handle so it can run at boot
 * (before any request context exists) and from a standalone CLI/job.
 */
export function ensureTemplatePresets(db: AppDb): EnsurePresetsResult {
  const existing = new Set(
    db
      .select({ id: modelPortfolios.id })
      .from(modelPortfolios)
      .all()
      .map((r) => r.id),
  );

  const hiddenRow = db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, PRESETS_HIDDEN_KEY))
    .get();
  const hidden = new Set<string>((hiddenRow?.value as string[] | undefined) ?? []);

  const now = new Date().toISOString();
  const inserted: string[] = [];
  for (const preset of TEMPLATE_PRESETS) {
    if (existing.has(preset.id) || hidden.has(preset.id)) continue;
    db.insert(modelPortfolios)
      .values(presetToRow(preset, now))
      // Belt-and-suspenders against a race: a concurrent boot may have just
      // inserted the same id. Never clobber.
      .onConflictDoNothing()
      .run();
    inserted.push(preset.id);
  }

  db.insert(settings)
    .values({ key: PRESETS_VERSION_KEY, value: PRESETS_VERSION })
    .onConflictDoUpdate({ target: settings.key, set: { value: PRESETS_VERSION } })
    .run();

  return { inserted, version: PRESETS_VERSION };
}
