import { toNextJsHandler } from "better-auth/next-js";
import { AUTH_RATE_LIMIT, clientIp, rateLimit } from "@/lib/api/rate-limit";
import { auth } from "@/lib/auth";
import { verifyTurnstile } from "@/lib/auth/turnstile";

const handlers = toNextJsHandler(auth);

// Account-creation paths that the Turnstile signup gate protects. better-auth
// routes everything under /api/auth/*; we only gate the path that mints a new
// account directly. OAuth (`/sign-in/social`) is deliberately NOT gated: that
// POST only generates a redirect to the provider's consent screen — no account
// is minted until the callback, after the provider has authenticated the user
// (the provider's own bot defenses are the real gate). Redirect spam is covered
// by the IP rate limit above.
function isGatedSignupPath(url: string): boolean {
  const path = new URL(url).pathname;
  return path.endsWith("/sign-up/email");
}

export const GET = handlers.GET;

export async function POST(req: Request): Promise<Response> {
  const ip = clientIp(req);

  // Abuse defense: IP-keyed rate limit on every auth POST.
  const rl = rateLimit(ip, AUTH_RATE_LIMIT);
  if (!rl.ok) {
    return Response.json(
      { error: "rate_limited", message: "Too many auth attempts. Try again shortly." },
      { status: 429, headers: { "retry-after": String(Math.ceil(rl.resetMs / 1000)) } },
    );
  }

  // Signup gate: verify the Turnstile token on email account-creation. The
  // browser sends it via the `x-turnstile-token` header so we don't consume the
  // request body the handler needs. Bypassed in dev (no secret).
  if (isGatedSignupPath(req.url)) {
    const token = req.headers.get("x-turnstile-token");
    const ok = await verifyTurnstile(token, ip);
    if (!ok) {
      return Response.json(
        { error: "turnstile_failed", message: "Bot-protection check failed. Please retry." },
        { status: 403 },
      );
    }
  }

  return handlers.POST(req);
}
