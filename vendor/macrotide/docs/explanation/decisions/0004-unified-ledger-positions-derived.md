# ADR 0004 — One ledger, positions derived: holdings become a projection

**Status:** Accepted. **Supersedes [0003](./0003-transaction-ledger-data-model.md).**
**Context:** 0003 shipped the transaction ledger as a *separate* model alongside
snapshot `holdings`, with the two kept visually apart and an opt-in reconcile
deferred. In review we decided to collapse them: a holding *is* a transaction
(units at a cost on a date), so maintaining two user-entered sources that can
drift is the wrong model. This ADR records the unified design 0003 called the
"conceptually correct long-term model (Option C)" and explicitly deferred.

## The question

A holding today is a hand-entered snapshot (`units` + `avg_cost`) that the whole
app reads (value, health, charts, look-through). The ledger is a separate
hand-entered event log. They can disagree, and "edit a holding" vs "add a
transaction" are two mental models for one thing. How do we make **one** source
of truth that still serves three real user flows —

1. **Full history** — enter every buy/sell/dividend.
2. **Opening balance, then forward** — enter where you are today, then track new
   activity.
3. **Periodic restatement** — never log trades; just re-state "here's what I hold
   now" every so often.

— *and* degrades gracefully when the user has units but no cost basis?

## Decision

**The ledger is the single source of truth for positions. `holdings` becomes a
derived projection of it.** Users edit exactly one thing — ledger events —
even when the UI presents it as "editing a holding." The drift problem from 0003
disappears because positions are computed one way, from one place.

This is the Maybe Finance model (a polymorphic `Entry` → `Transaction` / `Trade`
/ `Valuation`) and Beancount's `pad` + `balance` pair, which every mature tracker
converges on. 0003 chose Option A for *sequencing* reasons (blast radius, no
backfill path); both are now resolved — see below.

### Two kinds of events: deltas and anchors

A position is computed by replaying a ticker's events in `(tradeDate, createdAt,
id)` order, **starting from its most recent anchor** and applying deltas after
it.

- **Deltas** move the running position by a relative amount:
  `buy`, `sell`, `dividend`, `fee`, `split`, `reinvest` (all unchanged from 0003).
- **Anchors** assert an absolute truth at a date and discard accumulated drift
  before them. Two new kinds:
  - **`opening`** — an opening balance: absolute `units` at an optional avg cost,
    on a date. The "start from where I am, then track forward" flow (Beancount
    `pad`). Costed → counts as an external cash outflow for IRR; uncosted →
    treated as a transfer-in (units, no cash flow).
  - **`snapshot`** — a point-in-time restatement: absolute `units` (+ optional
    avg cost / value). Resets the position; **never a cash flow** and **never a
    realized event** (it is not a trade). The "periodically re-state my holdings"
    flow (Maybe `Valuation`). If avg cost is omitted, the prior per-unit cost is
    **carried forward** (units & value snap to the anchor; cost basis is
    preserved), so a value-only restatement never destroys cost basis.

### No schema DDL for the kinds

`transactions.kind` is plain TEXT validated by Zod at the route boundary (the
`action_item_states` precedent), so the two new kinds need **no migration**.
Anchors reuse existing columns: `units` = absolute units, `pricePerUnit` = avg
cost, `amount` = 0 for a `snapshot` (or −cost for a costed `opening`),
`fee`/`fxToThb`/`tradeCurrency` as for any row. The only data migration is the
one-time backfill of existing `holdings` rows into `opening` anchors (below).

### Holdings = derived position + retained instrument metadata

The `holdings` table stays, with the **same row shape the read path already
consumes** (`adaptPortfolios`), but its meaning splits:

- **Position columns** (`units`, `avgCost`) are **derived** — overwritten by the
  projection on every ledger write. Users never type these directly.
- **Instrument-metadata columns** (`thaiName`, `category`, `assetClass`,
  `region`, `ter`, `color`, `source`) are **reference data**, user-editable, and
  preserved across projection rebuilds. They have no home in an event ledger and
  are never computed two ways, so they cannot drift.

A holding row exists iff its ledger nets to `> 0` units; a full exit removes it
from current holdings (matching the lot engine, which already drops zero-unit
positions). The projection is a deterministic, rebuildable function of the
ledger — a cache, not a second source of truth.

> **Implementation note (shipped state).** The decision above keeps the
> `units`/`avgCost` columns and overwrites them on every write. The
> implementation went one step further: those columns were **dropped** entirely
> (migration `0011`) and positions are folded from the ledger **on read** — and
> only the money fact the user gave is stored, with the missing side derived at
> the fold (facts-only). The "same row shape / overwritten on write" wording here
> is the plan as decided; the maintained docs
> ([data-model](../../reference/data-model.md),
> [balances-and-history](../balances-and-history.md),
> [AGENTS.md](../../../AGENTS.md)) carry the current rules.

### "Edit a holding" is sugar over the ledger

- **Position edits** (units / avg cost) write a ledger event: if the position has
  exactly one backing event (a lone `opening` or single `buy`), that event is
  edited in place — a clean round-trip that *feels* like editing the holding. If
  it has several events, the edit **appends a `snapshot` anchor** restating to
  the new values; history stays intact and auditable, and we never silently
  rewrite a past trade.
- **Metadata edits** (name / colour / category / TER) update the holdings row
  directly — they are not positions. The maintained implementation now narrows
  this rule: for catalog-backed funds, descriptive fund facts are read from
  `market.db` at read time and are not user-editable in `app.db`; `app.db`
  metadata remains authoritative only for unresolved/custom holdings.

### Graceful degradation when cost is unknown

A position with no cost basis (an uncosted `opening`/`snapshot`, a transfer-in,
or a Finnomena-style row with units + value but no avg cost):

| Analytic | Without cost |
| --- | --- |
| Current value, allocation, weight, value-over-time | works |
| Realized / unrealized gain, cost-basis % | shown as "—" |
| Money-weighted return (IRR) | "—" (or labelled approximate) |

**Never fabricate a cost basis.** `PositionState` carries cost as nullable
(`costBasis: number | null`, `avgCost: number | null` while `units > 0` means
*held but cost unknown*); gain-based analytics return null and the UI shows a
gentle nudge ("Add your average cost to see gains and return"). Value-based
analytics never depend on cost, so they keep working — that is the whole point of
keeping cost and market value orthogonal.

## Why Option A's blockers no longer apply

0003 deferred this for two reasons; both are now addressed:

1. **Blast radius.** Keeping `holdings` as a projection with the *same row shape*
   means the ~30 read consumers (the portfolio adapter, health, fee-creep,
   look-through, market-data routing, every holdings table/SWR hook) are
   **unchanged**. Only the ~7 write paths and the seeds move to the ledger.
2. **Backfill.** A hand-typed snapshot holding maps cleanly to a single
   `opening` anchor (`units` + `avgCost` + `acquiredOn`). The one-time migration
   converts every existing holding to an `opening` and rebuilds the projection —
   verified to reproduce byte-identical positions.

## Consequences

What this decision settled, as foreseen when it was made:

- **One source of truth for positions.** There is no second hand-entered number
  to reconcile. The 0003 reconcile line and any "ledger vs snapshot disagree"
  diagnostic are **removed** — they are meaningless when holdings *are* the
  projection.
- **Carried forward from 0003 (unchanged):** `transactions` omits `user_id` and
  is scoped through its parent bucket; the signed THB `amount` is the sole
  money-weighted-return primitive and trade-date FX is never re-applied to it;
  cost basis is moving-average by default (FIFO available) and the method locks
  once a realized sell exists; realized-gain output is informational, not a tax
  report.
- **Table name kept as `transactions`** (not renamed to `ledger`) to avoid churn
  across well-tested query/analytics/test code; anchors are simply special
  transaction kinds. The concept is called "the ledger" in docs and UI copy.

The *ongoing* rules this decision implies — rebuild-after-every-write (the
projection is a pure, rebuilt cache, never edited directly), cost/value
orthogonality, and which event kinds count as external cash flows for the
money-weighted return — are kept in the maintained docs, not frozen here:
[Balances and History § The rules that hold everywhere](../balances-and-history.md#the-rules-that-hold-everywhere).
The agent-facing half of that — never write `holdings` directly; store only facts
and let the projection rebuild — is in
[AGENTS.md § DB routing](../../../AGENTS.md#db-routing--read-before-touching-a-route-handler).
