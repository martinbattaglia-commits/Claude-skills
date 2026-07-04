import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { clientIp, type RateLimitConfig, rateLimit } from "@/lib/api/rate-limit";
import { DEMO_COOKIE } from "@/lib/api/with-db";
import { dropDemoSession, getOrCreateDemoSession } from "@/lib/db/demo";

const COOKIE_MAX_AGE = 60 * 60 * 24; // 24h; demo data is in-memory and TTL'd separately

// Each POST materializes a fresh in-memory DB + seed (real CPU/memory) and, at
// the 200-session cap, evicts the oldest session. Throttle creation so a flood
// can't churn the store or evict legitimate demo visitors (#191).
const DEMO_RATE_LIMIT: RateLimitConfig = {
  scope: "demo-create",
  limit: 5,
  windowMs: 60_000,
};

/**
 * Start a new demo session. Creates an isolated in-memory SQLite seeded with
 * mock data and sets a cookie so subsequent requests route to it.
 */
export async function POST(req: Request) {
  const rl = rateLimit(clientIp(req), DEMO_RATE_LIMIT);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", retryAfterMs: rl.resetMs },
      { status: 429, headers: { "Retry-After": Math.ceil(rl.resetMs / 1000).toString() } },
    );
  }
  const id = randomUUID();
  // Materialize the session synchronously so the first page render after
  // setting the cookie finds an existing DB instead of racing the factory.
  getOrCreateDemoSession(id);
  // The session id is the httpOnly cookie's job — don't also echo it in the body.
  const res = NextResponse.json({ ok: true });
  res.cookies.set(DEMO_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
  return res;
}

/**
 * End the active demo session — clears the cookie and drops the in-memory DB.
 * Idempotent.
 */
export async function DELETE(req: Request) {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`${DEMO_COOKIE}=([^;]+)`));
  if (match) dropDemoSession(match[1]);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(DEMO_COOKIE);
  return res;
}
