import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composeAttachmentNote,
  countTurnImages,
  isDemoVisionEnabled,
  turnHasImages,
  type VisionPath,
  visionDecisionFor,
  withImageMarker,
} from "./image-turn";

const uiText = (role: string, text: string) => ({ role, parts: [{ type: "text", text }] });
const uiImage = (text: string, n: number) => ({
  role: "user",
  parts: [
    { type: "text", text },
    ...Array.from({ length: n }, () => ({
      type: "file",
      mediaType: "image/png",
      url: "data:image/png;base64,AAAA",
    })),
  ],
});

describe("countTurnImages / turnHasImages", () => {
  it("counts image file parts on the latest UIMessage", () => {
    const messages = [uiText("user", "hi"), uiText("assistant", "hello"), uiImage("look", 2)];
    expect(countTurnImages(messages)).toBe(2);
    expect(turnHasImages(messages)).toBe(true);
  });

  it("ignores non-image file parts", () => {
    const messages = [
      {
        role: "user",
        parts: [
          { type: "text", text: "doc" },
          { type: "file", mediaType: "application/pdf", url: "data:application/pdf;base64,AA" },
        ],
      },
    ];
    expect(countTurnImages(messages)).toBe(0);
    expect(turnHasImages(messages)).toBe(false);
  });

  it("only inspects the LATEST message", () => {
    const messages = [uiImage("old", 3), uiText("user", "new text only")];
    expect(countTurnImages(messages)).toBe(0);
  });

  it("returns 0 for text-only ModelMessage[] (string content)", () => {
    const messages = [{ role: "user", content: "plain text" }];
    expect(countTurnImages(messages)).toBe(0);
  });

  it("detects image parts in ModelMessage content[] (defensive)", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "x" },
          { type: "image", image: "..." },
        ],
      },
    ];
    expect(countTurnImages(messages)).toBe(1);
  });

  it("handles an empty conversation", () => {
    expect(countTurnImages([])).toBe(0);
  });
});

describe("withImageMarker", () => {
  it("appends a pluralized marker to existing text", () => {
    expect(withImageMarker("here", 1)).toBe("here\n\n[1 image attached]");
    expect(withImageMarker("here", 3)).toBe("here\n\n[3 images attached]");
  });

  it("is the marker alone for an image-only turn", () => {
    expect(withImageMarker("", 2)).toBe("[2 images attached]");
  });

  it("leaves text-only turns unchanged", () => {
    expect(withImageMarker("just text", 0)).toBe("just text");
  });
});

describe("composeAttachmentNote", () => {
  // 2026-06-08T07:32Z = 14:32:00 in Asia/Bangkok (+07:00).
  const ISO = "2026-06-08T07:32:00Z";

  it("emits the EXIF capture time as Bangkok ISO-8601 (machine-parseable)", () => {
    const note = composeAttachmentNote(
      [{ name: "stmt.jpg", capturedAt: ISO, capturedAtSource: "exif" }],
      1,
    );
    expect(note).toBe(
      '(Attached file: "stmt.jpg" taken 2026-06-08T14:32:00+07:00)\n\n[1 image attached]',
    );
  });

  it("labels a file-mtime time 'saved …' rather than 'taken'", () => {
    const note = composeAttachmentNote(
      [{ name: "shot.png", capturedAt: ISO, capturedAtSource: "file" }],
      1,
    );
    expect(note).toContain('"shot.png" saved 2026-06-08T14:32:00+07:00');
  });

  it("treats exif-assumed-tz as 'taken' (assumption is conveyed elsewhere)", () => {
    const note = composeAttachmentNote(
      [{ name: "a.jpg", capturedAt: ISO, capturedAtSource: "exif-assumed-tz" }],
      1,
    );
    expect(note).toContain('"a.jpg" taken 2026-06-08T14:32:00+07:00');
  });

  it("CONVERTS a non-Bangkok instant to +07:00, not just relabels it", () => {
    // Taken 14:32 in Tokyo (+09:00) = 12:32 in Bangkok. A naive append would
    // wrongly print 14:32+07:00; a real conversion prints 12:32+07:00.
    const note = composeAttachmentNote(
      [{ name: "tokyo.jpg", capturedAt: "2026-06-08T14:32:00+09:00", capturedAtSource: "exif" }],
      1,
    );
    expect(note).toContain('"tokyo.jpg" taken 2026-06-08T12:32:00+07:00');
  });

  it("rolls the date when the conversion crosses midnight", () => {
    // 23:00 UTC on Jun 8 → 06:00 on Jun 9 in Bangkok.
    const note = composeAttachmentNote(
      [{ name: "late.jpg", capturedAt: "2026-06-08T23:00:00Z", capturedAtSource: "exif" }],
      1,
    );
    expect(note).toContain('"late.jpg" taken 2026-06-09T06:00:00+07:00');
  });

  it("omits the clause for an item with no capture time", () => {
    const note = composeAttachmentNote([{ name: "x.png" }], 1);
    expect(note).toBe('(Attached file: "x.png")\n\n[1 image attached]');
  });

  it("joins multiple files and pluralizes the marker", () => {
    const note = composeAttachmentNote(
      [{ name: "a.jpg", capturedAt: ISO, capturedAtSource: "exif" }, { name: "b.png" }],
      2,
    );
    expect(note).toBe(
      '(Attached files: "a.jpg" taken 2026-06-08T14:32:00+07:00; "b.png")\n\n[2 images attached]',
    );
  });
});

describe("visionDecisionFor", () => {
  const paths: VisionPath[] = ["demo", "tiered", "owner"];

  it("routes text turns to 'text' on every path", () => {
    for (const p of paths) {
      expect(visionDecisionFor(p, false, { visionReady: true, demoVisionEnabled: true })).toBe(
        "text",
      );
    }
  });

  it("owner/tiered image turns: vision when ready, stub when disabled", () => {
    for (const p of ["tiered", "owner"] as VisionPath[]) {
      expect(visionDecisionFor(p, true, { visionReady: true, demoVisionEnabled: false })).toBe(
        "vision",
      );
      expect(visionDecisionFor(p, true, { visionReady: false, demoVisionEnabled: false })).toBe(
        "stub",
      );
    }
  });

  it("demo image turns stub unless DEMO_VISION is enabled AND vision is ready", () => {
    expect(visionDecisionFor("demo", true, { visionReady: true, demoVisionEnabled: false })).toBe(
      "stub",
    );
    expect(visionDecisionFor("demo", true, { visionReady: false, demoVisionEnabled: true })).toBe(
      "stub",
    );
    expect(visionDecisionFor("demo", true, { visionReady: true, demoVisionEnabled: true })).toBe(
      "vision",
    );
  });
});

describe("isDemoVisionEnabled", () => {
  const saved = process.env.DEMO_VISION;
  beforeEach(() => {
    delete process.env.DEMO_VISION;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.DEMO_VISION;
    else process.env.DEMO_VISION = saved;
  });

  it("defaults to false when unset", () => {
    expect(isDemoVisionEnabled()).toBe(false);
  });

  it.each(["on", "1", "true", "YES", " On "])("is true for %j", (v) => {
    process.env.DEMO_VISION = v;
    expect(isDemoVisionEnabled()).toBe(true);
  });

  it.each(["off", "0", "false", ""])("is false for %j", (v) => {
    process.env.DEMO_VISION = v;
    expect(isDemoVisionEnabled()).toBe(false);
  });
});
