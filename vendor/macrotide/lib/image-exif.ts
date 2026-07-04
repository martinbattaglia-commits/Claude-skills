// Read an image's EXIF capture time so the Advisor (and the importer) can date a
// holdings snapshot from when the photo was actually taken, not when the file was
// last touched. We parse two tags and combine them deterministically:
//   - DateTimeOriginal  ("YYYY:MM:DD HH:MM:SS") — local wall-clock, no timezone.
//   - OffsetTimeOriginal ("+07:00")            — the camera's UTC offset, if set.
// With the offset we get a true instant. Without it (common — many phones omit
// it), we interpret the wall time as Asia/Bangkok (this app's home zone) and
// flag that assumption so callers can phrase it honestly.
//
// IMPORTANT: read from the ORIGINAL File. lib/image-normalize.ts re-encodes
// through a canvas, which strips all EXIF — so the truer time is only on the
// bytes the user picked, never on the normalized copy.

import exifr from "exifr";

export interface ExifCapture {
  /** True capture instant, ISO-8601 with offset (e.g. 2026-06-08T14:32:00+07:00). */
  capturedAt: string;
  /** `exif` when the image carried its own offset; `exif-assumed-tz` when we assumed +07:00. */
  source: "exif" | "exif-assumed-tz";
}

// Default offset when an image records wall time but no OffsetTimeOriginal.
// Asia/Bangkok is fixed at +07:00 year-round (no DST), so a literal is safe.
const BANGKOK_OFFSET = "+07:00";

// "YYYY:MM:DD HH:MM:SS" (EXIF's colon-separated date) → "YYYY-MM-DDTHH:MM:SS".
function exifWallToIsoLocal(raw: string): string | null {
  const m = raw.trim().match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

// Normalize an offset tag to "+HH:MM" / "-HH:MM" / "Z". Returns null if unusable.
function normalizeOffset(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t === "Z" || t === "+00:00") return "Z";
  const m = t.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!m) return null;
  return `${m[1]}${m[2]}:${m[3]}`;
}

/**
 * Parse EXIF capture time from an image File. Returns `null` when the image has
 * no DateTimeOriginal (most PNG screenshots) — the caller then falls back to
 * `file.lastModified`. `reviveValues: false` keeps exifr from reviving the date
 * in the runtime's local zone (which would silently shift the instant); we
 * combine the raw strings ourselves.
 */
export async function readExifCapture(file: File): Promise<ExifCapture | null> {
  let tags: Record<string, unknown> | undefined;
  try {
    tags = (await exifr.parse(file, {
      reviveValues: false,
      pick: ["DateTimeOriginal", "OffsetTimeOriginal"],
    })) as Record<string, unknown> | undefined;
  } catch {
    return null; // Unreadable / no EXIF block — fall back to file mtime.
  }
  const wall = typeof tags?.DateTimeOriginal === "string" ? tags.DateTimeOriginal : null;
  if (!wall) return null;
  const isoLocal = exifWallToIsoLocal(wall);
  if (!isoLocal) return null;

  const offset = normalizeOffset(tags?.OffsetTimeOriginal);
  if (offset) {
    return { capturedAt: `${isoLocal}${offset}`, source: "exif" };
  }
  // Wall time only — assume the app's home zone and say so.
  return { capturedAt: `${isoLocal}${BANGKOK_OFFSET}`, source: "exif-assumed-tz" };
}
