"use client";

// Keep the runtime <meta name="theme-color"> in step with the in-app theme so an
// installed PWA's status bar (Android) / chrome tint follows the light/dark
// toggle. The app's theme is data-theme/localStorage-driven and INDEPENDENT of
// the OS `prefers-color-scheme`, so OS-media-scoped theme-color tags never track
// it — the bar must be set imperatively here (and seeded by the no-flash script
// in app/layout.tsx so the first paint is already correct).

// The chrome/status-bar tint per resolved theme — the app's --bg in each mode.
const THEME_COLORS = { light: "#ffffff", dark: "#0c0d0f" } as const;

export type Theme = "light" | "dark" | "system";

function resolveDark(theme: Theme): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return (
    typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
}

export function syncThemeColor(theme: Theme): void {
  if (typeof document === "undefined") return;
  const color = resolveDark(theme) ? THEME_COLORS.dark : THEME_COLORS.light;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.setAttribute("content", color);
}
