# Portfolio chart

*Last updated: 2026-06-22*

The big chart at the top of the Portfolio screen answers three everyday questions —
*how much do I have, how well is it doing, and what is it made of?* — one per
**mode**. This doc explains how to read each, and the one design rule that keeps
them honest. For *how* the value at each date is computed from your ledger, see
[Value over time = ledger replay](./decisions/0005-value-over-time-ledger-replay.md);
for how cash counts (or doesn't), see [Cash](./cash.md).

## The one rule: only the *mode* changes what the line means

The chart has three kinds of control, and exactly one of them is allowed to change
*what you're looking at*:

- **Mode** (the tabs read **Value · Return · Mix** — wealth · performance ·
  breakdown) changes **what is plotted** — the one control that changes the line's
  meaning.
- **Period** (1M, 3M, YTD, 1Y, 5Y, All) changes the **window** — how far back you look.
- **Scale** (a **`Log`** toggle — linear ↔ log) changes **how the line is drawn**
  — never what it is.

All five controls — period, mode, `Log`, the `Cash` toggle, and `+ Compare`
— sit in one flat worded toolbar below the chart, separated by thin rules. They
persist **per device** (localStorage), not across devices: the device usually
implies the use case (a phone glance vs a desktop deep-dive), so the chart reopens
however you last left it *here*.

That separation is deliberate. A control that *looked* cosmetic but quietly swapped
the underlying quantity — say, a scale toggle that also turned "your wealth" into
"your gain" — is exactly the kind of thing that makes a chart feel untrustworthy.
So period and scale are pure: they reframe the *same* fact. Only the mode switch,
which is explicitly labelled with what it plots, changes the quantity. We call this
**framing is orthogonal to scale**, and it's the reason several decisions below
look the way they do.

## The three modes

- **Value (฿) — "how much do I have / made."** Your wealth over time, with a
  contribution line and a gain wedge. The default.
- **Return (%) — "how well did it do."** A time-weighted return curve that
  ignores the timing of your deposits, so it reads how the *holdings* performed and
  compares fairly against a benchmark.
- **Breakdown — "what is it made of."** A stacked area of funds vs cash over time.

Each mode re-homes the controls that only make sense for it: the benchmark and the
`Cash` toggle belong to Value and Return; Breakdown swaps in a **Share / Amount**
toggle (share-of-100% vs absolute ฿) instead. The `Cash` toggle reads as a state on
the word itself — plain when investable cash counts (the default), struck through
when it's excluded — so it never looks like a remove button.

The returns live in a **scorecard** above the chart, not in a pill on the toolbar.
Each line is led by a gain/loss **▲/▼ caret**; the figure carries the colour and the
trailing label is muted context. Reading down: your **total value**, then the **bold
all-time** headline (money-weighted — what you made on what you put in; tap it for
the full breakdown), then the period rows that track the window — the **฿ you made**
in Value, the **time-weighted %** in Return, and (with a benchmark on) the gap, e.g.
*"0.8pp vs −2.8% S&P 500"*. The period rows sit a touch lighter than the headline,
so the set reads as one block with the all-time figure standing out. The ฿ windowed
row hides on "All" (it would just echo the all-time figure); the time-weighted row
stays on "All" in Return, since it's a genuinely different number from the
money-weighted headline.

Below the chart sits one **adaptive caption** — a single plain-language sentence for
the current view (e.g. *"Your time-weighted return over time"*). The jargon in it is
a dotted-underline **term** you tap for a short definition; longer "how to read it"
detail lives there and in the hover tooltip, keeping the always-visible line to one
readable sentence. The one inline exception is the actionable *Exclude cash* / *Include
cash* nudge, which appears when a benchmark is on and idle cash would skew the gap.

## Reading Value mode

A beginner only needs these three:

1. **The solid line is your wealth** — the real money value of the portfolio at
   each date, in baht.
2. **The faint dotted line is what you put in** — the running total of money you've
   contributed from outside (deposits in, withdrawals out). Buying and selling
   funds, or moving cash into a fund, doesn't move this line; only money crossing
   the boundary of the portfolio does. (The precise definition, and why a fund
   switch must *not* move it, is in [ADR 0005 §4](./decisions/0005-value-over-time-ledger-replay.md).)
3. **The shaded band between them is your gain** — green when your wealth is above
   what you put in, loss-red when it dips below. The gap *is* the gain, drawn to
   scale.

Hover any point and the tooltip spells out all three (value, net invested, gain),
plus the benchmark if one is turned on.

### Why the value line always shows your *actual* wealth

The value line shows **absolute wealth on every window** — ฿1,000,000, not
"+฿30,000 since the start of this month." Pick a 1-month window and you still see
your real balance over that month, not a line that resets to zero at the left edge.

This is a direct consequence of the one rule. The question "how did I do *this
particular window*?" has its own, better home: the **windowed figure in the
scorecard** above the chart (time-weighted in Return mode). That figure nets out the
timing of your deposits, so a big mid-month top-up can't distort it (the reasoning
is in the [decisions Picks table](./decisions/README.md#ledger--portfolio-math)).
Letting performance answer "this window" frees the value line to always mean one
thing — your wealth — which is also what makes the Log scale possible at all.

## Reading Return mode

Return mode plots a **time-weighted return (TWR)** curve. It chops the timeline at
each deposit or withdrawal, measures each stretch's return on the money actually
present, and chains them — so a deposit just starts a fresh stretch and **the curve
doesn't jump** when you add money. The endpoint is exactly the time-weighted % in the
scorecard, and a benchmark you turn on is normalised to the same start-at-zero
origin, so the gap between the two lines is genuine over/under-performance,
apples-to-apples. The fill is **sign-aware**: green where the line is above its
starting point (a gain), red where it's below (a loss), each fading out toward
break-even — so a down stretch reads as red without needing a labelled zero line.

The honest caveat (in the *time-weighted* term's tap-to-define note): TWR answers
*how the holdings performed*, not *how much you personally made*. Those differ whenever your
contributions are uneven — if you put a large sum in right before a dip, TWR can
look fine while your money-weighted (personal) return is negative. That personal
figure is the money-weighted return in the returns breakdown; the two together tell
the full story.

## Reading Breakdown mode

Breakdown is a **stacked area of funds vs cash** across the window — the one place a
zero-based axis is right, because height-from-zero *is* the quantity. It shows two
ways:

- **Share (%)** — the default. Each date sums to 100%, so you read composition
  directly (e.g. "cash crept up to 30%") without deposit-driven height jumps.
- **Absolute (฿)** — the real baht of each band, stacked to your total net worth.

The *funds and cash* term names the catch every value-weighted composition has:
shares drift with *market value* as well as with your trades, so a band growing
isn't necessarily a decision you made.

## The period window, and "auto-zoom"

Changing the period changes the slice of history on the x-axis. The ranges are
**1M · 3M · YTD · 1Y · 5Y · All**, defaulting to **1Y** (which gracefully shows
your whole history if the account is younger than a year). YTD is the year so far;
5Y appears only once the account is old enough for it to differ from All.

Inside the chosen slice the chart does a second, quieter thing: it **auto-fits the
vertical axis to the data in view** — sometimes loosely called *auto-zoom*. In the
linear view the bottom and top are set to the lowest and highest values *in the
window*, not to zero. So if your balance drifted from ฿1,000,000 to ฿1,030,000 over
a calm month, the chart still fills the plot with that 3% wiggle — you see the shape
instead of a dead-flat line pinned to the top of a ฿0–฿1,030,000 axis.

That the value line is **not zero-based** is deliberate. A zero-based axis is the
right tool for *quantities you stack* (which is why Breakdown uses one), but for a
single wealth line it wastes the screen, squashing every real movement into a thin
sliver near the top. Auto-fit is the opposite trade: it **reveals** movement, at the
cost of **exaggerating** it. A 1% month can look dramatic. Two things keep that
honest — the absolute numbers in the tooltip, and the Log scale.

## Linear vs Log: two honest ways to draw the same line

On every range, in both Value and Return, a small **`Log`** toggle redraws the
same line on a logarithmic axis. (The label uses the standard word every charting
tool uses, so it's instantly recognisable; the benefit — *equal % moves take the
same height* — is one tap away on the *log scale* term.) The two draws differ only
in what "equal height" means:

- **Linear** (default): equal **baht** (or percentage-point) moves are equal height.
- **Log**: equal **percentage** moves are equal height. A doubling looks the same
  size wherever it happens; steady compounding shows as a roughly straight line; and
  an early -30% fall looks as big as a later -30% fall, instead of being visually
  crushed by everything that grew after it.

**When Log earns its keep:** wide ratio spans — long horizons where compounding on a
linear axis makes recent years tower over early ones and quietly flatters the
portfolio (it *looks* like it got more effective over time when it didn't). Over a
few months a steady book barely moves, so Log and Linear look nearly identical — but
a volatile (crypto/stock) book can swing enough even in a short window for Log to
help, so the toggle is offered on **every** range rather than gated to long ones.

**The honest caveat:** in Value mode, Log un-crushes the
early years but does **not** remove the vertical *steps* a deposit makes — adding
money is a real change in wealth, so it shows as a step in both scales (Log just
compresses it). The deposit-distortion fix is Return mode, not Value·Log.

### Why Log needs a positive line (the engineering tie-in)

A logarithm is undefined at zero and below. The window-resetting value line from
older builds went *negative* whenever you were underwater for the period — which is
why Log used to be impossible on anything but All. Making Value plot **absolute
wealth** (always positive), and Return plot a **growth factor** (starts at 1,
always positive), is what unlocks Log on any window. The one place wealth still hits
exactly ฿0 is a stretch fully **out of the market** — every position sold, no held or
in-transit cash. A log axis can't place that, so the chart draws those dates as a
**gap** (a line break, on both scales): honest — you held nothing — and it keeps the
axis valid because every plotted point is positive. (It falls back to Linear only if
*nothing* positive is plotted.) **Mix** gaps across the same stretch — the funds-vs-cash
split is undefined (`0/0`) with nothing held, so a break is truer than a "0% of
everything" band. **Return** stays continuous there: its growth factor is *flat but
defined* while you hold nothing (no return on zero capital), and never zero, so it
needs no gap. Two more details fall out of the same rule: the Log
domain is clamped to the wealth line (not the near-zero early contribution line,
which would squash the floor), and the gain
shading on Log is drawn as value-pair bands rather than the additive stack (which is
meaningless on a ratio axis), so the gain still reads while the dotted contribution
line keeps deposit steps attributable.

## The control model at a glance

| Control | Job | Changes the meaning of the line? |
|---|---|---|
| **Mode** (Value/Return/Mix) | Sets what is plotted | **Yes** — this is the one |
| **Period** (1M…All) | Sets the time window (x-axis) | No |
| **`Log`** toggle | Sets how the line is drawn (linear ↔ log, y-axis) | No |
| **Auto-fit** (automatic) | Frames the y-axis to the window's data, not to ฿0 | No |
| **Windowed return** (scorecard) | "How did *this window* do" — ฿ in Value, time-weighted % in Return | (separate figure) |
| **Cash** toggle | Whether investable cash counts in the line + return | Changes the *cash basis*, applied consistently everywhere — see [Cash](./cash.md) |
| **Share / Amount** (Breakdown) | Stacks to 100% vs to ฿ total | No (reframes the same composition) |

## Planned direction

Breakdown today splits **funds vs cash**. The natural deepening is composition by
**asset class** (equity / bond / alternative / cash) over time, which needs a new
per-date breakdown emitted by the series engine rather than the cash split that
already exists. It's forward-looking; product intent lives in
[Product direction](./product-direction.md) and the
[roadmap board](https://github.com/users/Sitthinut/projects/2), not as a behavior
claim here.

## In the code

- `NavChart` in [`components/InteractiveCharts.tsx`](../../components/InteractiveCharts.tsx)
  draws both line views — the two-line wealth view (Value) and the single-line view
  (Return) — and takes the `scaleMode` (`"linear" | "log"`) prop; `BreakdownChart`
  in the same file draws the stacked funds/cash area.
- `twrSeries` in [`lib/portfolio/twr.ts`](../../lib/portfolio/twr.ts) builds the
  Return curve as a positive growth factor, reusing `periodTwr`'s flow-netting
  so the curve's endpoint equals the scorecard's time-weighted figure.
- [`components/screens/PortfolioScreen.tsx`](../../components/screens/PortfolioScreen.tsx)
  owns the worded toolbar — period (YTD is a client-side clip of a 1Y fetch; 5Y is
  gated on inception), the mode switch, the `Log` toggle, the `Cash`
  toggle, and `+ Compare` — plus the returns scorecard, and feeds the charts their
  series. View state (period, mode, scale, cash basis) persists per-device via
  [`lib/useLocalStorageState.ts`](../../lib/useLocalStorageState.ts); the cash note
  and the Compare menu place themselves with
  [`lib/usePopoverPlacement.ts`](../../lib/usePopoverPlacement.ts).
