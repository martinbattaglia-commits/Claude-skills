# Cash

*Last updated: 2026-07-01*

How Macrotide tracks real cash — bank balances, parked sale proceeds, dry
powder — as a first-class part of the portfolio, and how it keeps cash from
quietly distorting your return. This is the *why and how*; for the one-ledger
model cash extends see [Balances and History](./balances-and-history.md), and for
the settled calls see the [decisions Picks table](./decisions/README.md#ledger--portfolio-math).

## The one idea: cash plays three roles, and "separate from invested?" is answered per role

Cash is wealth, but idle cash is also an *allocation decision*. Those two truths
pull in opposite directions, and the trick is to answer "does cash count?"
separately for each thing the app shows:

| Role | How cash is treated | Is "separate" a choice? |
|---|---|---|
| **Net worth** | Always *in* — cash is money you have. | No. |
| **Allocation** | Always its own class (a `cash` slice in the donut). | No. |
| **Return / contribution** | Governed by the **boundary** (below) — and by the account's **Purpose**. | **Yes** — the only role where it's a real choice. |

This split is the spine of the whole feature: net worth and allocation always
sum the *full* balance, and only the return treatment ever excludes a slice. That
invariant is what stops any of the controls below from double-counting.

## The boundary model

Return is computed against money that crossed the **portfolio boundary** — the
GIPS / Portfolio Performance external-cash-flow model:

- Money crossing the boundary (your wallet ⇄ the portfolio) is a **contribution
  or withdrawal** — the only thing that moves "net invested."
- Money moving *inside* the boundary (cash ⇄ fund, fund ⇄ fund) is an **internal
  transfer** — no contribution change. (This is exactly what the in-transit
  settlement heuristic already inferred for fund switches; explicit cash makes it
  visible.)
- A **balance assertion** ("the cash is now ฿X") is a **reconciliation**, neither
  a contribution nor a withdrawal.

A consequence people find surprising: **idle cash inside the boundary honestly
drags your money-weighted return** — you chose not to invest it, and the return
reflects that. Sharesight and Portfolio Performance behave identically (a deposit
is performance-neutral at the instant it lands: the value and the inflow cancel).
That drag is a planning signal, not a bug — and the Purpose and Return-basis
controls below are how you tell the app which drag is real.

## Cash kinds and the fold

Cash is opt-in and additive: **with zero cash accounts, every number is exactly
what it was before.** When you do record cash, three event kinds drive it, all
ordinary ledger events ([ADR 0004](./decisions/0004-unified-ledger-positions-derived.md)'s
facts-only model — store the fact, derive at the fold):

- **Deposit / Withdraw** — explicit dated external flows (+/−), the precise path.
- **Set balance** — the hero. "As of date D this account holds ฿X." The change vs
  the prior balance is classified **automatically**: a raise first absorbs any
  sale proceeds still in transit (the seam below) and only the remainder counts
  as money in; a drop counts as money out. The first balance is just this with a
  prior of zero. ("Set balance", not "Cash balance" — the noun didn't signal
  *set, not add*.)

A cash account is **not a first-class entity** — it's emergent from the ledger, a
ticker whose `quote_source` is `cash`. The **ticker is the account's identity**;
there's no separate id, so a rename cascades through the ledger (and its Purpose)
in one write, the same way `editHoldingViaLedger` re-tickers every row. Moving a
balance between accounts is two Set balances (old → ฿0, new → amount); net worth
nets on the date, no "transfer" row (facts-only).

### Valuation: 1.0 × FX

A cash account values at **1.0 in its own currency**, folded by `reduceLots` from
**native** units (the account-currency amount, avg cost 1) like any other
position, then converted to baht through the **same single `fx.rateOn` source**
the rest of the app uses — never a second FX path, so cash and funds can't
disagree on a rate. A **non-THB account** is fully supported: the Add/Record
entry form carries a **currency picker** and auto-fills the **trade-date FX rate**
(from the keyless Frankfurter cache via `/api/fx`, editable), stored as `fxToThb`
on the row. The native balance rides in `units`; the trade-date rate values the
*contribution* while the *current* value floats at today's `fx.rateOn` — so an FX
move on foreign cash shows up honestly in the return.

### The seam with the in-transit heuristic

The value-over-time chart already carries **in-transit settlement cash** — when
you sell a fund and buy another within ~30 days, the proceeds are inferred as
cash in transit so the switch doesn't read as a drawdown
([ADR 0005](./decisions/0005-value-over-time-ledger-replay.md)). That heuristic
is the **untracked-cash path** and is essentially unchanged. Explicit cash meets
it at exactly one seam, kept clean so proceeds never live in two places:

- A **Set-balance raise absorbs live in-transit proceeds first** — a redemption
  pays out to your bank, so a recent sale routinely lands inside a routine
  balance update, and that part is the same money changing rooms, not a
  contribution. The absorbed lot's cash migrates into the held-cash position at
  the assert date (never read as withdrawn), and **only the remainder counts as
  money you added** — so a mixed raise (salary + proceeds) splits itself
  correctly with nothing to configure. This is arithmetic over the ledger, not a
  setting: there is no classification control, so there is nothing to set wrong.
  The entry form **narrates** the split before you save ("฿20,000 of this is
  your recent fund sale landing; ฿30,000 is counted as money you added"); a
  first balance narrates nothing (its full amount counting as capital is correct
  and needs no alarm). Two edges stay deliberately simple: **interest** counts
  as a small contribution (conservative — it understates the return, never
  flatters it), and a **typo** is fixed by editing the wrong row in History, not
  by a corrective assert. Rows saved with the retired "no money moved" override
  (`reconcile`) keep their meaning — a pure restatement, no flow, clears the
  lots — and History tags them "no money moved".

The two streams **compose** rather than collide: with no cash accounts the
heuristic runs alone (today's behavior), and where they meet, the reconcile clears
the heuristic lot precisely instead of a blunt "suppress expiry whenever cash
exists."

## No-deduct: a buy doesn't touch your cash

A fund **buy is just a buy** — it never silently debits a tracked cash account.
Cash accounts move *only* on explicit cash events. Two reasons:

1. **No attribution to guess.** A buy in macrotide isn't tagged to a cash
   account, so auto-deducting would need a rule to pick *which* of several
   unlinked accounts funded it — a guess the app shouldn't make. (Monarch
   deliberately treats a buy as a transfer, not a cash flow, for the same reason;
   nobody auto-guesses across unlinked accounts.)
2. **It stays honest.** Auto-deducting done by halves — moving the contribution
   number but not the value position — fabricates a phantom gain. No-deduct keeps
   value and contribution moving together at every explicit event, so there's
   **zero fake gain**, whether or not you reconcile.

The affordance is a gentle, dismissible **"funded from cash?"** card, shown on
History after saving a buy a tracked account could have funded — one tap records
the matching withdrawal, and the buy(+) and withdraw(−) net to zero, turning it
into an internal transfer. The check runs server-side on the **post-heuristic
shortfall** — only the part of the buy that in-transit sale proceeds did *not*
cover — so a buy that reinvested a recent sale never fires it; and it never
offers a Reserved account (that money is set aside by definition). Ignore it and
nothing breaks: both contribution and net worth are inflated by the same buy
amount, so the **gain stays correct**, and the next Set balance (which defaults
to "money out" when it drops) cancels the buy's contribution exactly. Lazy
reconciliation lands at the same right answer as the one-tap card.

## Purpose: Role + Label

Every cash account carries a **Purpose** — the answer to "what is this money
for?" — expressed as a per-account designation, never as new money. It has two
levels:

- **Role** (drives the math, a fixed pair): **Investable** (the default —
  dry powder, counts toward your return) or **Reserved** (an emergency fund or
  goal savings — excluded from your return, shown as its own allocation slice,
  full balance still in net worth).
- **Label** (the objective, optional free text with autocomplete): "Emergency",
  "House", "Retirement". Decoupled from Role, so investable cash can carry an
  objective too.

This is the **one earmark system**. A Purpose is *a designation of existing
money*, so the invariant holds: **net worth and allocation always sum the full
balance**, and only the return boundary splits **investable** (dry powder, inside
the return) from **reserved** (set aside, outside it). Where a fixed amount is
reserved, the effective reserve is `min(amount, balance)` (or the whole balance
for "All"), and a shortfall is surfaced rather than silently capped.

### Keyed on `(bucketId, ticker)`, not the holding id

The designation lives in an `earmarks` table keyed on **`(bucketId, ticker)`** —
deliberately *not* on `holding.id`. Holdings is a derived projection: its rows are
dropped and recreated on every rebuild and the `id` is reassigned, so an `id` FK
would dangle or silently re-point. Keying on the ticker (the account's real
identity) is why a rename has to cascade the earmark, and it's why the same table
is **scope-aware** (`scope: account | portfolio | goal`): the account scope ships
now; a portfolio default and a goal link are schema-ready future scopes, resolved
most-specific-wins by one pure resolver returning `{requested, effective}`.

### Why reserved cash is carved out *symmetrically*

Excluding reserved cash from the return can't be a plain "subtract its value from
the terminal" — that would shrink the ending value without removing the matching
money, and XIRR would read a **fabricated loss**. The carve-out is **symmetric**:
reduce the terminal by the reserved baht **and** append a synthetic flow dated to
the as-of date so the two cancel in the NPV. It's a read-time computation only —
**never a ledger row** (the earmark stores no money fact; facts-only stays
intact). Reserved cash leaves the Cash sleeve in the allocation donut and gets its
own "Reserved" slice.

## Return basis: Include cash vs Funds only

Reserved cash is out of the return either way. The **Return basis** control
governs the rest — your *investable* cash:

- **Include cash** (the default) — investable cash counts the moment it lands, so
  idle dry powder you haven't deployed **visibly drags** the money-weighted
  return. This is the honest GIPS number, and it's the one consistent with the
  app's own cash-drag health check (you can't flag idle cash as a problem and
  then hide it from the return).
- **Funds only** — investable cash sits out as a pure net-worth sidecar; only
  money you've actually deployed into a fund counts. Useful for "how are my
  *investments* doing, setting cash aside."

Funds only excludes the value of your **held cash accounts**, not the
**in-transit settlement cash** a fund switch parks between a sell and the
following buy. That float is committed capital mid-flight, not idle dry powder —
removing it would re-introduce the very phantom drawdown the settlement heuristic
exists to erase, so a routine rebalance draws no dip in either basis. (The Mix
composition still shows the float as cash, because for those days it genuinely is.)

The control is a **`Cash` toggle** in the chart toolbar — the word reads plain when
cash counts (the default) and struck through, green, when it's excluded — not a
buried setting, so it suits the compare-and-flip use case. A first-click note
explains it; "investable" and "reserved" match the cash types in Add-to-portfolio.
Like the other chart view settings it persists **per device** (localStorage), not
across devices.

**One definition, three paths.** The two modes are *one* resolver with *one*
parameter (`countUninvestedCash`, default true = Include). The excluded slice is
the same machinery in both: reserved cash (always) **+** all remaining uninvested
investable cash (Funds only). That single `cashContributionFlows` definition feeds
all three places a contribution is counted — the headline XIRR, the chart's
net-invested line, and `contributions.ts` — so they **cannot silently diverge**.
Since proceeds absorption made an assert's flow depend on the live lot state, the
definition is literally one pass: `cashContributionFlows` is a view over the same
settlement-cash fold that drives the chart, so the discipline holds by
construction, not by convention.

## What's deferred

The account-scope earmark is the only forward-fit hook this feature adds; the
richer version belongs to the goals / wealth-path planner
([#36](https://github.com/users/Sitthinut/projects/2)), which will sit on top as a
read-only overlay referencing accounts — never a money container (that's the
double-counting trap when one balance feeds several goals). Deferred there or on
the board: named goals with a target amount and date, multiple earmark slices in
one account, and reserving *funds* (not just cash).

## Where this lives

- The cash fold, the two-stream reconcile, and `cashContributionFlows`:
  `lib/portfolio/settlement-cash.ts`.
- The earmark resolver (`{requested, effective}`, scope precedence):
  `lib/portfolio/earmarks.ts`; the designation store + route:
  `lib/db/queries/earmarks.ts`, `app/api/earmarks/route.ts`.
- The return-basis parameter on the analytics path:
  `app/api/transactions/analytics/route.ts` (`?cash=funds`).
- The one-ledger model cash extends:
  [Balances and History](./balances-and-history.md),
  [ADR 0004](./decisions/0004-unified-ledger-positions-derived.md).
- The settled calls + rejected alternatives:
  [decisions Picks table](./decisions/README.md#ledger--portfolio-math).
