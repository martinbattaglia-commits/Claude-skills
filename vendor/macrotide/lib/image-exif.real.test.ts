import { describe, expect, it } from "vitest";
import { readExifCapture } from "./image-exif";

// Integration coverage against the REAL exifr (no module mock here, unlike
// image-exif.test.ts): unreadable / EXIF-less input must degrade to null —
// exercising the catch branch and the "no DateTimeOriginal" guard end-to-end —
// rather than throwing out of readExifCapture.
describe("readExifCapture — real exifr, EXIF-less input", () => {
  it("returns null for a tiny non-image buffer", async () => {
    const garbage = new File([new Uint8Array([1, 2, 3, 4])], "x.png", { type: "image/png" });
    expect(await readExifCapture(garbage)).toBeNull();
  });

  it("returns null for an empty file", async () => {
    const empty = new File([new Uint8Array([])], "y.jpg", { type: "image/jpeg" });
    expect(await readExifCapture(empty)).toBeNull();
  });
});
