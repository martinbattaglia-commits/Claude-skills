import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, IBM_Plex_Sans_Thai } from "next/font/google";
import "./globals.css";

// Self-hosted via next/font: fonts ship with the build, same-origin, so first
// paint no longer waits on a render-blocking fonts.googleapis.com stylesheet.
// globals.css consumes these variables inside --font-sans / --font-mono.
const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });
const plexThai = IBM_Plex_Sans_Thai({
  subsets: ["thai", "latin"],
  weight: ["400", "500"],
  variable: "--font-plex-thai",
});
const fontVariables = `${geist.variable} ${geistMono.variable} ${plexThai.variable}`;

// Resolve absolute URLs for og:image / twitter:image. Without this, Next.js
// falls back to http://localhost:3000 in prod and social scrapers can't fetch
// the share image. Same env var the auth + AI provider layers already use.
export const metadata: Metadata = {
  metadataBase: new URL(process.env.PUBLIC_APP_URL ?? "http://localhost:3000"),
  title: "Macrotide - An honest mirror for your index portfolio",
  description:
    "Open-source AI companion for Thai index investors. See your funds in one place, know your blended fee, and chat with an advisor that knows your holdings. Proposes, never trades.",
  openGraph: {
    title: "Macrotide - An honest mirror for your index portfolio",
    description:
      "Open-source AI companion for Thai index investors. See your funds in one place, know your blended fee, and chat with an advisor that knows your holdings.",
    type: "website",
    siteName: "Macrotide",
    url: "/",
  },
  // No twitter-image.png: Twitter/X falls back to og:image (set via the
  // app/opengraph-image.png file convention). We still declare the card type
  // so it renders the large preview instead of the default small summary.
  twitter: {
    card: "summary_large_image",
  },
  // Installed-PWA behavior on iOS: launch standalone (no Safari chrome) and use
  // the short title under the home-screen icon. The manifest (app/manifest.ts)
  // covers Android/desktop; these meta tags are the iOS-only equivalents.
  appleWebApp: {
    capable: true,
    title: "Macrotide",
    statusBarStyle: "default",
    startupImage: [], // no splash images — a blank launch frame is fine (fast boot)
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // A SINGLE theme-color meta, owned at runtime (seeded by the bootstrap below,
  // kept live by App's theme effect via syncThemeColor). The in-app theme is
  // data-theme/localStorage-driven and independent of the OS preference, so
  // OS-media-scoped tags can't track the in-app toggle — the installed-PWA
  // status bar would stay frozen on the OS-matched color. This is just the seed;
  // the bootstrap corrects it to the resolved theme before first paint.
  themeColor: "#0c0d0f",
};

// Runs before React hydrates so the saved theme is applied on first paint: sets
// data-theme AND the status-bar theme-color (resolving "system" via the OS
// preference). No-flash pattern used by next-themes; mutating <html>/the meta
// outside React avoids hydration mismatches.
const themeBootstrap = `(function(){try{var t=localStorage.getItem('macrotide-theme');if(t!=='light'&&t!=='dark'&&t!=='system')t='system';document.documentElement.setAttribute('data-theme',t);var dark=t==='dark'||(t==='system'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);var m=document.querySelector('meta[name="theme-color"]');if(!m){m=document.createElement('meta');m.setAttribute('name','theme-color');document.head.appendChild(m);}m.setAttribute('content',dark?'#0c0d0f':'#ffffff');}catch(e){document.documentElement.setAttribute('data-theme','system');}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={fontVariables}>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: hardcoded constant, runs before hydration */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
