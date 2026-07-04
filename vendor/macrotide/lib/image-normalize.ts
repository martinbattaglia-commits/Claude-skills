"use client";

// Shared client-side image normalization for everything we hand to the vision
// model — the Advisor chat AND the Add-to-portfolio importer. Both call the SAME
// model (google/gemini-2.5-flash), so they send the SAME image: resized to a
// 2048px longest side and re-encoded as JPEG 0.8.
//
// Why these numbers: the model reads detail from 768px tiles, so 2048px is
// plenty to resolve dense Thai fund tables while bounding tile/token cost; real
// phone screenshots are already ≈2048, so it's effectively lossless for them.
// JPEG 0.8 keeps digits crisp (a compression artifact must not flip an 8→3) while
// trimming upload + storage size. The ORIGINAL bytes are returned too, for a
// readable full-resolution in-app preview (kept in memory, never uploaded/stored).

export const IMG_MAX_DIM = 2048;
export const IMG_JPEG_QUALITY = 0.8;

export interface NormalizedImage {
  /** Resized JPEG as a data URL — sent to the model, shown as a thumbnail, stored. */
  dataUrl: string;
  /** Resized JPEG as a Blob — for multipart upload (the import route). */
  blob: Blob;
  /** Original bytes as a data URL — for a full-res preview (in memory only). */
  fullDataUrl: string;
  mime: string;
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string) ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Resize `file` to ≤ IMG_MAX_DIM on its longest side and re-encode as JPEG at
 * IMG_JPEG_QUALITY. Falls back to the original bytes if the image can't be
 * decoded (e.g. SVG / a decode failure) so the caller still gets something to
 * send.
 */
export async function normalizeImage(file: File): Promise<NormalizedImage> {
  const fullDataUrl = await readAsDataUrl(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new window.Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode failed"));
      el.src = fullDataUrl;
    });
    const scale = Math.min(1, IMG_MAX_DIM / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", IMG_JPEG_QUALITY);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
        "image/jpeg",
        IMG_JPEG_QUALITY,
      ),
    );
    return { dataUrl, blob, fullDataUrl, mime: "image/jpeg" };
  } catch {
    // Couldn't decode/resize — send the original bytes as-is.
    return { dataUrl: fullDataUrl, blob: file, fullDataUrl, mime: file.type || "image/png" };
  }
}
