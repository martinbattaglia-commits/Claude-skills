// Suggested cash-account Purpose labels (#149) — a few curated objectives offered in the
// Label combobox alongside whatever the user has already used. Just suggestions; the field
// is free text. Order: the user's own labels first, then these presets, deduped.

export const CASH_PURPOSE_PRESETS = [
  "Emergency",
  "House",
  "Retirement",
  "Travel",
  "Education",
  "Tax",
  "Car",
] as const;

/** Merge the user's already-used labels with the curated presets (used first, deduped, case-insensitive). */
export function mergeCashPurposes(used: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...used, ...CASH_PURPOSE_PRESETS]) {
    const v = (raw ?? "").trim();
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out;
}
