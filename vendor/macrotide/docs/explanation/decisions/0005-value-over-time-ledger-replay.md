# ADR 0005 — Value-over-time by ledger replay: honest units, settlement cash, a contribution line

**Status:** Accepted (§5's chart framing later superseded by the chart redesign — see the note under §5). **Builds on [ADR 0004](./0004-unified-ledger-positions-derived.md)** (the ledger is the source of truth for positions).

**Context:** The portfolio value-over-time chart computed `value(date) = Σ current_units × NAV(date) × fx` over whatever holdings exist *today*. Three defects fell out of that one formula:

- **Variable basket.** The sum included, on each date, only holdings that had a NAV that day, and kept a date as long as *any* holding did. So the total silently summed a **different basket on different dates** — when a holding's NAV coverage began, the line stepped. On real data a holding's coverage starting one day read as a **~18% overnight jump** that never happened.
- **Back-projected units.** Today's folded unit count was multiplied against *every* past NAV, so any buy/sell inside the window drew today's position size as if it had always been held. A single "Balance" entered today implied a multi-year holding.
- **Current-holdings basket.** Fully-exited positions vanished from history entirely, because the basket was `listHoldings()`, not the ledger.

ADR 0004 made the ledger the source of truth and `reduceLots` the fold, but the fold only returned the *terminal* position — there was no point-in-time replay. This ADR records how the chart became an honest wealth curve.

## The questions

1. How do we draw **units held on each past date** without back-projection — and keep exited positions in history?
2. How do we price dates a fund was held **before its NAV cache begins** (real data: cache coverage starts years after the earliest trades; some exited funds have no NAV at all)?
3. How do we stop a **fund switch** (sell A, rebuy B days later) from drawing a fake drawdown for the days the money is in transit?
4. How do we draw a **contribution line** so the gap to the value line reads as gain?

## Decision

**Replay the ledger per bucket; value each date from the position *as of that date*, plus the bucket's in-transit cash. Draw a second line for cumulative external money in.**

### 1. Point-in-time units (no back-projection)

`reduceLots` emits a `positionTimeline` — one `{date, units, costBasis}` checkpoint per event, from the same running state as the terminal fold (so the replay can never disagree with the holdings projection). The series does an **O(events + dates)** merge walk per position. **A position contributes 0 before its first ledger event** — a Balance entered today is a single point today, never a back-projected curve. The basket is the **ledger**, so exited positions keep contributing over the dates they were held.

### 2. Pricing ladder — trade-implied prices, not clipping or flat-fill

Per cache key, merge cached `nav_history` with **trade-implied prices** recovered from the ledger itself (a trade's execution price, else `|amount| ÷ units`; a Balance's `value ÷ units`), then forward-fill. This prices the pre-coverage era from prices the user **actually transacted at** — real data, not a fabrication. Cost-basis carry is the last resort; a position with neither price nor basis is dropped and reported (`unpriced`). The latest estimate-priced date is surfaced as `estimatedThrough` for a disclosure caption.

- **Rejected — clip to common coverage:** start the aggregate only where every held position is priceable. On real data this clipped a multi-year book to ~the present (a long-held fund whose NAV cache is shallow, and exited funds with no NAV, dominate the start date). Pairs poorly with the goal of showing wealth growth.
- **Rejected — flat-fill earliest NAV backward:** keeps history long but fabricates flat early segments that hide real movement. Trade-implied pricing uses real prices for the same span.

### 3. Settlement cash — model it, don't paper over the dip

Fold a per-bucket **settlement-cash** balance from the trades: a `sell` opens a FIFO cash lot; a `buy` consumes live lots; the value line adds the live cash. The switch dip vanishes by construction — proceeds *are* cash the instant the sell settles, cash *becomes* units the instant the buy settles — with no matching window, correct for partial rebuys, overlapping switches, losses, and dividends.

The open question was **idle cash**: proceeds a user never reinvests. A **30-day retroactive expiry** is the foolproof default — proceeds unconsumed within the window are treated as withdrawn **at the sell date** (the chart steps only on real event dates), while proceeds younger than 30 days from today stay as genuine in-transit cash.

- **Rejected — keep idle cash forever:** a sell-and-walk-away user's chart shows phantom wealth indefinitely. The expiry caps that failure to a parked-cash period reading as out-of-market — a conservative error, disclosed, and **correctable** once explicit cash events exist.
- **Rejected — FIFO-match buys to sells within a window:** an elaborate way to *infer* a cash balance we can simply *compute*. Every failure mode (partial rebuys, overlapping switches, losses) disappears once cash is a real per-bucket position.
- **Follow-up:** explicit `deposit`/`withdraw` kinds + a cash Balance anchor ([#149](https://github.com/Sitthinut/macrotide/issues/149)) let recorded truth override the heuristic; explicitly deposited cash never expires.

### 4. Contribution = cumulative external flows, NOT `netInvested`

The contribution line is the running sum of the settlement fold's **external flows**: a buy's shortfall beyond available cash is money in; a withdrawal (expired proceeds) is money out. It is deliberately **not** `reduceLots().netInvested`, which subtracts sale *proceeds* (the right sign convention for XIRR) and so would phantom-swing on every switch. Reinvests, dividends, and fees are not external flows. The gap (value − contribution) is gain; the UI tints it as a signed wedge.

A withdrawal removes only the proceeds' **cost basis** (return of capital), never the realized gain riding in them — each settlement cash lot carries its cost basis (from `reduceLots`' realized events, keyed by sell-txn id), reduced proportionally as the lot is reinvested. Without this, cashing a position out at a profit would subtract the full proceeds and drive net contribution **negative** (e.g. buy ฿16k, sell ฿17.6k and walk away → −฿1.6k, the realized gain with a flipped sign). With it, contribution returns toward 0 and floors there; the withdrawn gain simply leaves the chart (the value line still loses the full proceeds). An uncosted sell falls back to treating all proceeds as capital.

This cost-basis rule is right for the **money-weighted** contribution line, but the **time-weighted** return needs the opposite: a walk-away exit must strip the *full proceeds* (the market value that actually left) or the realized gain reads as a phantom market loss. So the fold emits a parallel `returnFlows` series — identical except expiries leave at full proceeds — that feeds TWR only (see the Picks table, *TWR walk-away*).

### 5. Window-rebased chart, money-weighted return pill

A **clipped** range (the series carries pre-window state) rebases both lines to the window start, so "1M" answers *"how did I do this month"*; **All** keeps absolute lifetime levels.

The period-return pill is **money-weighted (gain ÷ invested)**, not the old last-÷-first-value ratio: now that the value line carries contributions, a price ratio reads deposits as return (on the real book, +41,000% over All). Lifetime divides total gain by total contributions; a windowed range divides the window's change-in-gain by the wealth held at window start. It matches the tooltip's Gain %. (This makes the chart's "All" return diverge from the hero "all-time" P/L, which is cost-basis-based and inflated by reinvested gains — reconciling them + a returns-breakdown surface is tracked in [#152](https://github.com/Sitthinut/macrotide/issues/152).)

> **Superseded by the chart redesign (later refined).** §5 above is the original (#153) decision, kept as the record; the chart's framing has since moved on:
> - **No window-rebasing.** The value line plots **absolute wealth on every range** — the scale toggle (linear/log) changes only *how* the line is drawn, never *what* it means; only the **mode** (Value / Return / Mix) changes the quantity. An always-positive absolute series is also what makes a log axis valid.
> - **Period return → time-weighted (TWR).** The money-weighted pill was replaced by a time-weighted figure that nets external flows out, so a mid-window deposit can't distort the window.
> - **`Log` toggle (log scale) on every range + fully-out gap.** Log is offered on every range (not just ≥1Y); a stretch fully **out of the market** — value exactly ฿0, unplottable on a log axis — renders as a **gap** (a line break, both scales). Mix gaps likewise; Return stays continuous (its growth factor is flat-but-defined while out, never zero).
>
> The live decisions are the [Picks-table](./README.md) rows *Period (range) pill = time-weighted return* and *`Log` toggle (log scale) on every range + gap fully-out periods*.

### 6. Estimate disclosure is materiality-gated

History priced from trade-implied prices / cost-carry is flagged via `estimatedThrough`, but only on dates where the estimate-priced share exceeds **2%** of the day's value — so one dust holding with shallow NAV coverage can't caption the whole chart as estimated, while a genuinely unpriceable major holding still does.

## Consequences

- The chart can never disagree with the holdings projection or analytics — same fold, same `foldableEvents` pre-pass (value-only Balance units derived at trade-date NAV; unresolved anchors dropped).
- Legitimate steps remain: a snapshot anchor's restatement, and the handoff where estimate pricing yields to cached NAV. These are honest and disclosed, not smoothed.
- The 30-day window is a heuristic, documented in one place (`SETTLEMENT_WINDOW_DAYS`); the explicit-cash follow-up is the principled escape hatch.
- Demo mode runs the **same replay path** (a dated trade story + a per-unit-NAV fixture), so demo can't validate a code path the owner never hits.

## Where this lives

- `lib/portfolio/lots.ts` — `reduceLots` `positionTimeline`.
- `lib/portfolio/settlement-cash.ts` — `foldSettlementCash` (cash lots + external flows).
- `lib/db/queries/series.ts` — `getPortfolioSeries` (replay, pricing ladder, aggregation).
- `lib/db/queries/resolve-derived-units.ts` — the facts-only pre-pass (ADR 0004).
- `components/InteractiveCharts.tsx` — the two-line wealth chart.
