"use client";

// Shared marketing chrome — the landing's header + footer, extracted so the
// public legal pages (`/legal/*`) render the EXACT same header/footer as the
// homepage they link from. Both consume `landing.css` (`.mt-*` tokens).

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { BrandMark } from "./BrandMark";

function GitHubIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      style={{ verticalAlign: "-2px" }}
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2.18c-3.2.7-3.87-1.36-3.87-1.36-.52-1.34-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18.92-.26 1.91-.39 2.89-.39.98 0 1.97.13 2.89.39 2.21-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.44-2.69 5.41-5.25 5.69.41.36.78 1.07.78 2.16v3.2c0 .31.21.68.8.56 4.57-1.53 7.85-5.83 7.85-10.91C23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}

/**
 * Marketing header — brand · GitHub · Sign in · Get started.
 *
 * `brandHref` is the brand-lockup target: the landing uses the in-page anchor
 * `#top`; content pages (legal) pass `/` to route home. Sign-in / Get-started
 * both route to `/login` (same as the landing's own handler).
 */
export function LandingHeader({ brandHref = "#top" }: { brandHref?: string }) {
  const router = useRouter();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const onSignIn = () => router.push("/login");

  return (
    <header className="mt-header" data-scrolled={scrolled}>
      <div className="mt-container mt-header-inner">
        <a className="mt-brand" href={brandHref}>
          <span className="mt-brand-mark">
            <BrandMark />
          </span>
          Macrotide
        </a>
        <div className="mt-nav-right">
          <a
            className="mt-nav-link"
            href="https://github.com/Sitthinut/macrotide"
            target="_blank"
            rel="noreferrer"
          >
            <GitHubIcon /> <span style={{ marginLeft: 6 }}>GitHub</span>
          </a>
          <button type="button" className="mt-btn mt-btn-ghost" onClick={onSignIn}>
            Sign in
          </button>
          <button type="button" className="mt-btn mt-btn-primary" onClick={onSignIn}>
            Get started
          </button>
        </div>
      </div>
    </header>
  );
}

/** Marketing footer — brand + disclaimer, doc/project/legal link columns. */
export function LandingFooter() {
  return (
    <footer className="mt-footer">
      <div className="mt-container">
        <div className="mt-footer-row">
          <div className="mt-footer-left">
            <a className="mt-brand" href="#top">
              <span className="mt-brand-mark">
                <BrandMark />
              </span>
              Macrotide
            </a>
            <small className="mt-footer-disclaimer">
              Experimental software. Not investment, tax, or legal advice. Don't rely on it for real
              investment decisions.
            </small>
          </div>
          <nav className="mt-footer-links" aria-label="Footer">
            <div className="mt-footer-col">
              <span className="mt-footer-col-h">Docs</span>
              <a href="https://github.com/Sitthinut/macrotide/blob/main/README.md">README</a>
              <a href="https://github.com/users/Sitthinut/projects/2">Roadmap</a>
              <a href="https://github.com/Sitthinut/macrotide/tree/main/docs">Guides</a>
            </div>
            <div className="mt-footer-col">
              <span className="mt-footer-col-h">Project</span>
              <a href="https://github.com/Sitthinut/macrotide">GitHub</a>
              <a href="https://github.com/Sitthinut/macrotide/blob/main/LICENSE">MIT License</a>
              <a href="https://github.com/Sitthinut/macrotide/blob/main/SECURITY.md">Security</a>
            </div>
            <div className="mt-footer-col">
              <span className="mt-footer-col-h">Legal</span>
              <Link href="/legal/terms">Terms of Service</Link>
              <Link href="/legal/privacy">Privacy Policy</Link>
            </div>
          </nav>
        </div>
        <div className="mt-footer-bottom">
          <span>© {new Date().getFullYear()} Macrotide</span>
        </div>
      </div>
    </footer>
  );
}
