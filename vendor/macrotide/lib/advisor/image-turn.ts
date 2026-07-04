// Helpers for image-bearing chat turns, kept out of the streaming route handler
// so the policy is unit-testable. The chat route (app/api/chat/route.ts) detects
// whether the latest turn carries attached images, decides how to route it, and
// records a marker in the persisted user message (images are never stored
// server-side — only this text marker; see SECURITY.md).

// Max image attachments Advisor reads in one message. Enforced in BOTH places:
// the composer truncates to this and tells the user (so a multi-file pick isn't
// silently dropped), and the chat route rejects an over-limit turn as a backstop
// (a client that bypasses the cap, or a future non-browser caller). One source of
// truth so the two can't drift. The ceiling bounds per-turn vision tile/token cost
// — for a larger batch of holdings screenshots, the Add to portfolio → Images importer
// has no per-turn cap. Lives here (no "use client") so client + server share it.
export const MAX_CHAT_ATTACHMENTS = 10;

/** The over-limit refusal copy, shared by the composer and the route backstop. */
export function attachmentLimitMessage(attempted: number): string {
  return (
    `Advisor reads up to ${MAX_CHAT_ATTACHMENTS} images per message — you attached ${attempted}. ` +
    `Please remove ${attempted - MAX_CHAT_ATTACHMENTS} and send again, or use Add to portfolio → Images ` +
    `to import a larger batch at once.`
  );
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}

/**
 * True for an AI SDK v6 UIMessage image file part: `{ type:'file',
 * mediaType:'image/…', url }`. The single definition of "an attached image",
 * shared by the turn counters here and the byte extractor in vision-tool.ts so
 * the two can't drift.
 */
export function isImageFilePart(part: unknown): boolean {
  if (!isObj(part)) return false;
  const mediaType = part.mediaType;
  return part.type === "file" && typeof mediaType === "string" && mediaType.startsWith("image/");
}

/**
 * Count image attachments on the LATEST message of an incoming chat payload.
 * Handles both shapes the client may send: UIMessages with `parts[]` (the image
 * path) and ModelMessages with `content[]` (defensive — a server-built image
 * part is `{ type:'image' }`). Text-only turns return 0.
 */
export function countTurnImages(messages: readonly unknown[]): number {
  const last = messages[messages.length - 1];
  if (!isObj(last)) return 0;
  if (Array.isArray(last.parts)) return last.parts.filter(isImageFilePart).length;
  if (Array.isArray(last.content)) {
    return last.content.filter((p) => isObj(p) && p.type === "image").length;
  }
  return 0;
}

/** True when the latest turn carries at least one attached image. */
export function turnHasImages(messages: readonly unknown[]): boolean {
  return countTurnImages(messages) > 0;
}

/**
 * Persisted content for an image turn. Images aren't stored on the server, so we
 * keep the user's text plus a `[N image(s) attached]` marker so a reloaded thread
 * reads coherently. Text-only turns (count 0) are returned unchanged.
 */
export function withImageMarker(text: string, imageCount: number): string {
  if (imageCount <= 0) return text;
  const marker = `[${imageCount} image${imageCount === 1 ? "" : "s"} attached]`;
  return text ? `${text}\n\n${marker}` : marker;
}

/** One attachment's facts for the model-facing note. Mirrors ChatAttachmentMeta. */
export interface AttachmentNoteItem {
  name: string;
  /** ISO-8601 instant with offset; absent when no capture time is known. */
  capturedAt?: string;
  capturedAtSource?: "exif" | "exif-assumed-tz" | "file";
}

// Convert an ISO instant to an Asia/Bangkok ISO-8601 string,
// "YYYY-MM-DDTHH:MM:SS+07:00". This CONVERTS the instant (a photo's native
// offset is shifted to Bangkok, rolling the date when needed) — it is not a
// naive offset relabel. The zone is fixed (+07:00, no DST) so the literal
// suffix is always correct. The note is model-only, so a machine-parseable ISO
// is preferred over a humanized form. Precedent: lib/portfolio/adapter.ts tz fmt.
function bangkokIso(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  // en-CA renders 24h "24:05" at midnight in some engines; normalize 24 → 00.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${date}T${hour}:${get("minute")}:${get("second")}+07:00`;
}

/**
 * Compose the model-facing attachment note for an image turn — the line the
 * Advisor sees (NOT the displayed user bubble) so it can date a holdings
 * snapshot from the photo when the image itself shows no date. Built fresh at
 * model-build time from structured metadata and never persisted, so
 * `chat_messages.content` stays raw user text.
 *
 * Per item: the file name, plus a capture clause — `taken …` for an EXIF time,
 * `saved …` for a file mtime, nothing when no time is known. Times are emitted
 * as Asia/Bangkok ISO-8601 (`…+07:00`) — machine-parseable, since this string
 * is model-only and never user-visible. The shared `[N images attached]` marker
 * is appended (reusing {@link withImageMarker}'s wording).
 */
export function composeAttachmentNote(items: AttachmentNoteItem[], imageCount: number): string {
  const listed = items
    .map((it) => {
      const when = it.capturedAt ? bangkokIso(it.capturedAt) : null;
      if (!when) return `"${it.name}"`;
      const verb = it.capturedAtSource === "file" ? "saved" : "taken";
      return `"${it.name}" ${verb} ${when}`;
    })
    .join("; ");
  const note = listed ? `(Attached file${items.length === 1 ? "" : "s"}: ${listed})` : "";
  // Reuse withImageMarker so the "[N images attached]" wording has one home.
  return withImageMarker(note, imageCount);
}

export type VisionPath = "demo" | "tiered" | "owner";
export type VisionDecision = "text" | "vision" | "stub";

/**
 * Decide how to handle a turn:
 *   - no images → `text` (the existing text chat paths, unchanged).
 *   - images, but vision unavailable for this path → `stub` (the route serves a
 *     friendly message pointing at the Add-to-portfolio image importer).
 *   - images + available → `vision`.
 *
 * `visionReady` is the path-appropriate vision provider's readiness (demo uses
 * the demo-flavored provider). `demoVisionEnabled` reflects the `DEMO_VISION`
 * opt-in flag and only gates the demo path.
 */
export function visionDecisionFor(
  path: VisionPath,
  hasImages: boolean,
  opts: { visionReady: boolean; demoVisionEnabled: boolean },
): VisionDecision {
  if (!hasImages) return "text";
  if (path === "demo" && !opts.demoVisionEnabled) return "stub";
  return opts.visionReady ? "vision" : "stub";
}

/** Read the `DEMO_VISION` opt-in flag (default off). */
export function isDemoVisionEnabled(): boolean {
  const v = process.env.DEMO_VISION?.trim().toLowerCase();
  return v === "on" || v === "1" || v === "true" || v === "yes";
}
