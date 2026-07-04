// Global risk → color palette. The single source of truth for turning a
// holding's RISK into a swatch color, ordered cool/calm (low risk) → warm/hot
// (high risk) so a glance across your holdings reads as a risk heat map.
//
// Resolution order (RS first, asset class as fallback):
//   1. SEC risk-spectrum code (RS1…RS8, RS81 = "8+", hotter than RS8). This is
//      the real risk ladder, so it drives the color directly.
//   2. No RS code (custom assets, foreign tickers, cash buckets) → a
//      representative ramp stop for the holding's asset class.
//   3. Genuinely unknown → a neutral grey OFF the ramp, so "no risk opinion"
//      never masquerades as a real level.
//
// Colors live in a muted oklch register (L ≈ 0.55, low chroma) that matches the
// app's demo palette — on-brand dots, not a default chart. A ticker hash jitters
// lightness and hue so same-risk holdings look distinct. The hue jitter forms a
// WIDE band per level (bands may overlap neighbors — that's fine, each level's
// CENTER carries the tone) and is clamped to the palette's arc so it can never
// spill past red into magenta or past blue into purple.

import type { AssetClass } from "@/lib/static/types";

type Oklch = readonly [l: number, c: number, h: number];

// Ordered ramp: index 0 = RS1 (calmest) … index 8 = RS8+/RS81 (hottest). Hue
// marches 250°→10° (blue→red), jumping past the yellow/gold band (~90–130°) that
// reads brown at this lightness; the center hue is each level's tone.
const RISK_RAMP: readonly Oklch[] = [
  [0.55, 0.1, 250], // RS1  blue        — gov MM / very low
  [0.55, 0.1, 222], // RS2  blue-cyan   — money market / cash
  [0.55, 0.1, 196], // RS3  cyan-teal   — short / gov bond
  [0.55, 0.1, 165], // RS4  teal-green  — bond
  [0.55, 0.1, 135], // RS5  green       — mixed / balanced
  [0.55, 0.1, 70], // RS6  amber       — broad equity
  [0.55, 0.1, 40], // RS7  orange      — focused equity
  [0.55, 0.1, 20], // RS8  pink        — sector / alternative
  [0.55, 0.1, 10], // RS8+ red         — leveraged / single-commodity (hottest)
];

// Off-ramp neutral for holdings with no risk signal at all. Near-zero chroma so
// it can't be mistaken for a real ramp level.
const NEUTRAL: Oklch = [0.62, 0.02, 250];

// The palette occupies one arc, from the hottest (RS8+) to the coolest (RS1)
// hue. Jittered hues are clamped to it so a wide band never leaves the blue→red
// tone (no wrap into magenta below or purple above).
const HUE_HOTTEST = RISK_RAMP[RISK_RAMP.length - 1][2]; // 10°
const HUE_COOLEST = RISK_RAMP[0][2]; // 250°

// Representative ramp index for a holding that has no RS code, by asset class.
// cash≈RS2, bond≈RS4, equity≈RS6, alternative≈RS8; unknown stays off-ramp.
const CLASS_RAMP_INDEX: Record<AssetClass, number | null> = {
  cash: 1,
  bond: 3,
  mixed: 4,
  equity: 5,
  alternative: 7,
  unknown: null,
};

// ± oklch lightness wiggle for same-level holdings. With uniform ramp chroma,
// this is the main per-fund "pop" when two funds' hues land close — kept inside
// the legible band [LIGHT_MIN, LIGHT_MAX] so white/bg swatch text stays readable.
const LIGHT_JITTER = 0.05;
const LIGHT_MIN = 0.5;
const LIGHT_MAX = 0.62;
// ± degrees of hue wiggle per ticker — intentionally WIDE. Each RS level is a
// band centered on its base hue; a holding lands randomly within it, so
// same-level funds look distinct while the center still leans the right tone.
// Bands overlap neighbors by design; the clamp to the palette arc keeps every
// result on-tone. Dial down for cleaner level separation, up for more variety.
const HUE_JITTER = 40;

/**
 * Map an SEC risk-spectrum code to a ramp index (0 = RS1 … 8 = RS8+), or null
 * when the code is missing/unrecognized (the caller then falls back to class).
 * RS81 and "RS8+" both mean "more than 8" → the hottest stop.
 */
export function riskRampIndex(code: string | null | undefined): number | null {
  if (!code) return null;
  const c = code.toUpperCase().replace(/\s+/g, "");
  if (c === "RS81" || c === "RS8+" || c === "RS8PLUS") return 8; // "8+", hottest
  const m = c.match(/^RS([1-8])$/);
  return m ? Number(m[1]) - 1 : null; // RS1→0 … RS8→7
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// FNV-1a over the ticker → stable unsigned 32-bit hash (no Math.random, so a
// holding's color is deterministic across runs/processes).
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function format([l, c, h]: Oklch): string {
  return `oklch(${l} ${c} ${h})`;
}

/** The base ramp color (no jitter) for an RS code, for non-holding callers such
 * as the fund-detail risk badge. Falls back to neutral for unknown codes. */
export function riskSpectrumColor(code: string | null | undefined): string {
  const idx = riskRampIndex(code);
  return format(idx == null ? NEUTRAL : RISK_RAMP[idx]);
}

/**
 * Deterministic swatch background for a holding, as an `oklch(...)` string.
 * RS code drives the level; asset class is the fallback; unknown → neutral grey.
 * The ticker hash jitters lightness and hue — the hue lands randomly within a
 * wide band centered on the level's base hue (bands may overlap neighbors),
 * clamped to the palette arc so it never leaves the blue→red tone.
 */
export function holdingColor(holding: {
  class: AssetClass;
  ticker: string;
  riskSpectrum?: string | null;
}): string {
  const idx = riskRampIndex(holding.riskSpectrum) ?? CLASS_RAMP_INDEX[holding.class];
  if (idx == null) return format(NEUTRAL);
  const [l, c, h] = RISK_RAMP[idx];
  // Independent hash slices for lightness and hue so the two don't correlate.
  const seed = hash32(holding.ticker || "?");
  const lightOffset = ((seed % 1000) / 999 - 0.5) * 2 * LIGHT_JITTER;
  const hueOffset = (((seed >>> 10) % 1000) / 999 - 0.5) * 2 * HUE_JITTER;
  // Clamp lightness to a band that keeps the swatch initials (white / bg)
  // legible; clamp hue to the palette arc so a wide band can't wrap off-tone.
  const light = clamp(Math.round((l + lightOffset) * 1000) / 1000, LIGHT_MIN, LIGHT_MAX);
  const hue = clamp(Math.round(h + hueOffset), HUE_HOTTEST, HUE_COOLEST);
  return `oklch(${light} ${c} ${hue})`;
}
