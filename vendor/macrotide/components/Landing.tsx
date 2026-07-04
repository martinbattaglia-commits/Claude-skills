"use client";

// Macrotide — public marketing landing.
//
// Rendered by `/app/page.tsx` when there is no session and no demo cookie.
// This is the single source of the product pitch — the in-app onboarding does
// NOT duplicate this copy. CTAs route to real auth (/login) or start a real
// demo session via `/api/demo`; there is no simulated brokerage flow here.
//
// Honesty rule: anything not yet shipped is described as planned, never
// present. Status table is the README; intent is product-direction.md.
//
// Image-slot strategy: render project-local screenshots and media assets,
// with a generic placeholder only if an expected asset is missing.

import Image from "next/image";
import { useRouter } from "next/navigation";
import { type CSSProperties, type ReactNode, useState } from "react";

import { LandingFooter, LandingHeader } from "./LandingChrome";
import { PhoneFrame } from "./PhoneFrame";
import "./landing.css";

/* ============================================================
 * <ScreenSlot> — show a real screenshot, fall back to a coded
 * mockup if the file isn't there yet.
 *
 * Capture spec for phones: 390 × 784 logical @ DPR 3 → 1170 × 2352
 * PNG. The shorter height deducts the ~5.35% of the screen cutout
 * where the bezel SVG's Dynamic Island sits — the time +
 * signal/wifi/battery icons end above the island and so are also
 * clear of the image (handled in landing.css).
 * ============================================================ */
function ScreenSlot({ src, alt, fallback }: { src: string; alt: string; fallback: ReactNode }) {
  const [errored, setErrored] = useState(false);
  if (errored) return <>{fallback}</>;
  return (
    // Plain <img> (not next/image) on purpose — decorative, lives inside an
    // aspect-locked container, and we need the cheap `onError` swap.
    // biome-ignore lint/performance/noImgElement: see comment above
    <img src={src} alt={alt} onError={() => setErrored(true)} />
  );
}

/* ============================================================
 * <ImageSlot> — placeholder for screenshots and media assets.
 *
 *   <ImageSlot kind="real">
 *     <img src="/landing/portfolio.png" alt="" />
 *   </ImageSlot>
 *
 * Drop an <img> or <video> in as a child.
 * ============================================================ */
interface ImageSlotProps {
  kind?: "real" | "decorative";
  className?: string;
  children?: ReactNode;
  decorative?: boolean;
  style?: CSSProperties;
}

function ImageSlot({
  kind = "real",
  className = "",
  children,
  decorative = false,
  style,
}: ImageSlotProps) {
  const label = kind === "real" ? "Screenshot unavailable" : "Image unavailable";
  const showPlaceholder = !children;
  return (
    <figure
      className={`mt-imgslot ${className}`}
      data-shot={kind}
      aria-hidden={decorative ? "true" : undefined}
      style={style}
    >
      {children}
      {showPlaceholder ? (
        <div className="mt-imgslot-inner">
          <span className="mt-imgslot-kind">{label}</span>
        </div>
      ) : null}
    </figure>
  );
}

/* ============================================================
 * Tiny inline icons
 * ============================================================ */
function ArrowIcon() {
  return (
    <svg
      className="mt-arrow"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="13 6 19 12 13 18" />
    </svg>
  );
}

/* ============================================================
 * Hero — center-aligned, single short headline, visual stage
 * ============================================================ */
function Hero({ onSignIn, onDemo, demoBusy }: HeroProps) {
  return (
    <section id="top" className="mt-hero">
      <div className="mt-container mt-narrow">
        <div className="mt-eyebrow">
          <span className="mt-eyebrow-dot" aria-hidden="true" />
          Open source · For Thai index investors
        </div>

        <h1 className="mt-h1">
          An honest mirror
          <br />
          for your <em>index portfolio.</em>
        </h1>

        <p className="mt-lede">
          Macrotide reads your holdings, Thai funds, stocks, and more, and shows you what your index
          is really doing, and what your fees really cost. Proposes, never trades.
        </p>

        <div className="mt-cta-row">
          <button type="button" className="mt-btn mt-btn-primary mt-btn-lg" onClick={onSignIn}>
            Get started
            <ArrowIcon />
          </button>
          <button
            type="button"
            className="mt-btn mt-btn-secondary mt-btn-lg"
            onClick={onDemo}
            disabled={demoBusy}
          >
            {demoBusy ? "Loading the demo…" : "Explore the demo"}
          </button>
        </div>

        <div className="mt-micro-trust">
          <span>MIT-licensed</span>
          <span>Self-hostable</span>
          <span>Never sold or shared</span>
        </div>
      </div>

      <div className="mt-container">
        <div className="mt-hero-stage">
          <ImageSlot kind="decorative" className="mt-hero-image" decorative>
            <Image
              src="/landing/hero-tide.jpg"
              alt=""
              width={1672}
              height={941}
              priority
              sizes="(max-width: 720px) calc(100vw - 44px), min(100vw - 64px, 1120px)"
            />
          </ImageSlot>
          <div
            className="mt-hero-phone"
            aria-hidden="true"
            // Portfolio screenshot is light-themed; `--phone-screen-bg` paints
            // the status-bar strip in the same colour as the app's light `--bg`
            // so there's no seam where the image meets the bezel zone. Bezel
            // mode "light" → dark icons readable on the light strip.
            style={{ "--phone-screen-bg": "#f8f8f9" } as CSSProperties}
          >
            <PhoneFrame mode="light">
              <ScreenSlot
                src="/landing/mobile-portfolio.png"
                alt="Macrotide portfolio screen"
                fallback={<PhonePortfolio />}
              />
            </PhoneFrame>
          </div>
          <div className="mt-hero-overlays" aria-hidden="true">
            <div className="mt-hero-overlay mt-overlay-tl">
              <div className="mt-ov-head">
                <span className="mt-ov-label">Health score</span>
                <span className="mt-ov-badge mt-ov-badge-up">▲ +6 / 30d</span>
              </div>
              <div className="mt-ov-value">
                78<span className="mt-ov-unit">/ 100</span>
              </div>
              <svg className="mt-ov-spark" viewBox="0 0 120 22" preserveAspectRatio="none">
                <path
                  d="M0,18 L20,17 L40,18 L60,13 L80,14 L100,8 L120,5"
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
              <div className="mt-ov-note">Good · fee creep flagged</div>
            </div>
            <div className="mt-hero-overlay mt-overlay-br">
              <div className="mt-ov-head">
                <span className="mt-ov-label">Blended fee</span>
                <span className="mt-ov-badge mt-ov-badge-good">below avg</span>
              </div>
              <div className="mt-ov-value">
                0.74<span className="mt-ov-unit">% / yr</span>
              </div>
              <div className="mt-ov-compare">
                <span className="mt-ov-cmp-row">
                  <span className="mt-ov-cmp-track">
                    <span style={{ width: "62%", background: "var(--accent)" }} />
                  </span>
                  <span className="mt-ov-cmp-val">You 0.74%</span>
                </span>
                <span className="mt-ov-cmp-row">
                  <span className="mt-ov-cmp-track">
                    <span style={{ width: "100%", background: "var(--muted-2)" }} />
                  </span>
                  <span className="mt-ov-cmp-val">Avg 0.91%</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

interface HeroProps {
  onSignIn: () => void;
  onDemo: () => void;
  demoBusy: boolean;
}

/* ============================================================
 * Trust strip
 * ============================================================ */
function TrustStrip() {
  const items = [
    "Open source (MIT)",
    "Self-hostable on your VM",
    "Reads holdings, never trades",
    "Thai SEC fund data",
  ];
  return (
    <section className="mt-trust-strip">
      <div className="mt-container">
        <div className="mt-trust-row">
          {items.map((t) => (
            <div className="mt-trust-item" key={t}>
              <span className="mt-trust-pin" aria-hidden="true" />
              {t}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ============================================================
 * Feature mockups — coded mini-UIs (not screenshots).
 *
 * Each zooms into the single element that sells the feature, so it stays
 * legible at card size. Numbers mirror the demo portfolio; they illustrate
 * shipped capability, not live data.
 * ============================================================ */
function HealthMock() {
  const rows: Array<{ name: string; val: string; pct: number; tone: "ok" | "warn" }> = [
    { name: "Allocation drift", val: "43.8pp", pct: 70, tone: "warn" },
    { name: "Blended fee", val: "0.74% / yr", pct: 55, tone: "warn" },
    { name: "Concentration", val: "28%", pct: 38, tone: "ok" },
    { name: "Cash drag", val: "3.4%", pct: 22, tone: "ok" },
  ];
  return (
    <div className="mt-mock mt-mock-health" aria-hidden="true">
      <div className="mt-mock-top">
        <span className="mt-mock-label">Portfolio health</span>
        <span className="mt-mock-pill">Good</span>
      </div>
      <div className="mt-mock-score">
        78<span className="mt-mock-score-unit">/ 100</span>
      </div>
      <div className="mt-mock-rows">
        {rows.map((r) => (
          <div className="mt-mock-row" key={r.name}>
            <span className="mt-mock-row-name">{r.name}</span>
            <span className={`mt-mock-bar mt-mock-bar-${r.tone}`}>
              <span style={{ width: `${r.pct}%` }} />
            </span>
            <span className="mt-mock-row-val">{r.val}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PerformanceMock() {
  // two hand-tuned series over the same window; portfolio (green) vs S&P 500 (dashed)
  const you = "M2,74 L24,70 L46,72 L70,60 L94,62 L118,50 L142,52 L168,38 L192,40 L216,26 L240,18";
  const bench = "M2,76 L24,73 L46,74 L70,68 L94,69 L118,61 L142,63 L168,55 L192,57 L216,49 L240,44";
  return (
    <div className="mt-mock mt-mock-perf" aria-hidden="true">
      <div className="mt-mock-top">
        <span className="mt-mock-label">Performance · 1Y</span>
      </div>
      <div className="mt-perf-readout">
        <span className="mt-perf-chip mt-perf-you">
          <span className="mt-perf-key" /> You <strong>+18.6%</strong>
        </span>
        <span className="mt-perf-chip mt-perf-bench">
          <span className="mt-perf-key" /> S&amp;P 500 <strong>+11.2%</strong>
        </span>
      </div>
      <svg
        className="mt-perf-svg"
        viewBox="0 0 242 84"
        preserveAspectRatio="none"
        role="img"
        aria-label="Portfolio outperforming the S&P 500 over one year"
      >
        <defs>
          <linearGradient id="mtPerfFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${you} L240,84 L2,84 Z`} fill="url(#mtPerfFill)" stroke="none" />
        <path
          d={bench}
          fill="none"
          stroke="var(--muted-2)"
          strokeWidth="1.5"
          strokeDasharray="3 3"
        />
        <path d={you} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </div>
  );
}

function ProposalMock() {
  return (
    <div className="mt-mock mt-mock-proposal" aria-hidden="true">
      <div className="mt-mock-top">
        <span className="mt-mock-label">Advisor · proposal</span>
      </div>
      <div className="mt-proposal-card">
        <div className="mt-proposal-head">
          <span className="mt-proposal-kind">Plan edit</span>
          Trim overweight US
        </div>
        <div className="mt-proposal-diff">
          <span className="mt-diff-fund">K-USA-A(A)</span>
          <span className="mt-diff-amt">−฿57,400</span>
        </div>
        <div className="mt-proposal-note">Brings US exposure back toward your target weight.</div>
        <div className="mt-proposal-actions">
          <span className="mt-mini-btn mt-mini-accept">Accept</span>
          <span className="mt-mini-btn mt-mini-reject">Reject</span>
        </div>
      </div>
      <div className="mt-proposal-foot">Accept-only · no order is ever placed</div>
    </div>
  );
}

/* ============================================================
 * Coded phone screens — realistic mobile mockups (not screenshots).
 * Decorative; numbers mirror the demo portfolio.
 * ============================================================ */
function PhoneTabs({ active }: { active: "Portfolio" | "Chat" }) {
  return (
    <div className="mt-tabbar">
      {(["Portfolio", "Markets", "Models", "Chat"] as const).map((t) => (
        <span className={`mt-tab${t === active ? " mt-tab-on" : ""}`} key={t}>
          <span className="mt-tab-dot" />
          {t}
        </span>
      ))}
    </div>
  );
}

function PhonePortfolio() {
  return (
    <div className="mt-screen mt-screen-dark" aria-hidden="true">
      <div className="mt-screen-head">
        <span className="mt-screen-title">Portfolio</span>
        <span className="mt-screen-ava">DU</span>
      </div>
      <div className="mt-screen-body">
        <div className="mt-sc-label">Combined balance · 3 portfolios</div>
        <div className="mt-sc-balance">
          ฿1,284,734<span className="mt-sc-balance-dec">.89</span>
        </div>
        <div className="mt-sc-delta">▲ ฿129,205 · +11.2% all-time</div>
        <div className="mt-sc-card">
          <div className="mt-sc-card-top">
            <span className="mt-mock-label">Health</span>
            <span className="mt-mock-pill">Good</span>
          </div>
          <div className="mt-sc-health">
            78<span className="mt-sc-health-unit">/ 100</span>
          </div>
          <svg className="mt-sc-spark" viewBox="0 0 180 36" preserveAspectRatio="none" role="img">
            <path
              d="M0,30 L20,28 L40,30 L60,22 L80,24 L100,16 L120,18 L140,9 L160,11 L180,4"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <div className="mt-sc-alloc">
          <span style={{ flex: "80.7", background: "var(--accent)" }} />
          <span style={{ flex: "13.9", background: "#d9920a" }} />
          <span style={{ flex: "3.4", background: "var(--accent-2)" }} />
          <span style={{ flex: "2.0", background: "var(--muted-2)" }} />
        </div>
        <div className="mt-sc-legend">
          <span>
            <i style={{ background: "var(--accent)" }} />
            Stocks 80.7%
          </span>
          <span>
            <i style={{ background: "#d9920a" }} />
            Bonds 13.9%
          </span>
        </div>
      </div>
      <PhoneTabs active="Portfolio" />
    </div>
  );
}

function PhoneAdvisor() {
  return (
    <div className="mt-screen" aria-hidden="true">
      <div className="mt-screen-head">
        <span className="mt-screen-title">Advisor</span>
        <span className="mt-screen-new">+ New chat</span>
      </div>
      <div className="mt-screen-body">
        <div className="mt-chat-bubble mt-chat-bubble-user">Am I drifting from my plan?</div>
        <div className="mt-chat-meta">
          <span className="mt-chat-dot" /> Advisor · 06:34 AM
        </div>
        <div className="mt-chat-bubble">
          Your US sleeve is running hot, 6pp over target. Want me to draft a trim back to plan?
        </div>
        <div className="mt-proposal-card mt-proposal-card-sm">
          <div className="mt-proposal-head">
            <span className="mt-proposal-kind">Plan edit</span>
            Trim overweight US
          </div>
          <div className="mt-proposal-diff">
            <span className="mt-diff-fund">K-USA-A(A)</span>
            <span className="mt-diff-amt">−฿57,400</span>
          </div>
          <div className="mt-proposal-actions">
            <span className="mt-mini-btn mt-mini-accept">Accept</span>
            <span className="mt-mini-btn mt-mini-reject">Reject</span>
          </div>
        </div>
      </div>
      <div className="mt-chat-chips">
        <span className="mt-chat-chip">How am I vs target?</span>
        <span className="mt-chat-chip">Explain my fees</span>
      </div>
      <div className="mt-chat-input">
        Ask about your portfolio…
        <span className="mt-chat-send">➤</span>
      </div>
      <PhoneTabs active="Chat" />
    </div>
  );
}

/* ============================================================
 * What it does — three feature cards (live only)
 * ============================================================ */
function WhatItDoes() {
  return (
    <section id="what" className="mt-section">
      <div className="mt-container">
        <div className="mt-section-head">
          <div className="mt-section-eyebrow">What it does today</div>
          <h2 className="mt-h2">
            The honest version of <em>where you stand</em>.
          </h2>
          <p className="mt-section-lead">
            Three things, available now in the running app. Anything still planned is on the roadmap
            and described that way.
          </p>
        </div>

        <div className="mt-feature-grid">
          <article className="mt-feature">
            <div className="mt-feature-img mt-feature-mock">
              <HealthMock />
            </div>
            <div className="mt-feature-body">
              <h3 className="mt-feature-title">Honest portfolio analysis</h3>
              <p className="mt-feature-text">
                Allocation, drift, blended fee, concentration, and cash drag, rolled into a
                transparent 0–100 health score.
              </p>
            </div>
          </article>

          <article className="mt-feature">
            <div className="mt-feature-img mt-feature-mock">
              <PerformanceMock />
            </div>
            <div className="mt-feature-body">
              <h3 className="mt-feature-title">Performance vs your index</h3>
              <p className="mt-feature-text">
                Real, aligned benchmark series (SET, S&amp;P 500, Nasdaq, Nikkei) over the same
                window as your portfolio.
              </p>
            </div>
          </article>

          <article className="mt-feature">
            <div className="mt-feature-img mt-feature-mock">
              <ProposalMock />
            </div>
            <div className="mt-feature-body">
              <h3 className="mt-feature-title">Advisor that proposes</h3>
              <p className="mt-feature-text">
                An Advisor that reads your real portfolio. Every write is an accept-only proposal
                card. You stay in the loop.
              </p>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

/* ============================================================
 * Advisor spotlight — phone-shaped portrait shot + copy
 * ============================================================ */
function AdvisorSpotlight() {
  return (
    <section className="mt-section mt-section-tight">
      <div className="mt-container">
        <div className="mt-bigrow">
          <div className="mt-phone-wrap">
            <div
              className="mt-phone-device"
              aria-hidden="true"
              // Advisor screenshot is dark-themed; backdrop colour matches the
              // dark app `--bg`. Bezel mode "dark" → light icons readable on
              // the dark strip.
              style={{ "--phone-screen-bg": "#0c0d0f" } as CSSProperties}
            >
              <PhoneFrame mode="dark">
                <ScreenSlot
                  src="/landing/mobile-advisor.png"
                  alt="Macrotide Advisor screen"
                  fallback={<PhoneAdvisor />}
                />
              </PhoneFrame>
            </div>
          </div>
          <div className="mt-bigrow-copy">
            <div className="mt-kicker">The Advisor · reads on phone, laptop, anywhere</div>
            <h3 className="mt-h3">Reads your portfolio. Proposes, never trades.</h3>
            <p className="mt-p">
              The Advisor calls scoped tools against your real holdings. It doesn't guess at an
              "average" investor. Every write is surfaced as a proposal card you accept or reject.
              Nothing happens silently, and no order is ever placed.
            </p>
            <p className="mt-p">
              If a number isn't available, it says so. The Advisor references only figures its tools
              actually returned.
            </p>
            <a className="mt-quiet-link" href="#what">
              See what the Advisor can do →
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ============================================================
 * Desktop view — centred copy + CSS MacBook with portfolio shot.
 *
 * Structure (`.mt-macbook` / `-screen` / `-display` / `-base` /
 * `-trackpad-notch`) and copy are taken straight from the Claude
 * Design hand-off (`investment-agent/project/Landing Page.html`).
 * ============================================================ */
function DesktopView() {
  return (
    // Regular (non-tight) section padding so the warm-bg breathing room after
    // the screenshot reads as a deliberate pause before the Loop section flips
    // to var(--paper).
    <section className="mt-section">
      <div className="mt-container">
        <div className="mt-section-head">
          <div className="mt-section-eyebrow">Same product · bigger canvas</div>
          <h2 className="mt-h2">
            Every angle, in <em>one window</em>.
          </h2>
          <p className="mt-section-lead">
            On a laptop, allocation, drift, blended fee, and performance vs your index sit side by
            side. The same numbers as on your phone, with more room to think.
          </p>
        </div>
        <div className="mt-mac-window" aria-hidden="true">
          <ScreenSlot
            src="/landing/desktop-portfolio.png"
            alt="Macrotide on desktop"
            fallback={<ImageSlot kind="real" />}
          />
        </div>
      </div>
    </section>
  );
}

/* ============================================================
 * The loop — four pillars, shipped vs planned
 * ============================================================ */
const PILLARS: Array<{
  num: string;
  name: string;
  body: string;
  tag: "shipped" | "planned";
  tagLabel: string;
}> = [
  {
    num: "01",
    name: "Learn",
    body: "Short, evidence-based reads on index investing, woven into the Advisor.",
    tag: "planned",
    tagLabel: "On the roadmap",
  },
  {
    num: "02",
    name: "Analyze",
    body: "Allocation, drift, blended fee, concentration, performance vs your index.",
    tag: "shipped",
    tagLabel: "Available now",
  },
  {
    num: "03",
    name: "Research",
    body: "Today: an RSS feed. Planned: a clustered brief and a digest grounded in your holdings.",
    tag: "planned",
    tagLabel: "Synthesis planned",
  },
  {
    num: "04",
    name: "Select",
    body: "A fee-aware fund finder already names the lowest-fee fund for the exposure you want. Planned: per-fund depth (holdings, risk, feeder look-through) and a fee-creep flag.",
    tag: "planned",
    tagLabel: "Depth planned",
  },
];

function Loop() {
  return (
    <section id="loop" className="mt-section mt-loop">
      <div className="mt-container">
        <div className="mt-section-head">
          <div className="mt-section-eyebrow">The four-stage loop</div>
          <h2 className="mt-h2">
            Learn. Analyze. Research. <em className="mt-em-blue">Select.</em>
          </h2>
          <p className="mt-section-lead">
            The loop a self-directed index investor actually walks, repeatedly. Each pillar is
            labeled by what's shipped and what's still planned.
          </p>
        </div>

        <div className="mt-loop-list">
          {PILLARS.map((p) => (
            <div className="mt-loop-item" key={p.name}>
              <div className="mt-loop-num">Pillar {p.num}</div>
              <h3 className="mt-loop-h">{p.name}</h3>
              <p className="mt-loop-text">{p.body}</p>
              <div className="mt-pillar-tag-row">
                <span className={`mt-tag mt-tag-${p.tag}`}>
                  <span className="mt-tag-dot" />
                  {p.tagLabel}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ============================================================
 * Open source — no faux stats
 * ============================================================ */
function OpenSource() {
  return (
    <section id="open" className="mt-section mt-open-source">
      <div className="mt-container mt-narrow">
        <div className="mt-section-head" style={{ marginBottom: 0 }}>
          <div className="mt-section-eyebrow">Built honestly</div>
          <h2 className="mt-h2">
            Open by default. <em>Yours</em> by default.
          </h2>
          <p className="mt-section-lead">
            Macrotide is a personal-use experiment, soft-public for family and friends. The code is
            public, the data stays with you, and the Advisor cannot move money.
          </p>
        </div>

        <div className="mt-os-badges">
          <div className="mt-os-badge">
            <span className="mt-os-v">MIT</span>
            <span className="mt-os-l">License</span>
          </div>
          <div className="mt-os-badge">
            <span className="mt-os-v">Self-host</span>
            <span className="mt-os-l">Single-owner VM</span>
          </div>
          <div className="mt-os-badge">
            <span className="mt-os-v">SQLite</span>
            <span className="mt-os-l">On your instance</span>
          </div>
          <div className="mt-os-badge">
            <span className="mt-os-v">Passkey</span>
            <span className="mt-os-l">Sign-in</span>
          </div>
          <div className="mt-os-badge">
            <span className="mt-os-v">Read-only</span>
            <span className="mt-os-l">Advisor scope</span>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ============================================================
 * Final CTA
 * ============================================================ */
function FinalCta({ onSignIn, onDemo, demoBusy }: HeroProps) {
  return (
    <section className="mt-final-cta">
      <div className="mt-container mt-narrow">
        <h2 className="mt-h2-final">
          See whether you're <em>actually</em>
          <br />
          matching your index.
        </h2>
        <p className="mt-section-lead" style={{ marginInline: "auto" }}>
          Sign in with a passkey, or poke around the no-signup demo. Either way, you'll know your
          blended fee in under a minute.
        </p>
        <div className="mt-cta-row" style={{ justifyContent: "center", marginTop: 32 }}>
          <button type="button" className="mt-btn mt-btn-primary mt-btn-lg" onClick={onSignIn}>
            Get started
            <ArrowIcon />
          </button>
          <button
            type="button"
            className="mt-btn mt-btn-secondary mt-btn-lg"
            onClick={onDemo}
            disabled={demoBusy}
          >
            {demoBusy ? "Loading the demo…" : "Explore the demo"}
          </button>
        </div>
      </div>
    </section>
  );
}

/* ============================================================
 * Footer
 * ============================================================ */
/* ============================================================
 * Top-level
 * ============================================================ */
export default function Landing() {
  const router = useRouter();
  const [demoBusy, setDemoBusy] = useState(false);

  function onSignIn() {
    router.push("/login");
  }

  async function onDemo() {
    setDemoBusy(true);
    try {
      const res = await fetch("/api/demo", { method: "POST" });
      if (!res.ok) throw new Error("demo start failed");
      router.replace("/");
    } catch {
      setDemoBusy(false);
    }
  }

  return (
    <div className="mt-landing-root">
      <LandingHeader />
      <main>
        <Hero onSignIn={onSignIn} onDemo={onDemo} demoBusy={demoBusy} />
        <TrustStrip />
        <WhatItDoes />
        <AdvisorSpotlight />
        <DesktopView />
        <Loop />
        <OpenSource />
        <FinalCta onSignIn={onSignIn} onDemo={onDemo} demoBusy={demoBusy} />
      </main>
      <LandingFooter />
    </div>
  );
}
