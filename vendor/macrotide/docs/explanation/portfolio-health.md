# Portfolio health

Macrotide's Portfolio screen answers one question — *is anything off, and what
should I do about it?* — without inviting the daily score-chasing that
measurably harms passive index investors. It does that with:

- **A plain-language headline** — the single most important thing right now, in
  a sentence ("Nothing needs attention — keep contributing"), with a "Discuss
  with Advisor" prompt. This leads the screen.
- **Four named checks** — drift, fees, diversification, cash — each shown as a
  value + a status (good / watch / act) + a one-line reason. Independent,
  individually actionable, scannable.
- **Analytics as drill-down** — allocation, drift table, region look-through,
  single-name overlap — one tap below the checks, never the lead.

There is deliberately **no single 0–100 "portfolio quality" grade** in the UI.
The component math still exists and the Advisor reads it internally, but a
chase-able headline number is not shown. The rest of this doc explains why, and
how the trickiest check — diversification — is computed honestly on partial
data.

## Why no single grade

Macrotide used to lead with a transparent 0–100 composite (drift 30, fees 25,
concentration 25, cash 20). It was well-built — deterministic, no AI, every
deduction explained. The problem was never the math; it was framing one number
as *the* number. Three reasons it was demoted:

1. **False precision from arbitrary weights.** "Why is fees worth 25 and cash
   20?" has no principled answer. Blending non-commensurable units (drift pp +
   fee % + a concentration index + cash %) behind fixed weights manufactures
   confidence the inputs don't support — a poor fit for an app that openly warns
   "don't rely on it for real decisions." Methodological guidance on composite
   indicators is explicit here: the weights act as implicit *trade-offs* (a
   weakness in one dimension silently offset by strength in another), so a
   weighting choice not grounded in theory is arbitrary and demands sensitivity
   analysis before anyone leans on the headline.[^composite]

2. **A tracked number should be actionable.** Nielsen Norman Group's rule for
   metrics: a change in a surfaced number should map to a real change the user
   can act on. A composite drifting 78 → 74 doesn't tell you what to do — the
   *component* that moved does. A blended grade is a vanity metric; the named
   checks are not.[^nng-vanity]

3. **A grade is a check-back-and-optimise hook — exactly what hurts passive
   investors.** The behavioural evidence is one-directional: frequent checking
   and tinkering measurably lower returns (Wealthfront cites daily-checkers
   earning ~0.2%/yr less, twice-daily ~0.4%/yr less, and notes that viewing
   asset-level performance amplifies loss perception).[^wealthfront] The
   documented wins come from *inaction* — staying invested, moving cash into the
   market, not trading cleverly.[^morningstar-inertia] A "get the number up"
   loop works against the one behaviour an index investor should keep: do
   nothing and keep contributing.

The credible heavyweight for portfolio analysis — Morningstar's Portfolio X-Ray
— deliberately does **not** roll quality into one number. It shows distinct
lenses (asset class, sector, region, expense ratio, single-holding influence)
and lets you drill.[^xray] Single scores in the market are either scoped
goal-readiness projections (Empower / Fidelity retirement scores) or lead-gen
devices (SigFig) — never a persistent "how good is your portfolio" grade. The
named-checks list mirrors X-Ray's panel-of-lenses; the plain-language headline
mirrors the calm, low-frequency framing the behavioural literature endorses.

The composite is kept in code (`lib/portfolio/score.ts`) because the Advisor
benefits from a rolled-up internal signal, and `/api/analysis` still returns it.
It is simply not the user's headline.

## The four checks

Each check is a pure function of the health signals
(`lib/portfolio/health.ts`) — no AI, no network, every status explained by a
short reason string. Two correctness invariants hold across all of them:

- **Missing data never fakes a score.** A holding with no published fee is
  excluded from the blended rate (numerator *and* denominator), not counted as
  0%.[^fee] Look-through we don't have is treated as unknown, never as "clean"
  (see [Diversification](#diversification-the-hard-one)).
- **The absence of a plan is not a perfect score.** With no target model, drift
  is *undefined*, so it is excluded — not awarded full marks. Rewarding the
  absence of a plan would be dishonest.

| Check | Value shown | Good / watch / act on… |
| --- | --- | --- |
| **Drift** | pp off your target mix | tracking gap vs the target model (no target → a "set a target" prompt, not a grade) |
| **Fees** | blended TER % | weighted expense ratio vs index-grade bands; unknown-fee holdings flagged, not scored |
| **Diversification** | top fund % · top 3 % | single-fund size + underlying look-through (below) |
| **Cash** | cash % | uninvested cash as a drag on long-term returns |

Drift, fees, and cash are direct reads of signals macrotide already computed.
Diversification is the one that needed a rethink.

## Diversification — the hard one

### Why fund-count HHI was wrong

The old concentration component scored a Herfindahl–Hirschman index over
*fund-level* weights. That is wrong in **both** directions for an index
investor:

- **It punishes clean broad-index portfolios.** A textbook *one world-equity
  fund + one bond fund* book has a high fund-count HHI and scored as "highly
  concentrated" — even though, underneath, it holds thousands of names across
  every region. The metric measured *how few funds you hold*, which is not a
  risk.
- **It is fooled by hidden redundancy.** Five funds that all track the S&P 500
  look diversified to a fund-count metric (five holdings!) while being ~100% US
  large-cap underneath — the exact concentration that matters, invisible to HHI.

The replacement measures concentration where it actually lives: in the
*underlying* exposure, with the fund-level facts as a certain floor.

### The two parts

Diversification is now two independent checks; **the worst status wins** (a
category, not an arithmetic blend of penalties):

- **B2 — single-fund size.** Flags when any one *equity or alternative* holding
  is too large a share of the book (>35% → act, 25–35% → watch). This reuses the
  existing advisory threshold, needs no extra data, and always ships. Bonds and
  cash are exempt: a 45% *bond* fund is a conservative tilt, not concentration
  risk — it surfaces under cash/allocation, not here. The acid test: a clean
  *world-equity + bond* book must read **good**, and it does.

- **B1 — look-through.** Aggregates what each fund holds *underneath*, across
  funds, two ways:
  - **Single-name overlap** — the largest single underlying company as a % of
    the whole book, summed across every fund that holds it (Morningstar calls
    this "Stock Intersection": the five-"diversified"-funds investor who is
    secretly 15% in one mega-cap).[^intersection] Macrotide reports it as a
    **lower bound** — "*at least* ~4% is Apple, across 2 funds" — because for
    most funds we only have their top-5 holdings, which capture a minority of
    NAV. (Even Morningstar's Stock Intersection truncates to each fund's top 50
    and flags the result as incomplete for funds with many holdings;[^intersection]
    our top-5 is a deeper truncation, so "at least" is the only honest framing.)
    A **redundancy flag** ("these two funds share their whole top-5 →
    effectively the same exposure") rides alongside; it is high-confidence even
    on thin data.
  - **Region** — measured **against your target**, not as an absolute. 100% US
    is usually *intended* for a global index investor (the world is ~60% US by
    market cap), so an absolute region penalty would punish a correct, deliberate
    tilt. Instead, region is drift-in-disguise: it flags only when actual region
    weight diverges from what your plan implies (90% US when your target implies
    ~60%), capped at "watch". With **no target**, region is shown as plain
    disclosure — a statement, never a deduction. *Today the per-fund region data
    is too coarse (a single foreign/domestic/mixed mandate) to compute that
    divergence honestly, so region ships as disclosure only; the scorer already
    accepts a region-divergence signal, so the target-relative flag activates for
    free once richer region data lands.*

### The asymmetry that makes partial data honest

Look-through coverage is partial and lumpy — full underlying holdings for a
handful of funds, top-5 for some, a coarse region mandate for most, nothing for
many Thai funds. For a typical book we might "see through" only half the equity.
The metric must never imply it X-rayed 100% when it saw 50%. The rule that makes
this honest is **asymmetric**:

> Look-through may *escalate* concern. It may never *grant* comfort.

The absence of a bad finding in half-visible data is **not** evidence of
diversification — so it can never improve the status or add points. A confirmed
ugly finding *can* lower the status, gated by how much we actually saw:

| Equity look-through coverage | Look-through may drive… |
| --- | --- |
| **High (≳ 60–75%)** | good / watch / act — trusted |
| **Partial (~40–75%)** | **watch** at most, with the coverage caveat in the copy ("based on the ~40% we can see") — never **act** |
| **Low (< ~40%)** | disclosure only — the status is set by the certain fund-level fact |
| **Zero** | the check silently degrades to the fund-level diversification read |

This single rule dissolves the two traps a naïve coverage-weighted blend falls
into: missing data can't fake a *good* score (absence never certifies), and 20%
coverage plus one ugly name can't tank a *bad* one (a low-coverage finding caps
at "watch"). We never multiply a penalty by a coverage fraction; we gate
*whether a flag may fire and how loudly*.

In the internal composite, the same asymmetry applies: look-through can only
**subtract** on a high-confidence finding, never add, and missing data is
neutral — so a clean portfolio with thin coverage keeps full marks. Fund-count
HHI is dropped as the basis entirely.

### How it's presented

The check's **value stays the certain fund-level fact** (`Top fund 38% · top 3
60%`) — fully known, no caveat, the number a passive investor can act on.
Look-through lives in the *reason* prose, where its hedge sits naturally, never
as a competing headline number. Coverage is a rounded clause ("the ~85% of your
stocks we can see"), **never a gauge or a dial** — a coverage % rendered as a
half-empty arc reads as a grade you're failing and invites "get coverage up", a
number the user cannot act on.

When look-through finds concentration that is *inherent to index investing*
(global funds are US-heavy by design), the copy names it as **expected** so the
user doesn't "fix" what isn't broken. When it finds *genuine* hidden
concentration, the copy says "worth understanding" and routes to the Advisor —
never "rebalance now", never a trade button. It is an *understanding* surface,
consistent with the don't-tinker ethos.

This keeps the build within macrotide's purity rule: `lib/portfolio/health.ts`
and `score.ts` stay DB- and network-free. The look-through aggregation is
computed server-side from `market.db` (feeder look-through + top-5 holdings +
the per-fund region mandate) and injected as a precomputed argument.

## What was decided, and what was held

- **Drop the 0–100 headline grade from the UI; keep the math internal.** Chosen
  over keeping a muted "3 of 4 good" roll-up — cleaner and more honest.
- **Concentration = independent flags, worst-status-wins.** Rejected the
  "worse-of(region, single-name)" combinator: a `max()` over two
  non-commensurable lenses over-fires on exactly the clean global portfolios the
  redesign exists to protect.
- **Region is target-relative / disclosure-only**, never an absolute penalty.
- **Look-through escalates only, coverage-gated** — rejected the
  coverage-weighted score blend.
- **Component weights are unchanged** (drift 30 / fees 25 / diversification 25 /
  cash 20). Re-weighting was considered and **held**: the weights are arbitrary
  either way, and since the composite is no longer the headline, re-tuning them
  is low-payoff. The honest fix was hierarchy and the concentration math, not
  new weights.

## Related

- [Architecture](./architecture.md) — the two-database split (look-through data
  lives in regenerable `market.db`) and where health/score code sits.
- [Design principles](./design-principles.md) — deterministic, transparent,
  "honest mirror".
- [Product direction](./product-direction.md) — the index-purist north star:
  behaviour and cost, not prediction or engagement.
- [Decisions log](./decisions/README.md) — the one-line locked picks.

---

[^nng-vanity]: Nielsen Norman Group, *Vanity Metrics: Add Context to Add
    Meaning* — a surfaced metric should be actionable; context (rates, time
    windows, comparison to a target) is what makes a number meaningful.
    <https://www.nngroup.com/articles/vanity-metrics/>

[^wealthfront]: Wealthfront, *How Often Should You Check Your Portfolio?* —
    daily-checkers earn ~0.2%/yr less, twice-daily ~0.4%/yr less (figures from a
    SigFig study of tracking-software users, the cause being overtrading); it
    also cites a *Journal of Behavioral Finance* finding that viewing
    asset-level performance lowers risk tolerance.
    <https://www.wealthfront.com/blog/often-check-portfolio/>

[^morningstar-inertia]: Morningstar, *The Long View* podcast with Vanguard's
    head of behavioral economics Andy Reed — *Inertia Is the Most Powerful Force
    in Behavioral Finance*: for the vast majority of investors the right move is
    to do nothing, and good design harnesses that inertia rather than fighting
    it.
    <https://www.morningstar.com/personal-finance/andy-reed-inertia-is-most-powerful-force-behavioral-finance>

[^xray]: Morningstar Portfolio X-Ray presents distinct lenses — asset class,
    sector, region, weighted expense ratio, single-holding influence — as an
    analysis panel, not a single quality grade.
    <https://www.morningstar.com/help-center/portfolio/xray>

[^intersection]: Morningstar's "Stock Intersection" aggregates the same
    underlying security across all your funds and reports its total weight,
    naming which funds contribute — the canonical single-name-influence lens. It
    uses each fund's top 50 holdings and notes this "may result in incomplete
    analysis for funds with a large number of holdings."
    <https://www.morningstar.com/help-center/portfolio/stock-intersection>

[^composite]: OECD / EC Joint Research Centre, *Handbook on Constructing
    Composite Indicators: Methodology and User Guide* — the canonical reference
    on composite-index methodology. It treats weights as trade-offs
    (compensability: a low score on one indicator offset by a high score on
    another) and stresses that weighting and aggregation choices must be grounded
    in a theoretical framework and tested for robustness, not assumed.
    <https://www.oecd.org/en/publications/handbook-on-constructing-composite-indicators-methodology-and-user-guide_9789264043466-en.html>

[^fee]: Excluding unknown-fee holdings from both numerator and denominator (vs
    the old `ter ?? 0`, which scored unknowns as free) — see `blendedTer` in
    `lib/portfolio/health.ts`.
