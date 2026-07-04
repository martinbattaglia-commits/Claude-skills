import { NextResponse } from "next/server";
import { clientIp, type RateLimitConfig, rateLimit } from "@/lib/api/rate-limit";
import { withDb } from "@/lib/api/with-db";
import { getMarketNews } from "@/lib/market/news";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NEWS_RATE_LIMIT: RateLimitConfig = {
  scope: "market-news",
  // Results are 30-min cached server-side; per-IP this is generous.
  limit: 30,
  windowMs: 60_000,
};

export async function GET(req: Request) {
  const ip = clientIp(req);
  const rl = rateLimit(ip, NEWS_RATE_LIMIT);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", retryAfterMs: rl.resetMs },
      {
        status: 429,
        headers: { "Retry-After": Math.ceil(rl.resetMs / 1000).toString() },
      },
    );
  }

  // Wrap in withDb for consistency with the rest of /api/* per AGENTS.md, even
  // though this route is read-only and never touches getDb().
  return withDb(async () => {
    const news = await getMarketNews();
    return NextResponse.json(news);
  });
}
