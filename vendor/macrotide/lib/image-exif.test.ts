import exifr from "exifr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readExifCapture } from "./image-exif";

vi.mock("exifr", () => ({ default: { parse: vi.fn() } }));

const parse = vi.mocked(exifr.parse);
// The File is opaque to readExifCapture (it just hands it to exifr, which we
// mock), so a bare object stands in.
const FILE = new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" });

describe("readExifCapture", () => {
  beforeEach(() => parse.mockReset());

  it("combines DateTimeOriginal with its own offset into a true instant", async () => {
    parse.mockResolvedValue({
      DateTimeOriginal: "2026:06:08 14:32:10",
      OffsetTimeOriginal: "+07:00",
    });
    expect(await readExifCapture(FILE)).toEqual({
      capturedAt: "2026-06-08T14:32:10+07:00",
      source: "exif",
    });
  });

  it("normalizes an offset without a colon", async () => {
    parse.mockResolvedValue({
      DateTimeOriginal: "2026:06:08 14:32:10",
      OffsetTimeOriginal: "+0900",
    });
    expect(await readExifCapture(FILE)).toEqual({
      capturedAt: "2026-06-08T14:32:10+09:00",
      source: "exif",
    });
  });

  it("assumes Asia/Bangkok when wall time has no offset", async () => {
    parse.mockResolvedValue({ DateTimeOriginal: "2026:06:08 14:32:10" });
    expect(await readExifCapture(FILE)).toEqual({
      capturedAt: "2026-06-08T14:32:10+07:00",
      source: "exif-assumed-tz",
    });
  });

  it("returns null when there is no DateTimeOriginal (e.g. a screenshot)", async () => {
    parse.mockResolvedValue({ Make: "Acme" });
    expect(await readExifCapture(FILE)).toBeNull();
  });

  it("returns null when exifr yields nothing (no EXIF block)", async () => {
    parse.mockResolvedValue(undefined);
    expect(await readExifCapture(FILE)).toBeNull();
  });

  it("returns null on a malformed DateTimeOriginal", async () => {
    parse.mockResolvedValue({ DateTimeOriginal: "not a date" });
    expect(await readExifCapture(FILE)).toBeNull();
  });
});
