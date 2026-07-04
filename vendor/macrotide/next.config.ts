import path from "node:path";
import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Browsers honor this on top of OS-level permission prompts. Camera/mic/
  // geolocation aren't used today; passkey ("publickey-credentials-*") is.
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
  },
  // HSTS only meaningful behind HTTPS; production reverse proxy (Caddy) sets
  // its own, but we set a conservative one here too.
  { key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep the dev-tools indicator in the bottom-right corner (out of the way of
  // the app's top-left nav and bottom-left content).
  devIndicators: {
    position: "bottom-right",
  },
  turbopack: {
    root: __dirname,
  },
  outputFileTracingRoot: path.join(__dirname),
  outputFileTracingExcludes: {
    "/*": ["data/**/*"],
  },
  // Dev-only escape hatch: trust one extra origin when the dev server is reached
  // through a reverse proxy or remote host (Codespaces, a LAN IP, a tunnel, etc.)
  // instead of plain localhost. Set DEV_ALLOWED_ORIGIN in .env.local. No effect on
  // prod builds. See .env.example.
  allowedDevOrigins: process.env.DEV_ALLOWED_ORIGIN ? [process.env.DEV_ALLOWED_ORIGIN] : [],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
