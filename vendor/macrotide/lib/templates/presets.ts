// Factory template presets — the curated model portfolios macrotide ships.
//
// These are the upstream-owned, evolvable baseline. On a fresh self-host they
// seed the instance's read-only template library (built-in model portfolios);
// each instance owner then curates their own library on top. The seeder
// (`ensureTemplatePresets`) is strictly ADDITIVE — it only inserts presets a DB
// is missing, never overwriting or deleting an owner's customizations — so this
// list can evolve across releases without clobbering anyone's instance.
//
// Bump PRESETS_VERSION whenever this list changes; the seeder records it so the
// reconciliation pass (and, later, owner-facing "new templates available"
// surfacing) has a watermark to compare against.
//
// Shape note: presets carry the UI-facing `ModelPortfolio` shape (mix /
// expectedVol) because that is the existing model-portfolio vocabulary; the
// seeder maps it to the DB insert columns. No preset is `isCustom` — custom
// models are user/owner forks created at runtime, never shipped here.
import type { ModelPortfolio } from "@/lib/static/types";

export const PRESETS_VERSION = 1;

export const TEMPLATE_PRESETS: ModelPortfolio[] = [
  {
    id: "bogle3",
    name: "Bogleheads 3-Fund",
    tagline: "Index investing's most-recommended starting point",
    blurb:
      "John Bogle's philosophy distilled: own everything, hold forever, keep costs low. Three broad index funds across US, international, and bonds.",
    mix: [
      { label: "US Total Market", pct: 50, ticker: "ASP-S&P500", color: "var(--accent)" },
      { label: "International Equity", pct: 30, ticker: "K-WORLDX", color: "#7C7CFF" },
      { label: "Thai Bonds", pct: 20, ticker: "K-FIXED", color: "#F4A434" },
    ],
    expectedReturn: 6.8,
    expectedVol: 11.5,
    ter: 0.45,
    horizon: "10+ yrs",
    risk: "balanced",
    pros: ["Lowest TER", "Easiest to maintain", "Beats 80% of active funds long-term"],
    cons: ["US-heavy", "No alternatives or commodities"],
  },
  {
    id: "allweather",
    name: "Ray Dalio All-Weather",
    tagline: "Built to survive any economic season",
    blurb:
      "Hedges across growth, recession, inflation and deflation. Lower volatility, more bonds and commodities. Ideal for the risk-averse.",
    mix: [
      { label: "Long-term Bonds", pct: 40, ticker: "K-FIXED", color: "#F4A434" },
      { label: "Mid-term Bonds", pct: 15, ticker: "K-FIXED", color: "#FFC97A" },
      { label: "Global Stocks", pct: 30, ticker: "K-WORLDX", color: "var(--accent)" },
      { label: "Gold", pct: 7.5, ticker: "TGOLD", color: "#D4AE5C" },
      { label: "Commodities", pct: 7.5, ticker: "B-ASIATECH", color: "#7C7CFF" },
    ],
    expectedReturn: 5.4,
    expectedVol: 7.2,
    ter: 0.62,
    horizon: "Any",
    risk: "conservative",
    pros: ["Smooth ride", "Hedged against crises", "Lower drawdowns"],
    cons: ["Lower expected return", "Bond-heavy in low rates"],
  },
  {
    id: "thaicore",
    name: "Thai Conservative Income",
    tagline: "Home-biased, income-focused, lower volatility",
    blurb:
      "For investors who want to keep things close to home. Heavy on Thai fixed income with selective global equity for growth.",
    mix: [
      { label: "Thai Bonds", pct: 50, ticker: "K-FIXED", color: "#F4A434" },
      { label: "Thai Equity Dividend", pct: 25, ticker: "1DIV", color: "#D14545" },
      { label: "Global Equity", pct: 20, ticker: "K-WORLDX", color: "var(--accent)" },
      { label: "Cash", pct: 5, ticker: "K-CASH", color: "#9E9EA8" },
    ],
    expectedReturn: 4.6,
    expectedVol: 5.8,
    ter: 0.52,
    horizon: "3-7 yrs",
    risk: "conservative",
    pros: ["FX-stable", "Steady income", "Lower vol"],
    cons: ["Limited growth", "Home bias risk"],
  },
  {
    id: "growth80",
    name: "Growth Tilt 80/20",
    tagline: "For long horizons and stomach for volatility",
    blurb:
      "Aggressive equity tilt with global diversification. Accept bigger drawdowns in exchange for higher long-term return.",
    mix: [
      { label: "US Equity", pct: 40, ticker: "ASP-S&P500", color: "var(--accent)" },
      { label: "Global Equity", pct: 25, ticker: "K-WORLDX", color: "#7C7CFF" },
      { label: "Global Brands", pct: 15, ticker: "DAOL-WGG", color: "#C76A8F" },
      { label: "Thai Bonds", pct: 20, ticker: "K-FIXED", color: "#F4A434" },
    ],
    expectedReturn: 7.4,
    expectedVol: 13.8,
    ter: 0.71,
    horizon: "10+ yrs",
    risk: "growth",
    pros: ["Highest expected return", "Global diversification", "Compounds well long-term"],
    cons: ["Bigger drawdowns", "Concentration in US"],
  },
  {
    id: "permanent",
    name: "Permanent Portfolio",
    tagline: "Equal-weight across 4 asset classes — set and forget",
    blurb:
      "Harry Browne's classic. 25% each in stocks, bonds, gold, cash. Rebalance once a year. Boringly resilient.",
    mix: [
      { label: "Stocks", pct: 25, ticker: "K-WORLDX", color: "var(--accent)" },
      { label: "Long Bonds", pct: 25, ticker: "K-FIXED", color: "#F4A434" },
      { label: "Gold", pct: 25, ticker: "TGOLD", color: "#D4AE5C" },
      { label: "Cash", pct: 25, ticker: "K-CASH", color: "#9E9EA8" },
    ],
    expectedReturn: 4.8,
    expectedVol: 6.5,
    ter: 0.4,
    horizon: "Any",
    risk: "conservative",
    pros: ["Dead simple", "Resilient in every regime", "Cheapest"],
    cons: ["Lower return", "Gold drag in growth regimes"],
  },
  {
    id: "tdfu60",
    name: "Target-Date 2060 Glide",
    tagline: "Auto-adjusts risk as you age",
    blurb:
      "Aggressive equity now, glides toward bonds over decades. The 'set it and forget it' default in 401k plans worldwide.",
    mix: [
      { label: "US Equity", pct: 50, ticker: "ASP-S&P500", color: "var(--accent)" },
      { label: "International", pct: 30, ticker: "K-WORLDX", color: "#7C7CFF" },
      { label: "Bonds (growing)", pct: 15, ticker: "K-FIXED", color: "#F4A434" },
      { label: "Cash", pct: 5, ticker: "K-CASH", color: "#9E9EA8" },
    ],
    expectedReturn: 7.0,
    expectedVol: 12.4,
    ter: 0.55,
    horizon: "30+ yrs",
    risk: "growth",
    pros: ["Auto-rebalances over time", "Age-appropriate risk", "Hands-off"],
    cons: ["Higher TER than 3-fund", "Less control"],
    source: "Vanguard methodology",
  },
  {
    id: "coffeehouse",
    name: "Coffeehouse Portfolio",
    tagline: "Bill Schultheis · 7 slices, calm rebalancing",
    blurb:
      "Seven equal-ish sleeves with a bond core. Tilts toward small-cap and value. Diversification without complexity.",
    mix: [
      { label: "US Large Cap", pct: 10, ticker: "ASP-S&P500", color: "var(--accent)" },
      { label: "US Large Value", pct: 10, ticker: "B-USALPHA", color: "oklch(0.55 0.10 200)" },
      { label: "US Small Cap", pct: 10, ticker: "B-USALPHA", color: "#7C7CFF" },
      { label: "US Small Value", pct: 10, ticker: "B-USALPHA", color: "#C76A8F" },
      { label: "International", pct: 10, ticker: "K-WORLDX", color: "#5BA7B5" },
      { label: "REITs", pct: 10, ticker: "B-ASIATECH", color: "#F4A434" },
      { label: "Bonds", pct: 40, ticker: "K-FIXED", color: "oklch(0.55 0.07 200)" },
    ],
    expectedReturn: 6.2,
    expectedVol: 9.8,
    ter: 0.55,
    horizon: "Any",
    risk: "balanced",
    pros: ["Diversified across factors", "Lower volatility than 3-fund", "Easy to rebalance"],
    cons: ["Seven funds to manage", "Some overlap with smaller markets"],
    source: "coffeehouseinvestor.com",
  },
  {
    id: "golden_butterfly",
    name: "Golden Butterfly",
    tagline: "Tyler · Portfolio Charts · low drawdowns",
    blurb:
      "Equal weights across 5 sleeves designed to thrive in any economic regime. Strong historical drawdowns recovery.",
    mix: [
      { label: "US Stock", pct: 20, ticker: "ASP-S&P500", color: "var(--accent)" },
      { label: "Small Cap Value", pct: 20, ticker: "B-USALPHA", color: "#C76A8F" },
      { label: "Long Bonds", pct: 20, ticker: "K-FIXED", color: "oklch(0.55 0.07 200)" },
      { label: "Short Bonds", pct: 20, ticker: "K-FIXED", color: "#7C7CFF" },
      { label: "Gold", pct: 20, ticker: "TGOLD", color: "#D4AE5C" },
    ],
    expectedReturn: 5.6,
    expectedVol: 6.8,
    ter: 0.5,
    horizon: "Any",
    risk: "balanced",
    pros: ["Smooth across regimes", "Equal-weight simplicity", "Holds value in bear markets"],
    cons: ["Lower upside than equity-heavy", "Gold drag in growth years"],
    source: "portfoliocharts.com",
  },
  {
    id: "esg_tilt",
    name: "Global ESG Tilt",
    tagline: "Sustainable indices · climate-aware",
    blurb:
      "All-stock global tilt toward ESG-rated companies. For investors who want exposure to the broad market with a values screen.",
    mix: [
      { label: "Global ESG Eq.", pct: 70, ticker: "K-WORLDX", color: "oklch(0.55 0.13 150)" },
      { label: "EM ESG", pct: 15, ticker: "ASP-INDIA", color: "#7C7CFF" },
      { label: "Green Bonds", pct: 15, ticker: "K-FIXED", color: "#F4A434" },
    ],
    expectedReturn: 6.5,
    expectedVol: 13.1,
    ter: 0.82,
    horizon: "10+ yrs",
    risk: "growth",
    pros: ["Values-aligned", "Less fossil exposure", "Long-horizon growth"],
    cons: ["Higher TER than vanilla index", "Sector concentration in tech"],
    source: "MSCI ESG Leaders Index",
  },
];
