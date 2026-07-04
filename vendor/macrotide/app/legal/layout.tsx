import type { ReactNode } from "react";
import { LandingFooter, LandingHeader } from "@/components/LandingChrome";
import "@/components/landing.css";

// Legal pages ride the marketing design language and share the EXACT homepage
// header + footer (LandingChrome) so a page linked from the landing looks like
// the landing. The brand lockup routes home (`/`) instead of the in-page anchor.
// Light-only, matching the landing.
export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mt-landing-root">
      <LandingHeader brandHref="/" />
      <main className="mt-container mt-narrow mt-section-tight">
        <article className="mt-prose">{children}</article>
      </main>
      <LandingFooter />
    </div>
  );
}
