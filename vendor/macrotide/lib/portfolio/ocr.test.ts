import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the AI SDK so the test never reaches OpenRouter. The mock is a
// hoisted-safe factory; per-test behavior is configured via `mockImpl`.
const mockImpl = {
  // Default impl returns an empty transcription. Each test overrides via
  // `mockImpl.text = ...` or `mockImpl.throw = ...`.
  text: "",
  throw: null as Error | null,
};

// Per-call mock so tests can stage a sequence of responses (primary fails →
// fallback succeeds). Each call shifts the queue; falls back to `text` /
// `throw` when the queue is empty.
const callQueue: Array<{ text?: string; throw?: Error }> = [];

// A successful generateText result also carries usage + the served model id (the
// real SDK shape) so the extractors' onUsage metering can read them.
const usageShape = {
  usage: { inputTokens: 100, outputTokens: 20 },
  response: { modelId: "m-test" },
};

vi.mock("ai", () => ({
  generateText: vi.fn(async () => {
    const next = callQueue.shift();
    if (next) {
      if (next.throw) throw next.throw;
      return { text: next.text ?? "", ...usageShape };
    }
    if (mockImpl.throw) throw mockImpl.throw;
    return { text: mockImpl.text, ...usageShape };
  }),
}));

// Also stub the OpenRouter provider factory so we don't import the real
// transport (which expects a real apiKey configured for fetch).
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => (modelId: string) => ({ modelId })),
}));

import {
  dateFromFilename,
  deriveRow,
  extractHoldingsFromImage,
  extractStructuredHoldings,
  isAllowedMimeType,
  OcrProviderUnavailableError,
  parseClassification,
  parseExtractedRows,
  sniffImageMime,
} from "./ocr";

const FAKE_KEY = "sk-or-test";

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = FAKE_KEY;
  mockImpl.text = "";
  mockImpl.throw = null;
  callQueue.length = 0;
});

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OCR_MODELS;
});

describe("isAllowedMimeType", () => {
  it("accepts JPG, PNG, WebP only", () => {
    expect(isAllowedMimeType("image/jpeg")).toBe(true);
    expect(isAllowedMimeType("image/png")).toBe(true);
    expect(isAllowedMimeType("image/webp")).toBe(true);
    expect(isAllowedMimeType("image/gif")).toBe(false);
    expect(isAllowedMimeType("application/pdf")).toBe(false);
    expect(isAllowedMimeType("")).toBe(false);
  });
});

describe("extractHoldingsFromImage", () => {
  const fakeImage = { data: Buffer.from([0xff, 0xd8, 0xff]), mimeType: "image/jpeg" };

  it("returns the model's transcription verbatim (trimmed)", async () => {
    mockImpl.text = "  K-WORLDX  12,485.6213 units  ฿261,857\n  K-FIXED-A  15,820 units\n  ";
    const result = await extractHoldingsFromImage(fakeImage);
    expect(result.text).toBe("K-WORLDX  12,485.6213 units  ฿261,857\n  K-FIXED-A  15,820 units");
  });

  it("returns empty text when the model produces nothing readable", async () => {
    mockImpl.text = "";
    const result = await extractHoldingsFromImage(fakeImage);
    expect(result).toEqual({ text: "" });
  });

  it("returns empty text on schema/parse failures (model ran but output was unusable)", async () => {
    // AI_NoObjectGeneratedError-style errors and other "model failed" reasons
    // are explicitly classified as NOT provider errors → empty result, no throw.
    mockImpl.throw = new Error("NoObjectGeneratedError: model returned freeform text");
    const result = await extractHoldingsFromImage(fakeImage);
    expect(result).toEqual({ text: "" });
  });

  it("throws OcrProviderUnavailableError on AI SDK transport errors with the provider's message", async () => {
    const transportErr = Object.assign(new Error("Provider returned error"), {
      name: "AI_APICallError",
      responseBody: JSON.stringify({
        error: { message: "No endpoints available matching your guardrail restrictions." },
      }),
    });
    mockImpl.throw = transportErr;
    await expect(extractHoldingsFromImage(fakeImage)).rejects.toBeInstanceOf(
      OcrProviderUnavailableError,
    );
    await expect(extractHoldingsFromImage(fakeImage)).rejects.toThrow(/guardrail/);
  });

  it("prefers the OpenRouter metadata.raw message when wrapped in AI_RetryError → AI_APICallError", async () => {
    const transportErr = Object.assign(new Error("Failed after 3 attempts"), {
      name: "AI_RetryError",
      lastError: Object.assign(new Error("Provider returned error"), {
        name: "AI_APICallError",
        responseBody: JSON.stringify({
          error: {
            message: "Provider returned error",
            metadata: {
              raw: "google/gemma-4-31b-it:free is temporarily rate-limited upstream.",
            },
          },
        }),
      }),
    });
    mockImpl.throw = transportErr;
    await expect(extractHoldingsFromImage(fakeImage)).rejects.toThrow(/rate-limited upstream/);
  });

  it("throws when OPENROUTER_API_KEY is missing (caller decides 503 vs stub)", async () => {
    delete process.env.OPENROUTER_API_KEY;
    await expect(extractHoldingsFromImage(fakeImage)).rejects.toThrow(/OPENROUTER_API_KEY/);
  });
});

describe("usage metering (onUsage)", () => {
  const fakeImage = { data: Buffer.from([0xff, 0xd8, 0xff]), mimeType: "image/jpeg" };

  it("reports the model call's token usage + served id so the route can meter spend", async () => {
    const seen: Array<{ inputTokens: number; outputTokens: number; modelId: string | null }> = [];
    await extractStructuredHoldings(fakeImage, { onUsage: (u) => seen.push(u) });
    expect(seen).toEqual([{ inputTokens: 100, outputTokens: 20, modelId: "m-test" }]);
  });

  it("fires once per model call — primary failure + fallback = two reports", async () => {
    callQueue.push({
      throw: Object.assign(new Error("Failed"), {
        name: "AI_APICallError",
        responseBody: JSON.stringify({ error: { message: "rate-limited upstream" } }),
      }),
    });
    callQueue.push({ text: "[]" });
    process.env.OCR_MODELS = "a/primary,b/fallback";
    const seen: number[] = [];
    await extractStructuredHoldings(fakeImage, { onUsage: () => seen.push(1) });
    // Primary threw before reporting usage; only the successful fallback reports.
    expect(seen).toHaveLength(1);
  });
});

describe("extractHoldingsFromImage — primary/fallback chain", () => {
  const fakeImage = { data: Buffer.from([0xff, 0xd8, 0xff]), mimeType: "image/jpeg" };
  const providerErr = () =>
    Object.assign(new Error("Failed after 3 attempts"), {
      name: "AI_RetryError",
      lastError: Object.assign(new Error("Provider returned error"), {
        name: "AI_APICallError",
        responseBody: JSON.stringify({
          error: {
            message: "Provider returned error",
            metadata: { raw: "qianfan-ocr-fast:free is rate-limited upstream." },
          },
        }),
      }),
    });

  it("uses the fallback when the default primary hits a provider error", async () => {
    // No OCR_MODELS pinned → default primary + default fallback chain applies.
    // Queue: primary fails, fallback succeeds.
    callQueue.push({ throw: providerErr() });
    callQueue.push({ text: "K-WORLDX 12485 units" });
    const result = await extractHoldingsFromImage(fakeImage);
    expect(result.text).toBe("K-WORLDX 12485 units");
  });

  it("does NOT auto-fallback when the operator pins a single-model OCR_MODELS (respects intent)", async () => {
    process.env.OCR_MODELS = "openai/gpt-5-nano";
    callQueue.push({ throw: providerErr() });
    await expect(extractHoldingsFromImage(fakeImage)).rejects.toBeInstanceOf(
      OcrProviderUnavailableError,
    );
  });

  it("honors a second model in the OCR_MODELS chain as the fallback", async () => {
    process.env.OCR_MODELS = "openai/gpt-5-nano,anthropic/claude-haiku-4.5";
    callQueue.push({ throw: providerErr() });
    callQueue.push({ text: "AAPL 10 shares" });
    const result = await extractHoldingsFromImage(fakeImage);
    expect(result.text).toBe("AAPL 10 shares");
  });

  it("surfaces the FALLBACK's error when both attempts fail (operator needs to see the no-train safety net broke)", async () => {
    callQueue.push({ throw: providerErr() });
    callQueue.push({
      throw: Object.assign(new Error("Insufficient credits"), {
        name: "AI_APICallError",
        responseBody: JSON.stringify({ error: { message: "Insufficient credits" } }),
      }),
    });
    await expect(extractHoldingsFromImage(fakeImage)).rejects.toThrow(/Insufficient credits/);
  });
});

describe("parseExtractedRows", () => {
  it("parses a clean JSON array", () => {
    const rows = parseExtractedRows(
      '[{"ticker":"SCBSP500-A","units":1250.5,"nav":18.4521,"avgCost":16.203}]',
    );
    expect(rows).toEqual([{ ticker: "SCBSP500-A", units: 1250.5, nav: 18.4521, avgCost: 16.203 }]);
  });

  it("strips markdown fences and leading prose", () => {
    const rows = parseExtractedRows(
      'Here you go:\n```json\n[{"ticker":"K-USA-A(A)","value":14465}]\n```',
    );
    expect(rows).toEqual([{ ticker: "K-USA-A(A)", value: 14465 }]);
  });

  it("cleans ฿, commas, %, and + signs left in numeric strings", () => {
    const rows = parseExtractedRows(
      '[{"ticker":"TLFVMR-ASIAX","value":"฿719,193.85","pl":"+150,470.57"}]',
    );
    expect(rows[0]).toEqual({ ticker: "TLFVMR-ASIAX", value: 719193.85, pl: 150470.57 });
  });

  it("keeps negative P/L", () => {
    const rows = parseExtractedRows('[{"ticker":"KF-LATAM","pl":"-5,998.74"}]');
    expect(rows[0].pl).toBe(-5998.74);
  });

  it("omits fields the model could not read (no guessed zeros)", () => {
    const rows = parseExtractedRows('[{"ticker":"KT-BOND","value":101235.19}]');
    expect(rows[0]).toEqual({ ticker: "KT-BOND", value: 101235.19 });
    expect(rows[0].units).toBeUndefined();
  });

  it("drops rows without a ticker and returns [] for junk", () => {
    expect(parseExtractedRows('[{"units":100},{"ticker":""}]')).toEqual([]);
    expect(parseExtractedRows("not json at all")).toEqual([]);
    expect(parseExtractedRows("")).toEqual([]);
  });
});

describe("deriveRow", () => {
  it("derives units from value and market NAV, flagging estimated", () => {
    const row = deriveRow({ ticker: "K-GOLD-A(A)", value: 646151.62, pl: 137993.6 }, 100);
    expect(row.units).toBeCloseTo(6461.5162, 3);
    expect(row.estimated).toBe(true);
    expect(row.needsUnits).toBe(false);
    // Facts-only: carry the invested TOTAL (value − pl) as a fact, never a fabricated
    // per-unit avg cost (that would freeze a NAV-derived figure — it derives at the fold).
    expect(row.costTotal).toBeCloseTo(646151.62 - 137993.6, 2);
    expect(row.avgCost).toBeUndefined();
  });

  it("prefers the NAV printed on the image over market NAV", () => {
    const row = deriveRow({ ticker: "X-A", value: 1000, nav: 20 }, 999);
    expect(row.nav).toBe(20);
    expect(row.units).toBe(50);
  });

  it("does not overwrite values the image already showed", () => {
    const row = deriveRow(
      { ticker: "Y-A", units: 500, nav: 28.93, avgCost: 30.12, value: 14465 },
      28.93,
    );
    expect(row.estimated).toBe(false);
    expect(row.units).toBe(500);
    expect(row.avgCost).toBe(30.12);
  });

  it("flags needsUnits when no NAV is available", () => {
    const row = deriveRow({ ticker: "Z-A", value: 5000 }, undefined);
    expect(row.units).toBeUndefined();
    expect(row.needsUnits).toBe(true);
  });

  it("defaults the quoteSource to custom — the catalog overlay (in derive-rows) decides", () => {
    // deriveRow is pure + catalog-free: no shape guessing. deriveRowsWithNav overlays
    // the real catalog source, so a real fund reads as a Thai fund there, not here.
    expect(deriveRow({ ticker: "K-FIXED-A", units: 1 }, undefined).quoteSource).toBe("manual");
    expect(deriveRow({ ticker: "AAPL", units: 1 }, undefined).quoteSource).toBe("manual");
  });

  it("rounds derived units to 4 dp and carries the invested total as a fact", () => {
    // value 1000 ÷ NAV 7 = 142.857142857… → 142.8571 (no fabricated precision).
    // Cost rides as the invested TOTAL (value − pl = 900), NOT a per-unit avg cost.
    const row = deriveRow({ ticker: "EXAMPLE-FUND-A", value: 1000, pl: 100 }, 7);
    expect(row.units).toBe(142.8571);
    expect(row.costTotal).toBe(900);
    expect(row.avgCost).toBeUndefined();
    // never a raw 15-digit float
    expect(String(row.units)).not.toMatch(/\d{6,}/);
  });

  it("reads an invested cost TOTAL directly when the image shows it", () => {
    // costTotal printed on the row → kept verbatim (not recomputed from pl).
    const row = deriveRow({ ticker: "EXAMPLE-FUND-A", value: 1000, costTotal: 880 }, 7);
    expect(row.costTotal).toBe(880);
    expect(row.avgCost).toBeUndefined();
  });

  it("leaves cost unknown when neither P/L nor an invested total is shown", () => {
    // No way to know the cost basis from value alone — don't assume zero gain.
    const row = deriveRow({ ticker: "EXAMPLE-FUND-A", value: 1000 }, 7);
    expect(row.costTotal).toBeUndefined();
    expect(row.avgCost).toBeUndefined();
  });
});

describe("dateFromFilename", () => {
  it("parses a packed YYYYMMDD date from a screenshot name", () => {
    expect(dateFromFilename("Screenshot_20260530_134416_iFund.jpg")).toBe("2026-05-30");
  });
  it("parses a dashed / underscored YYYY-MM-DD date", () => {
    expect(dateFromFilename("port-2026-05-30.png")).toBe("2026-05-30");
    expect(dateFromFilename("2026_05_30 export.jpg")).toBe("2026-05-30");
  });
  it("ignores a trailing time block and other digit runs", () => {
    // 134416 (a time) must not be read as a date; only the 2026-prefixed run is.
    expect(dateFromFilename("Screenshot_20260530_134416.jpg")).toBe("2026-05-30");
  });
  it("rejects an implausible month/day and a name with no date", () => {
    expect(dateFromFilename("20261345.jpg")).toBeNull(); // month 13
    expect(dateFromFilename("holdings.jpg")).toBeNull();
  });
});

describe("parseClassification", () => {
  it("reads a clean JSON verdict with confidence + asOf", () => {
    expect(
      parseClassification('{"docType":"transactions","confidence":"high","asOf":"2026-03-16"}'),
    ).toEqual({ docType: "transactions", confidence: "high", asOf: "2026-03-16" });
    expect(parseClassification('{"docType":"holdings","confidence":"high","asOf":null}')).toEqual({
      docType: "holdings",
      confidence: "high",
      asOf: null,
    });
  });

  it("tolerates surrounding prose / code fences", () => {
    expect(
      parseClassification(
        'Here is the result:\n```json\n{"docType":"transactions","confidence":"low","asOf":"2025-12-22"}\n```',
      ),
    ).toEqual({ docType: "transactions", confidence: "low", asOf: "2025-12-22" });
  });

  it("defaults confidence/asOf to low/null when missing, rejects a non-ISO asOf", () => {
    expect(parseClassification('{"docType":"transactions"}')).toEqual({
      docType: "transactions",
      confidence: "low",
      asOf: null,
    });
    expect(
      parseClassification('{"docType":"holdings","confidence":"high","asOf":"30 May 2026"}'),
    ).toEqual({ docType: "holdings", confidence: "high", asOf: null });
  });

  it("falls back to a low-confidence guess when there is no usable JSON", () => {
    // Keyword scan still routes, but never claims high confidence.
    expect(parseClassification("this looks like a transaction history")).toEqual({
      docType: "transactions",
      confidence: "low",
      asOf: null,
    });
    expect(parseClassification("garbage")).toEqual({
      docType: "holdings",
      confidence: "low",
      asOf: null,
    });
  });
});

describe("sniffImageMime", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

  it("detects the real type from magic bytes", () => {
    expect(sniffImageMime(jpeg)).toBe("image/jpeg");
    expect(sniffImageMime(png)).toBe("image/png");
    expect(sniffImageMime(webp)).toBe("image/webp");
  });

  it("rejects non-image / mislabeled payloads", () => {
    expect(sniffImageMime(Buffer.from("GIF89a-not-allowed", "utf8"))).toBeNull();
    expect(sniffImageMime(Buffer.from("%PDF-1.7 disguised as image", "utf8"))).toBeNull();
    expect(sniffImageMime(Buffer.from("<svg>...</svg>", "utf8"))).toBeNull();
    expect(sniffImageMime(Buffer.from([0xff, 0xd8]))).toBeNull(); // too short
  });
});
