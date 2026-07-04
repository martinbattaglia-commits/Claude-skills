# ADR 0003 — Transaction-history ledger: a separate append-only model

**Status:** Superseded by [0004](./0004-unified-ledger-positions-derived.md) —
the ledger is now the single source of truth and `holdings` is derived from it
(0003's "Option C"). The 0003 rules that survive (bucket-scoping, signed-THB
primitive, average-cost-locks-after-sell, informational-not-tax) are restated in
0004; the "two models coexist / reconcile" rules are retired.
**Context:** the transaction-history import — a buy/sell log (date · price · units
per row) that yields realized gains, money-weighted return, and a contribution
timeline. This is a different shape from the snapshot holdings importer.

## The question

A holding today is a **snapshot**: `units` + a single `avg_cost`, with no record
of how the position was built. Realized gains, IRR, and a DCA timeline all need
the *events* — the buys and sells over time. Where should that event history
live, and how does it relate to the snapshot positions the whole app already
reads (health, charts, look-through)?

Three options were weighed:

- **A — separate append-only ledger.** A new `transactions` table is the source
  of truth for realized-gain / IRR / timeline. Snapshot `holdings` stays the
  source of truth for "current value". Positions are *not* derived from the
  ledger.
- **B — fully separate, analytics-only.** Like A but the ledger never relates to
  holdings at all.
- **C — ledger derives positions.** Transactions become *the* source of truth;
  current units / average cost are projected from the ledger, and `holdings`
  becomes a derived cache.

## Decision

**Option A.** The ledger is its own append-only table; the snapshot read
contract is untouched.

C is the conceptually correct long-term model — every mature tracker
(Ghostfolio, Maybe, Portfolio Performance, plaintext-accounting) converges on
ledger-as-truth, positions-derived. The disagreement is **sequencing, not
destination.** Two facts make C the wrong *first* move:

1. **Blast radius.** Deriving positions touches the precious demo/mock seeds,
   every `createHolding` caller, the portfolio adapter, and every analytics
   test — a wide change to load-bearing, well-tested code.
2. **Irreversibility.** Hand-typed snapshot holdings carry *no* event history and
   cannot be reverse-derived into a ledger. C needs a grandfather path that
   doesn't exist yet.

A delivers the entire feature (own data model, realized-gain + cost-basis math,
money-weighted return, contribution timeline, the snapshot-importer scope-guard,
and the contribution series a future DCA planner consumes) with **zero regression
to the snapshot read path**, and leaves C reachable additively later.

### Explicitly deferred (not in this slice)

The **opt-in reconcile** action (project a bucket's transactions into snapshot
holdings) and any flag on the `buckets` table to mark a bucket as
ledger-derived. Reconcile is the bridge toward C; it re-introduces the
`buckets`-table blast radius A was chosen to avoid, so it ships as a separate,
explicitly-budgeted change.

## Consequences & the rules that follow

- **Two models coexist; keep them visually separate.** Snapshot "current value"
  (units × NAV) and ledger "realized + return" are computed from different
  sources. The UI must never let them read as one inconsistent number; a
  reconciliation line shows only when ledger-derived units tie back to snapshot
  `holdings.units` within tolerance, else it surfaces a "ledger and snapshot
  disagree" diagnostic rather than a confidently-wrong figure.
- **`transactions` omits `user_id`** and is scoped through its parent bucket,
  exactly like `holdings`. This deliberately overrides the general "new app
  tables carry `user_id`" guidance: the scoping invariant lives in the *caller*
  (resolve the owner's bucket set, then query) — the query layer exposes no
  unscoped list.
- **Cost basis = moving average by default**, FIFO available; the engine is
  lot- and date-aware internally so FIFO and per-lot holding clocks come without
  a migration. The method **locks once a realized (sell) event exists** —
  changing it then requires an explicit "recompute history" confirmation, never
  a silent retroactive rewrite.
- **The signed THB `amount` is the sole money-weighted-return primitive**; the
  trade-date FX rate is captured once at import and never re-applied to an
  already-THB amount (that is exactly how a mixed-currency double-count creeps
  back in).
- **Realized-gain / holding-period output is informational, not a tax report** —
  dated, sourced context behind the standing not-investment-advice framing.
