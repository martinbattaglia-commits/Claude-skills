import { NextResponse } from "next/server";
import {
  clientIp,
  globalRateLimit,
  OCR_GLOBAL_RATE_LIMIT,
  type RateLimitConfig,
  rateLimit,
} from "@/lib/api/rate-limit";
import { withDb } from "@/lib/api/with-db";
import { getUserId } from "@/lib/db/context";
import {
  estimateCostMicros,
  getTier,
  isOverDailyCap,
  isOverDailyCostCap,
  recordUsage,
} from "@/lib/db/queries/usage";
import { deriveRowsWithNav } from "@/lib/portfolio/derive-rows";
import {
  classifyImportImage,
  extractStructuredHoldings,
  extractTransactionRows,
  type ImportDocType,
  isAllowedMimeType,
  OcrProviderUnavailableError,
  type OcrUsage,
  sniffImageMime,
} from "@/lib/portfolio/ocr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const IMAGE_OCR_RATE_LIMIT: RateLimitConfig = {
  scope: "import-image",
  // OCR calls hit the OpenRouter free tier — keep it modest per IP / minute.
  // 10/min still gives a real person ample retry budget.
  limit: 10,
  windowMs: 60_000,
};

interface ErrorBody {
  error: string;
  message?: string;
}

function badRequest(message: string): NextResponse<ErrorBody> {
  return NextResponse.json({ error: "bad_request", message }, { status: 400 });
}

export async function POST(req: Request) {
  const ip = clientIp(req);
  const rl = rateLimit(ip, IMAGE_OCR_RATE_LIMIT);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", retryAfterMs: rl.resetMs },
      {
        status: 429,
        headers: { "Retry-After": Math.ceil(rl.resetMs / 1000).toString() },
      },
    );
  }
  if (!process.env.OPENROUTER_API_KEY) {
    return NextResponse.json(
      {
        error: "ocr_unavailable",
        message:
          "Image OCR requires OPENROUTER_API_KEY. Set it in .env.local — see docs/reference/auth-and-providers.md.",
      },
      { status: 503 },
    );
  }

  // We use multipart/form-data so the browser can stream the file directly.
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return badRequest("Expected multipart/form-data with an 'image' field.");
  }

  const file = formData.get("image");
  if (!file || !(file instanceof File)) {
    return badRequest("Missing 'image' field — upload a JPG, PNG, or WebP file.");
  }

  if (file.size === 0) {
    return badRequest("Uploaded file is empty.");
  }

  if (file.size > MAX_BYTES) {
    return badRequest(
      `Image is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max ${MAX_BYTES / 1024 / 1024} MB.`,
    );
  }

  const mimeType = file.type || "application/octet-stream";
  if (!isAllowedMimeType(mimeType)) {
    return badRequest(`Unsupported file type "${mimeType}". Use JPG, PNG, or WebP.`);
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // Trust the file's magic bytes over the client-declared MIME — a mislabeled
  // or non-image payload is rejected here, and the sniffed type is what we hand
  // the model.
  const sniffed = sniffImageMime(buffer);
  if (!sniffed) {
    return badRequest("File contents are not a supported image (JPG, PNG, or WebP).");
  }

  // Optional caller override: when the auto-classifier was unsure and the user
  // explicitly picked a type, the client re-posts with `as` to skip detection.
  const asRaw = formData.get("as");
  const override: ImportDocType | null =
    asRaw === "holdings" || asRaw === "transactions" ? asRaw : null;

  // Process-wide OCR ceiling, charged PER MODEL CALL (not per request): the
  // detect-then-route path makes two calls (classify + extract); an override
  // skips classification → one. Consuming the right count keeps the breaker from
  // under-counting (the real model-call rate could otherwise run ~2× the cap).
  const plannedCalls = override ? 1 : 2;
  for (let i = 0; i < plannedCalls; i++) {
    const breaker = globalRateLimit(OCR_GLOBAL_RATE_LIMIT);
    if (!breaker.ok) {
      return NextResponse.json(
        { error: "rate_limited", retryAfterMs: breaker.resetMs },
        { status: 429, headers: { "Retry-After": Math.ceil(breaker.resetMs / 1000).toString() } },
      );
    }
  }

  // Filename + saved-at timestamp ride as CONTEXT for the model's as-of-date
  // call — a fallback only; a date shown in the image wins. We never parse the
  // filename ourselves.
  const fnameRaw = formData.get("filename");
  const capturedRaw = formData.get("capturedAt");
  const ctx = {
    filename: typeof fnameRaw === "string" ? fnameRaw : undefined,
    capturedAt: typeof capturedRaw === "string" ? capturedRaw : undefined,
  };

  // Detect-then-route: a screenshot is either a HOLDINGS SNAPSHOT (→ Starting
  // balances) or a TRANSACTION HISTORY (→ trade rows); the two need different
  // extractors. Classify first (unless overridden), then run the matching one.
  // Response carries `docType` + `confidence` so the client can confirm a
  // low-confidence guess with the user. The image is never persisted.
  return withDb(async () => {
    // Meter + cap the spend. An authenticated non-owner is gated by the same
    // daily token + cents caps as chat (owner = userId null → uncapped, like the
    // owner chat path; demo → null, bounded by the IP + global-breaker limits
    // above). The vision model here is the priciest paid path, so it must not be
    // the one unbudgeted route. Usage is recorded in `finally` so a call that
    // spent tokens before a later failure still counts.
    const userId = getUserId();
    if (userId !== null) {
      const tier = getTier(userId);
      if (isOverDailyCap(userId, tier) || isOverDailyCostCap(userId, tier)) {
        return NextResponse.json(
          {
            error: "daily_limit",
            message: "You've reached today's usage limit. It resets at midnight UTC.",
          },
          { status: 429, headers: { "x-daily-limit": "reached" } },
        );
      }
    }

    const acc = { input: 0, output: 0, costMicros: 0 };
    const onUsage = (u: OcrUsage) => {
      acc.input += u.inputTokens;
      acc.output += u.outputTokens;
      acc.costMicros += estimateCostMicros(u.modelId, u.inputTokens, u.outputTokens);
    };

    try {
      let docType: ImportDocType;
      let confidence: "high" | "low";
      let asOf: string | null = null;
      if (override) {
        docType = override;
        confidence = "high";
      } else {
        const c = await classifyImportImage({ data: buffer, mimeType: sniffed }, ctx, { onUsage });
        docType = c.docType;
        confidence = c.confidence;
        asOf = c.asOf;
      }

      if (docType === "transactions") {
        const transactions = await extractTransactionRows(
          { data: buffer, mimeType: sniffed },
          { onUsage },
        );
        return NextResponse.json({ docType, confidence, asOf, transactions }, { status: 200 });
      }

      const extracted = await extractStructuredHoldings(
        { data: buffer, mimeType: sniffed },
        { onUsage },
      );
      // Derive units/avgCost from the NAV on the snapshot's own date (#130),
      // falling back to the latest NAV (shared with the advisor's
      // propose_holdings_import tool — see lib/portfolio/derive-rows.ts).
      const holdings = deriveRowsWithNav(extracted, asOf ?? undefined);
      return NextResponse.json({ docType, confidence, asOf, holdings }, { status: 200 });
    } catch (err) {
      if (err instanceof OcrProviderUnavailableError) {
        return NextResponse.json(
          { error: "provider_unavailable", message: err.message },
          { status: 502 },
        );
      }
      throw err;
    } finally {
      // Record whatever was spent (no-op at 0). Owner/demo (null) aren't metered,
      // matching the chat owner path; the global breaker bounds them.
      if (userId !== null) recordUsage(userId, acc.input, acc.output, undefined, acc.costMicros);
    }
  });
}
