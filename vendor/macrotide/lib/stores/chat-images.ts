"use client";

// Browser-only cache of images a user attached to chat turns. Images are NEVER
// stored server-side (the chat route persists only a "[N image(s) attached]"
// text marker — see SECURITY.md); this keeps downscaled copies in localStorage
// so the user can still see what they uploaded after a reload, within their own
// browser. Bounded by a total-size budget with oldest-first eviction so it can't
// grow without limit or blow the ~5 MB localStorage quota.
//
// Entries are keyed by `${threadId}:${seq}`, where `seq` is the 0-based index of
// the user message within its thread. Both the send path and the reload path can
// compute that index deterministically (user messages are append-only), so the
// images re-attach to the right turn without needing the server's message id.

export interface ChatImage {
  /** Stable id for React keys (lists support removal/reorder). */
  id: string;
  /** Downscaled data URL (image/jpeg) — sent to the model and shown as a thumbnail. */
  dataUrl: string;
  /**
   * The ORIGINAL full-resolution data URL, for the lightbox so the user can
   * actually read the screenshot. Kept in memory only — NOT persisted (too big
   * for the localStorage budget), so it's absent after a reload (lightbox then
   * falls back to the downscaled `dataUrl`).
   */
  fullDataUrl?: string;
  /**
   * The vision model's reading of this image, captured from the examine_image
   * tool's observation on the turn it was attached (NOT a separate transcription
   * call). Carried in the conversation so a later turn can reference the image as
   * cheap text instead of re-sending the bytes. Small → persisted.
   */
  transcript?: string;
  /**
   * The image's capture time (ISO with offset) — a hint for the snapshot's
   * as-of date, sent to the model. Parsed from EXIF when present, else the
   * file's last-modified time.
   */
  capturedAt?: string;
  /**
   * Where {@link capturedAt} came from: parsed EXIF, EXIF wall-time assumed
   * Asia/Bangkok (no offset tag), or the file's mtime. Lets the model-facing
   * note say "taken" vs "saved" honestly. Persisted in the slim copy.
   */
  capturedAtSource?: "exif" | "exif-assumed-tz" | "file";
  mime: string;
  name: string;
}

const KEY = "macrotide_chat_images_v1";
// Keep well under the typical 5 MB localStorage quota — downscaled JPEGs are
// ~30–120 KB each, so this holds a healthy backlog while leaving room for other
// app state.
const BUDGET_BYTES = 3_500_000;

interface Entry {
  ts: number;
  images: ChatImage[];
}
type Store = Record<string, Entry>;

function readStore(): Store {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  if (typeof window === "undefined") return;
  // Evict oldest entries until the serialized payload fits the budget.
  let serialized = JSON.stringify(store);
  if (serialized.length > BUDGET_BYTES) {
    const byAge = Object.entries(store).sort((a, b) => a[1].ts - b[1].ts);
    while (serialized.length > BUDGET_BYTES && byAge.length > 0) {
      const [oldestKey] = byAge.shift() as [string, Entry];
      delete store[oldestKey];
      serialized = JSON.stringify(store);
    }
  }
  try {
    window.localStorage.setItem(KEY, serialized);
  } catch {
    // Quota or privacy mode — drop silently; images are a best-effort nicety.
  }
}

const composeKey = (threadId: string, seq: number) => `${threadId}:${seq}`;

/** Persist the images attached to one user turn. No-op for an empty set. */
export function saveChatImages(threadId: string, seq: number, images: ChatImage[]): void {
  if (!threadId || images.length === 0) return;
  const store = readStore();
  // Persist the downscaled copies only — strip the full-res original (kept in
  // memory for the lightbox) so it never blows the localStorage budget.
  const slim = images.map(({ fullDataUrl: _full, ...rest }) => rest);
  store[composeKey(threadId, seq)] = { ts: Date.now(), images: slim };
  writeStore(store);
}

/**
 * Load every stored image set for a thread, keyed by the user-message `seq`.
 * Used on thread reload to re-attach thumbnails to the right turns.
 */
export function loadChatThreadImages(threadId: string): Map<number, ChatImage[]> {
  const out = new Map<number, ChatImage[]>();
  if (!threadId) return out;
  const store = readStore();
  const prefix = `${threadId}:`;
  for (const [key, entry] of Object.entries(store)) {
    if (!key.startsWith(prefix)) continue;
    const seq = Number(key.slice(prefix.length));
    if (Number.isInteger(seq)) out.set(seq, entry.images);
  }
  return out;
}
