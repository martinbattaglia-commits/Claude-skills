// Userscript-manager catalog for the import install step. Pure data + a tiny
// UA sniff (client-safe — no `navigator` access at module load; pass the UA in).
// These are third-party manager apps (not the broker), so naming them is fine.

export type DeviceOS = "ios" | "android" | "desktop";

export interface UserscriptApp {
  name: string;
  /** Store / download page. */
  url: string;
  /** One-line note (browser it pairs with, caveats). */
  note: string;
}

/**
 * Coarse OS bucket from a UA string (+ optional touch-point count). Defaults to
 * desktop. iPadOS — and an iPhone set to "Request Desktop Website" — report a plain
 * desktop Mac UA with no `iPad`/`Mobile` token, so a Mac UA that also reports touch
 * points (a real Mac has 0; iPad/iPhone report 5) is treated as iOS. Pass
 * `navigator.maxTouchPoints` for that; the UA-only path still catches devices that
 * do carry a mobile token.
 */
export function detectOS(ua: string, maxTouchPoints = 0): DeviceOS {
  const s = ua.toLowerCase();
  const macWithTouch = /macintosh/.test(s) && (maxTouchPoints > 1 || /mobile/.test(s));
  if (/iphone|ipad|ipod/.test(s) || macWithTouch) return "ios";
  if (/android/.test(s)) return "android";
  return "desktop";
}

// First entry per OS is the recommended one.
export const USERSCRIPT_APPS: Record<DeviceOS, UserscriptApp[]> = {
  desktop: [
    {
      name: "Tampermonkey",
      url: "https://www.tampermonkey.net/",
      note: "Chrome / Dia / Arc / Edge / Firefox — the most common manager.",
    },
    {
      name: "Violentmonkey",
      url: "https://violentmonkey.github.io/",
      note: "Open-source alternative; same browsers.",
    },
  ],
  ios: [
    {
      name: "Gear Browser",
      url: "https://apps.apple.com/app/id1458962238",
      note: "Standalone browser with a built-in userscript engine — log in once inside it.",
    },
    {
      name: "Userscripts (by quoid)",
      url: "https://apps.apple.com/app/id1463298887",
      note: "Free Safari extension; auto-runs on the broker page in Safari.",
    },
    {
      name: "Stay",
      url: "https://apps.apple.com/app/id1591620171",
      note: "Paid Safari userscript manager.",
    },
  ],
  android: [
    {
      name: "Firefox + Violentmonkey",
      url: "https://addons.mozilla.org/android/addon/violentmonkey/",
      note: "Most reliable on Android — install the add-on in Firefox.",
    },
    {
      name: "Edge + Tampermonkey",
      url: "https://www.tampermonkey.net/",
      note: "Edge for Android supports extensions.",
    },
    {
      name: "Quetta + Tampermonkey",
      url: "https://www.quetta.net/",
      note: "Chromium browser with Chrome Web Store extensions.",
    },
  ],
};

export const OS_LABEL: Record<DeviceOS, string> = {
  desktop: "desktop",
  ios: "iPhone / iPad",
  android: "Android",
};

// Recent Chromium needs userscripts explicitly enabled, or scripts silently
// don't run. Surface this next to the install step.
export const ENABLE_NOTE =
  'Chrome / Dia / Arc / Edge 138+ need "Allow User Scripts" turned on in the ' +
  "extension's settings (or Developer Mode at chrome://extensions).";
