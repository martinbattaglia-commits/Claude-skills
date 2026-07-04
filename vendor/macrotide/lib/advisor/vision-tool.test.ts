import type { ToolSet } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock generateText so examine_image's executor doesn't hit the network — we
// only assert which model it routed to and that usage is reported. `tool` and
// types are kept from the real module.
const generateTextMock = vi.fn();
vi.mock("ai", async (orig) => ({
  ...(await orig<typeof import("ai")>()),
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

import { createVisionTools, extractTurnImages, stripDriverImages } from "./vision-tool";

// "Hello" base64 → bytes, as a JPEG data URL the client would send.
const HELLO_B64 = Buffer.from("Hello").toString("base64");
const dataUrl = (b64 = HELLO_B64, mime = "image/jpeg") => `data:${mime};base64,${b64}`;
const imgPart = (b64?: string, mime?: string) => ({
  type: "file",
  mediaType: mime ?? "image/jpeg",
  url: dataUrl(b64, mime),
});
const userMsg = (parts: unknown[]) => ({ role: "user", parts });

describe("extractTurnImages", () => {
  it("decodes a data-URL image part to bytes + mimeType", () => {
    const imgs = extractTurnImages([userMsg([{ type: "text", text: "hi" }, imgPart()])]);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].mimeType).toBe("image/jpeg");
    expect(imgs[0].data.toString()).toBe("Hello");
  });

  it("reads only the LATEST message's images", () => {
    const imgs = extractTurnImages([
      userMsg([imgPart()]),
      { role: "assistant", parts: [{ type: "text", text: "ok" }] },
      userMsg([{ type: "text", text: "now this" }]),
    ]);
    expect(imgs).toHaveLength(0);
  });

  it("collects multiple images in order", () => {
    const imgs = extractTurnImages([
      userMsg([
        imgPart(Buffer.from("A").toString("base64")),
        imgPart(Buffer.from("B").toString("base64")),
      ]),
    ]);
    expect(imgs.map((i) => i.data.toString())).toEqual(["A", "B"]);
  });

  it("ignores non-image parts and empty/non-data urls", () => {
    expect(extractTurnImages([userMsg([{ type: "text", text: "no images" }])])).toEqual([]);
    expect(
      extractTurnImages([
        userMsg([{ type: "file", mediaType: "image/png", url: "https://x/y.png" }]),
      ]),
    ).toEqual([]);
  });
});

describe("stripDriverImages", () => {
  it("removes image file parts but keeps text", () => {
    const out = stripDriverImages([userMsg([{ type: "text", text: "hi" }, imgPart()])] as never);
    const last = out[out.length - 1] as { parts: { type: string }[] };
    expect(last.parts).toHaveLength(1);
    expect(last.parts[0].type).toBe("text");
  });

  it("returns the same array when there are no image parts", () => {
    const msgs = [userMsg([{ type: "text", text: "hi" }])] as never;
    expect(stripDriverImages(msgs)).toBe(msgs);
  });
});

describe("createVisionTools › examine_image", () => {
  const VISION = "CHEAP-MODEL" as never;
  const ESCALATE = "PRO-MODEL" as never;
  const oneImage = [{ data: Buffer.from("img"), mimeType: "image/jpeg" }];

  beforeEach(() => {
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      text: "observation",
      usage: { inputTokens: 10, outputTokens: 5 },
      response: { modelId: "served-id" },
    });
  });

  type ExecTool = { execute: (input: unknown, opts: unknown) => Promise<{ observation: string }> };
  const run = (tools: ToolSet, input: unknown) =>
    (tools.examine_image as unknown as ExecTool).execute(input, {});

  it("routes a normal question to the cheap vision model and reports usage", async () => {
    const onUsage = vi.fn();
    const tools = createVisionTools({ images: oneImage, vision: VISION, onUsage });
    const out = await run(tools, { question: "what is my biggest holding?" });
    expect(out.observation).toBe("observation");
    expect(generateTextMock.mock.calls[0][0].model).toBe(VISION);
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 10,
      outputTokens: 5,
      modelId: "served-id",
    });
  });

  it("escalates a chart question to the stronger model when one is provided", async () => {
    const tools = createVisionTools({ images: oneImage, vision: VISION, escalate: ESCALATE });
    await run(tools, { question: "what trend does this performance chart show?" });
    expect(generateTextMock.mock.calls[0][0].model).toBe(ESCALATE);
  });

  it("never escalates when escalate is null (public/demo invariant)", async () => {
    const tools = createVisionTools({ images: oneImage, vision: VISION, escalate: null });
    await run(tools, { question: "what trend does this chart show?" });
    expect(generateTextMock.mock.calls[0][0].model).toBe(VISION);
  });

  it("does NOT escalate a plain table question even with escalate available", async () => {
    const tools = createVisionTools({ images: oneImage, vision: VISION, escalate: ESCALATE });
    await run(tools, { question: "what is the value of fund ABC?" });
    expect(generateTextMock.mock.calls[0][0].model).toBe(VISION);
  });

  it("selects a single image by 1-based index", async () => {
    const imgs = [
      { data: Buffer.from("A"), mimeType: "image/jpeg" },
      { data: Buffer.from("B"), mimeType: "image/jpeg" },
    ];
    const tools = createVisionTools({ images: imgs, vision: VISION });
    await run(tools, { question: "read it", imageIndex: 2 });
    const content = generateTextMock.mock.calls[0][0].messages[0].content;
    const imageParts = content.filter((p: { type: string }) => p.type === "image");
    expect(imageParts).toHaveLength(1);
    expect((imageParts[0].image as Buffer).toString()).toBe("B");
  });

  it("examines ALL images when no index is given (multi-image reconciliation)", async () => {
    const imgs = [
      { data: Buffer.from("A"), mimeType: "image/jpeg" },
      { data: Buffer.from("B"), mimeType: "image/jpeg" },
    ];
    const tools = createVisionTools({ images: imgs, vision: VISION });
    await run(tools, { question: "reconcile these" });
    const content = generateTextMock.mock.calls[0][0].messages[0].content;
    expect(content.filter((p: { type: string }) => p.type === "image")).toHaveLength(2);
  });

  it("returns a friendly note (no model call) when there are no images", async () => {
    const tools = createVisionTools({ images: [], vision: VISION });
    const out = await run(tools, { question: "read it" });
    expect(out.observation).toMatch(/no image/i);
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});
