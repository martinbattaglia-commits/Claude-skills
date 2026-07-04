import { NextResponse } from "next/server";
import {
  clientIp,
  globalRateLimit,
  OCR_GLOBAL_RATE_LIMIT,
  type RateLimitConfig,
  rateLimit,
} from "@/lib/api/rate-limit";
import { withDb } from "@/lib/api/with-db";
import {
  extractTransactionRows,
  isAllowedMimeType,
  OcrProviderUnavailableError,
  sniffImageMime,
} from "@/lib/portfolio/ocr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

// Same budget defense as the holdings image OCR: OCR hits the OpenRouter free
// tier, so cap per IP / minute. A new unthrottled vision endpoint would regress
// that defense.
const TXN_OCR_RATE_LIMIT: RateLimitConfig = {
  scope: "import-transactions-image",
  limit: 10,
  windowMs: 60_000,
};

function badRequest(message: string) {
  return NextResponse.json({ error: "bad_request", message }, { status: 400 });
}

export async function POST(req: Request) {
  const ip = clientIp(req);
  const rl = rateLimit(ip, TXN_OCR_RATE_LIMIT);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", retryAfterMs: rl.resetMs },
      { status: 429, headers: { "Retry-After": Math.ceil(rl.resetMs / 1000).toString() } },
    );
  }
  // Process-wide OCR ceiling — see lib/api/rate-limit.ts.
  const breaker = globalRateLimit(OCR_GLOBAL_RATE_LIMIT);
  if (!breaker.ok) {
    return NextResponse.json(
      { error: "rate_limited", retryAfterMs: breaker.resetMs },
      { status: 429, headers: { "Retry-After": Math.ceil(breaker.resetMs / 1000).toString() } },
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
  if (file.size === 0) return badRequest("Uploaded file is empty.");
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

  // Trust the file's magic bytes over the client-declared MIME.
  const sniffed = sniffImageMime(buffer);
  if (!sniffed) {
    return badRequest("File contents are not a supported image (JPG, PNG, or WebP).");
  }

  // Returns raw transaction rows for the editable confirmation table; the client
  // normalizes kind/date and the user reviews before anything saves. The image
  // is never persisted. (withDb keeps any incidental read on the right app.db,
  // matching the holdings OCR route.)
  return withDb(async () => {
    try {
      const rows = await extractTransactionRows({ data: buffer, mimeType: sniffed });
      return NextResponse.json({ rows }, { status: 200 });
    } catch (err) {
      if (err instanceof OcrProviderUnavailableError) {
        return NextResponse.json(
          { error: "provider_unavailable", message: err.message },
          { status: 502 },
        );
      }
      throw err;
    }
  });
}
