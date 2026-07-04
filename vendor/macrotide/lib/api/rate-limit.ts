import "server-only";

/**
 * Lightweight IP-keyed sliding window rate limiter. Pure in-memory — fine for
 * single-process deploys; if we ever go multi-instance we'll swap this for
 * Upstash or a Redis adapter.
 */

interface Bucket {
  count: number;
  windowStart: number;
}

const globalForRl = globalThis as unknown as {
  __macrotideRateBuckets?: Map<string, Bucket>;
};

function buckets(): Map<string, Bucket> {
  if (!globalForRl.__macrotideRateBuckets) {
    globalForRl.__macrotideRateBuckets = new Map();
  }
  return globalForRl.__macrotideRateBuckets;
}

export interface RateLimitConfig {
  /** Max requests inside the window. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
  /** Key prefix so different routes don't collide on a shared IP. */
  scope: string;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetMs: number;
}

export function rateLimit(key: string, cfg: RateLimitConfig): RateLimitResult {
  const map = buckets();
  const id = `${cfg.scope}:${key}`;
  const now = Date.now();
  const existing = map.get(id);

  if (!existing || now - existing.windowStart >= cfg.windowMs) {
    map.set(id, { count: 1, windowStart: now });
    return { ok: true, remaining: cfg.limit - 1, resetMs: cfg.windowMs };
  }

  if (existing.count >= cfg.limit) {
    return {
      ok: false,
      remaining: 0,
      resetMs: existing.windowStart + cfg.windowMs - now,
    };
  }

  existing.count += 1;
  return {
    ok: true,
    remaining: cfg.limit - existing.count,
    resetMs: existing.windowStart + cfg.windowMs - now,
  };
}

/**
 * Extract a stable IP from request headers. Honors common reverse-proxy
 * headers (X-Forwarded-For, X-Real-IP, CF-Connecting-IP) and falls back to
 * a generic key when none are present. Trusts only the first hop — we
 * assume Caddy/nginx in front when deployed.
 */
export function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf;
  const xfwd = req.headers.get("x-forwarded-for");
  if (xfwd) return xfwd.split(",")[0]?.trim() ?? "unknown";
  const xreal = req.headers.get("x-real-ip");
  if (xreal) return xreal;
  return "local";
}

/**
 * Process-wide circuit breaker — an IP-INDEPENDENT ceiling on a class of
 * expensive operations per window. The per-IP limiter (`rateLimit`) can be
 * sidestepped by spoofing a forwarding header or spreading load across many IPs
 * / demo sessions; this is the backstop that bounds TOTAL paid spend. Keyed only
 * by scope, so every caller shares one global budget. Pairs with — does not
 * replace — the per-IP limit and the deny-by-default auth gate.
 */
export function globalRateLimit(cfg: RateLimitConfig): RateLimitResult {
  return rateLimit("__all__", cfg);
}

/**
 * Global OCR ceiling: total vision/OCR calls per minute across ALL callers,
 * bounding the owner's OpenRouter spend even if the per-IP limit is bypassed or
 * spread across demo sessions. Override with `OCR_GLOBAL_LIMIT_PER_MIN`.
 */
export const OCR_GLOBAL_RATE_LIMIT: RateLimitConfig = {
  scope: "ocr-global",
  limit: Number(process.env.OCR_GLOBAL_LIMIT_PER_MIN) || 60,
  windowMs: 60_000,
};

export const CHAT_RATE_LIMIT: RateLimitConfig = {
  scope: "chat",
  limit: 20,
  windowMs: 60_000, // 20 chat turns / minute / IP for owner; demo has its own 10/session cap
};

export const AUTH_RATE_LIMIT: RateLimitConfig = {
  scope: "auth",
  limit: 10,
  windowMs: 60_000, // 10 auth attempts / minute / IP
};
