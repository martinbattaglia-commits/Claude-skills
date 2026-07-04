import { NextResponse } from "next/server";
import { enabledProviders } from "@/lib/auth/providers";
import { turnstileConfigured, turnstileSiteKey } from "@/lib/auth/turnstile";

/**
 * Public, non-secret auth front-door config for the /login client.
 * Tells the page which OAuth buttons to render and whether to show the
 * Turnstile widget (and with which PUBLIC site key). Never exposes secrets.
 *
 * Lives outside /api/auth/* so the better-auth catch-all doesn't claim it.
 */
export function GET() {
  return NextResponse.json({
    providers: enabledProviders(),
    turnstile: {
      enabled: turnstileConfigured(),
      siteKey: turnstileSiteKey(),
    },
  });
}
