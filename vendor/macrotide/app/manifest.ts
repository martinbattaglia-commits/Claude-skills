import type { MetadataRoute } from "next";

// Web app manifest — makes Macrotide installable (Add to Home Screen / Install
// app) and launch standalone. Next serves this at /manifest.webmanifest and
// injects the <link rel="manifest"> automatically.
//
// No splash/launch images here on purpose: Android derives its launch screen
// from background_color + the icon; iOS would need explicit
// apple-touch-startup-image PNGs, which we skip (the app boots fast enough that
// a blank launch frame is fine).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Macrotide",
    short_name: "Macrotide",
    description: "An honest mirror for your index portfolio.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f8f8f9", // app's light --bg (Android launch screen; no theme variant)
    theme_color: "#111110",
    categories: ["finance"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
