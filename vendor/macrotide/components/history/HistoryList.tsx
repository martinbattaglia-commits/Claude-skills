"use client";

// HistoryList — the ledger as a native list: the app's `.stats-strip` for the
// in-context performance summary, `.section-header` month groups over
// `.holdings-list` rows (so events sit in the same grammar as Holdings) with
// balances (anchors) and trades interleaved newest-first, and the shared
// `.rec-edit` inline editor on tap. Scope = all owned buckets, or one ticker (a position's
// record). Holdings are a projection of this ledger, so every write re-invalidates
// holdings + portfolio views.

import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EventLine } from "@/components/history/EventLine";
import { Icon } from "@/components/Icon";
import { PrivateAmount } from "@/components/PrivateAmount";
import { SymbolCombobox } from "@/components/portfolio/SymbolCombobox";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { QtyInput, qtyDefaultMode } from "@/components/ui/QtyInput";
import { Skeleton, SkeletonRows } from "@/components/ui/Skeleton";
import { Stat } from "@/components/ui/Stat";
import { fxCurrency, useFxEntry } from "@/components/ui/useFxEntry";
import { mergeWithHoldings, type TickerSuggestion } from "@/lib/data/known-holdings";
import type { Transaction } from "@/lib/db/queries/transactions";
import { useHoldings } from "@/lib/fetchers/portfolio";
import { cachedQuoteSource, resolveQuoteSources } from "@/lib/fetchers/quote-source";
import { invalidate, useResource } from "@/lib/fetchers/swr";
import { fmtRatioPct, fmtTHBClean, fmtTHBSigned } from "@/lib/format";
import type { QuoteSource } from "@/lib/market/sources";
import type { TxnKind } from "@/lib/portfolio/lots";
import type { TransactionAnalytics } from "@/lib/portfolio/transaction-analytics";
import { TXN_KIND_HELP, typeSelectOptions } from "@/lib/portfolio/txn-display";
import {
  isCashKind,
  normalizeTxnDraft,
  type RowInvalidReason,
  rowValidity,
} from "@/lib/portfolio/txn-import";

type AnalyticsResponse = TransactionAnalytics & { transactionCount: number };

function isAnchor(k: TxnKind): boolean {
  return k === "opening" || k === "snapshot";
}

/** Map the shared validity gate's reason to this editor's copy — full sentences (the
 *  History editor's voice), distinct from the Add modal's terse row nudge. */
function rowErrorMessage(reason: RowInvalidReason, anchor: boolean): string {
  switch (reason) {
    case "balance-needs-figure":
      return "A balance needs a unit count or a ฿ value.";
    case "custom-needs-price":
      return "A custom asset needs a current price to value it.";
    case "needs-price":
      return "Add a price so we can value this trade.";
    case "missing-ratio":
      return "Add the split ratio (e.g. 2 for a 2-for-1).";
    case "missing-amount":
      return "Add a date, a symbol, and an amount.";
    default: // missing-ticker / missing-date
      return anchor ? "Add a date and a symbol." : "Add a date, a symbol, and an amount.";
  }
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ── inline-edit draft ─────────────────────────────────────────────────────────
// Edits an EXISTING row only (new entries go through the modal), so there's no
// bucket here — a row's portfolio is fixed.
interface Draft {
  tradeDate: string;
  kind: TxnKind;
  ticker: string;
  units: string;
  /** A Balance's stated current ฿ VALUE (units derive from value ÷ NAV at the fold). */
  value: string;
  pricePerUnit: string;
  /** A Balance's current market price per unit (for custom-asset valuation). */
  marketPrice: string;
  fee: string;
  amount: string;
  quoteSource: string;
  /** A cash account's currency (deposit/withdraw/cash_balance). Defaults THB. */
  currency?: string;
  /** Native→THB rate for a non-THB holding (cash or foreign security); "" / "1" for THB. */
  fxToThb?: string;
  /** True once the user edits the rate by hand — also set on load for a stored non-THB
   * row so its historical rate is preserved rather than silently re-fetched. */
  fxManual?: boolean;
  /** "No money moved" override on a Set balance (cash_balance) — sent as `reconcile`. */
  reconcile?: boolean;
  /** True once the source was set explicitly (saved value or a badge flip) — keeps
   * a ticker edit from re-inferring over it. */
  quoteSourceLocked?: boolean;
}
function blankDraft(): Draft {
  return {
    tradeDate: "",
    kind: "buy",
    ticker: "",
    units: "",
    value: "",
    pricePerUnit: "",
    marketPrice: "",
    fee: "",
    amount: "",
    quoteSource: "",
    currency: "THB",
  };
}
function draftFromTxn(t: Transaction): Draft {
  // A non-THB SECURITY stores its money fields in THB (native × the trade-date rate);
  // the editor shows/edits NATIVE and re-multiplies on save, so seed native = THB ÷ rate
  // (else editing would double-convert). Cash already stores native in `units`, so it
  // needs no un-conversion. THB rows carry fx 1 → a no-op.
  const secFx =
    !isCashKind(t.kind) && (t.tradeCurrency ?? "THB") !== "THB" && (t.fxToThb ?? 1) !== 1
      ? (t.fxToThb as number)
      : 1;
  // Un-convert THB → native for editing. Round the non-THB result to 4 dp: a raw
  // THB ÷ rate is usually a long float (฿18,000 ÷ 35 = 514.28571…) that would show as
  // garbage; 4 dp is plenty for a price and re-multiplies back to within a rounding
  // whisker of the stored THB. A THB row (secFx 1) is left byte-for-byte unchanged.
  const nat = (v: number): string =>
    secFx === 1 ? String(v) : String(Math.round((v / secFx) * 1e4) / 1e4);
  // Prefer the verbatim native figure the user typed when it was stored (rows saved
  // since native-input capture landed); fall back to the `÷ rate` reconstruction for
  // legacy rows. This is what shows $500 exactly instead of 514.2857 on a reopen.
  const ni = t.nativeInputs ?? undefined;
  const pick = (native: number | undefined, thb: number): string =>
    native != null ? String(native) : nat(thb);
  return {
    tradeDate: t.tradeDate.slice(0, 10),
    kind: t.kind as TxnKind,
    // The ticker is the symbol for funds and the account name for cash — both now
    // stored in their own case (#235), so edit it directly. (Older cash rows whose
    // name was shadowed in englishName still fall back to it.)
    ticker: isCashKind(t.kind) ? t.ticker || (t.englishName ?? "") : t.ticker,
    units: t.units != null ? String(t.units) : "",
    // The Balance field holds the NATIVE figure the user typed. A cash Set balance
    // stores its asserted balance in `units` (native); show that, not the ฿ `value`.
    value:
      t.kind === "cash_balance" && t.units != null
        ? String(t.units)
        : t.value != null
          ? pick(ni?.value, t.value)
          : "",
    pricePerUnit: t.pricePerUnit != null ? pick(ni?.price, t.pricePerUnit) : "",
    marketPrice: t.marketPrice != null ? pick(ni?.marketPrice, t.marketPrice) : "",
    fee: t.fee != null ? pick(ni?.fee, t.fee) : "",
    // The Amount field is NATIVE. A cash deposit/withdraw stores native in `units` and
    // ฿ in `amount`; seed from `units`. A non-cash amount un-converts THB → native.
    amount:
      isCashKind(t.kind) && t.kind !== "cash_balance" && t.units != null
        ? String(t.units)
        : pick(ni?.amount, Math.abs(t.amount)),
    quoteSource: t.quoteSource,
    currency: t.tradeCurrency ?? "THB",
    // Only surface a rate for a non-THB holding (THB is the implicit 1); mark it manual
    // so opening the row keeps its stored historical rate instead of re-fetching.
    fxToThb: t.fxToThb != null && t.fxToThb !== 1 ? String(t.fxToThb) : "",
    fxManual: t.fxToThb != null && t.fxToThb !== 1,
    reconcile: !!t.reconcile,
    quoteSourceLocked: true,
  };
}

export interface HistoryListProps {
  /** Limit to one fund (a position's record); omit for the whole portfolio. */
  ticker?: string | null;
  /** Show the in-context performance summary above the statement. */
  showRecap?: boolean;
  /** Open the unified Add modal — the single place a new entry is created (it
   * owns the portfolio picker, paste/image intake, and the type per row). */
  onAddEntry?: () => void;
}

export function HistoryList({ ticker = null, showRecap = true, onAddEntry }: HistoryListProps) {
  const { data: allTxns, isLoading: txnsLoading } = useResource<Transaction[]>("/api/transactions");
  const { data: analytics } = useResource<AnalyticsResponse>(
    `/api/transactions/analytics${ticker ? `?ticker=${encodeURIComponent(ticker)}` : ""}`,
  );

  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft());
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Transaction | null>(null);
  const [deleting, setDeleting] = useState(false);

  const txns = useMemo(
    () => (ticker ? (allTxns ?? []).filter((t) => t.ticker === ticker) : (allTxns ?? [])),
    [allTxns, ticker],
  );

  const realizedByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of analytics?.realized ?? []) m.set(`${e.ticker}|${e.tradeDate}`, e.realizedGain);
    return m;
  }, [analytics]);

  const netByMonth = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of analytics?.contributions.months ?? []) m.set(c.month, c.net);
    return m;
  }, [analytics]);

  const months = useMemo(() => {
    // One chronological feed: balances (anchors) and trades share the month
    // groups so a later-dated balance sits above older activity, newest first.
    const groups = new Map<string, Transaction[]>();
    for (const t of txns) {
      const ym = t.tradeDate.slice(0, 7);
      let rows = groups.get(ym);
      if (!rows) {
        rows = [];
        groups.set(ym, rows);
      }
      rows.push(t);
    }
    for (const [, rows] of groups)
      rows.sort((a, b) =>
        a.tradeDate !== b.tradeDate ? (a.tradeDate < b.tradeDate ? 1 : -1) : b.id - a.id,
      );
    return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [txns]);

  const hasTxns = txns.length > 0;

  const startEdit = (t: Transaction) => {
    setRowError(null);
    setDraft(draftFromTxn(t));
    setEditing(t.id);
  };
  const cancel = () => {
    setEditing(null);
    setRowError(null);
  };

  const refresh = () => {
    invalidate(/^\/api\/transactions/);
    invalidate(/^\/api\/holdings/);
    invalidate(/^\/api\/portfolios/);
  };

  async function save() {
    setBusy(true);
    setRowError(null);
    const anchor = isAnchor(draft.kind);
    // The SAME accept/reject gate the Add modal runs, so the two editors agree on
    // every combination; map the reason to this editor's copy. (History's custom
    // current price rides on `marketPrice`.)
    const gate = rowValidity({
      tradeDate: draft.tradeDate,
      kind: draft.kind,
      ticker: draft.ticker,
      units: draft.units,
      value: draft.value,
      pricePerUnit: draft.pricePerUnit,
      amount: draft.amount,
      fee: draft.fee,
      quoteSource: (draft.quoteSource || undefined) as QuoteSource | undefined,
      currentPrice: draft.marketPrice,
    });
    if (!gate.ok) {
      setRowError(rowErrorMessage(gate.reason, anchor));
      setBusy(false);
      return;
    }
    // Non-THB cost basis: convert the entered native figures to the THB the
    // ledger folds, via the trade-date rate. A non-THB row (non-split) needs a rate —
    // block rather than silently store the native figure as baht.
    const secCurrency = fxCurrency(draft);
    const secRate =
      secCurrency === "THB" ? 1 : Number(draft.fxToThb) > 0 ? Number(draft.fxToThb) : 1;
    const toThb = (v: number | null | undefined): number | undefined =>
      v == null ? undefined : v * secRate;
    if (draft.kind !== "split" && secCurrency !== "THB" && !(Number(draft.fxToThb) > 0)) {
      setRowError(`Add the ${secCurrency}→฿ FX rate so the cost basis stores in baht.`);
      setBusy(false);
      return;
    }
    try {
      let payload: Record<string, unknown>;
      if (isCashKind(draft.kind)) {
        // Cash: the figure is in the account currency = NATIVE units; the ฿ ledger
        // amount is native × the trade-date rate (1 for THB). units stays native (valued
        // at live FX); cash_balance moves no cash and carries its ฿ value + reconcile.
        const currency = (draft.currency || "THB").trim().toUpperCase() || "THB";
        const rate = currency === "THB" ? 1 : Number(draft.fxToThb) > 0 ? Number(draft.fxToThb) : 1;
        const native =
          draft.kind === "cash_balance"
            ? Number(draft.value || draft.amount)
            : Number(draft.amount);
        const figure = native > 0 ? native : 0;
        const thb = figure * rate;
        payload = {
          tradeDate: draft.tradeDate,
          kind: draft.kind,
          // The cash account name is the ticker, kept in the user's case (#235).
          ticker: draft.ticker.trim(),
          englishName: draft.ticker.trim(),
          units: figure > 0 ? figure : undefined,
          value: draft.kind === "cash_balance" && thb > 0 ? thb : undefined,
          amount: draft.kind === "cash_balance" ? 0 : thb,
          reconcile: draft.kind === "cash_balance" ? !!draft.reconcile : undefined,
          quoteSource: "cash",
          tradeCurrency: currency,
          fxToThb: rate,
        };
      } else if (anchor) {
        const hasUnits = draft.units.trim() !== "" && Number(draft.units) > 0;
        const hasValue = draft.value.trim() !== "" && Number(draft.value) > 0;
        const avg = draft.pricePerUnit.trim() === "" ? null : Number(draft.pricePerUnit);
        payload = {
          tradeDate: draft.tradeDate,
          kind: draft.kind,
          ticker: draft.ticker.trim(),
          // `units` are a native share count; money fields convert to THB.
          units: hasUnits ? Number(draft.units) : undefined,
          value: !hasUnits && hasValue ? toThb(Number(draft.value)) : undefined,
          pricePerUnit: toThb(avg),
          marketPrice: draft.marketPrice.trim() === "" ? null : toThb(Number(draft.marketPrice)),
          // Cost magnitude (units × avg cost) — the PATCH route signs it (cash out).
          amount: hasUnits && avg != null ? toThb(Number(draft.units) * avg) : 0,
          quoteSource: draft.quoteSource || "manual",
          tradeCurrency: secCurrency,
          fxToThb: secRate,
        };
      } else {
        const d = normalizeTxnDraft({
          tradeDate: draft.tradeDate,
          kind: draft.kind,
          ticker: draft.ticker,
          units: draft.units,
          pricePerUnit: draft.pricePerUnit,
          amount: draft.amount,
          fee: draft.fee,
          quoteSource: (draft.quoteSource || undefined) as QuoteSource | undefined,
        });
        payload = {
          tradeDate: d.tradeDate,
          kind: d.kind,
          ticker: d.ticker,
          // `units` (and a split ratio) are counts; money fields convert to THB.
          units: d.units,
          pricePerUnit: d.kind === "split" ? d.pricePerUnit : toThb(d.pricePerUnit),
          amount: d.kind === "split" ? 0 : (toThb(d.amount) ?? 0),
          fee: d.kind === "split" ? d.fee : toThb(d.fee),
          quoteSource: draft.quoteSource || d.quoteSource,
          tradeCurrency: secCurrency,
          fxToThb: secRate,
        };
      }

      const res = await fetch(`/api/transactions/${editing}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(String(res.status));
      refresh();
      setEditing(null);
    } catch {
      setRowError("Couldn't save. Check the values and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function doDelete(t: Transaction) {
    try {
      const res = await fetch(`/api/transactions/${t.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(String(res.status));
      refresh();
      setEditing(null);
    } catch {
      setRowError(`Couldn't delete ${t.ticker}. Try again.`);
    }
  }
  function remove(t: Transaction) {
    if (isAnchor(t.kind as TxnKind)) {
      setPendingDelete(t);
      return;
    }
    void doDelete(t);
  }

  const downstreamCount = (a: Transaction): number =>
    (allTxns ?? []).filter(
      (t) => t.ticker === a.ticker && t.id !== a.id && t.tradeDate >= a.tradeDate,
    ).length;

  // Without this branch the empty-state ("Your record is empty") flashes on
  // every mount while the statement is still in flight.
  if (txnsLoading && !hasTxns) {
    return (
      <div aria-hidden>
        {showRecap && (
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={62} style={{ flex: 1 }} />
            ))}
          </div>
        )}
        <SkeletonRows rows={6} height={44} gap={6} padding={0} />
      </div>
    );
  }

  if (!hasTxns) {
    return (
      <div
        className="card-soft"
        style={{
          padding: "18px 16px",
          textAlign: "center",
          color: "var(--muted)",
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        <div style={{ marginBottom: 10, color: "var(--ink-soft)" }}>Your record is empty.</div>
        <button className="btn sm primary" onClick={onAddEntry}>
          <Icon name="plus" size={12} /> Add your first entry
        </button>
      </div>
    );
  }

  const irr = analytics?.irr;
  return (
    <>
      {showRecap &&
        (() => {
          const realized = analytics?.realizedTotal ?? 0;
          return (
            <div className="stat-cards-cq">
              <div className="stat-cards">
                <Stat
                  label="RETURN"
                  value={irr != null ? fmtRatioPct(irr) : "—"}
                  tone={irr == null ? "neutral" : irr >= 0 ? "up" : "down"}
                  caption={
                    irr != null
                      ? "money-weighted"
                      : (analytics?.irrUnavailable ??
                        "Return appears after about a month of activity.")
                  }
                />
                <Stat
                  label="INVESTED"
                  value={fmtTHBClean(analytics?.costBasisTotal ?? 0)}
                  caption="cost basis"
                />
                <Stat
                  label="REALIZED"
                  value={fmtTHBSigned(realized)}
                  tone={realized > 0 ? "up" : realized < 0 ? "down" : "neutral"}
                  caption="from sells"
                />
                <Stat
                  label="INCOME"
                  value={fmtTHBClean(analytics?.incomeTotal ?? 0)}
                  caption="dividends"
                />
              </div>
            </div>
          );
        })()}

      {rowError && (
        <div style={{ fontSize: 12, color: "var(--loss)", margin: "12px 4px 0" }}>{rowError}</div>
      )}

      {/* No inline "Add" button here — the persistent top-right Add (this screen's
          topbar / the Position "Record") opens the same modal, so a second button
          would just duplicate it. The empty state above keeps its first-run CTA. */}

      {months.map(([ym, rows]) => (
        <div key={ym}>
          <div
            className="section-header"
            style={{ padding: "0 4px", marginTop: 16, marginBottom: 4 }}
          >
            <h3 style={{ fontSize: 13 }}>{monthLabel(ym)}</h3>
            {netByMonth.has(ym) && (
              <span className="num" style={{ fontSize: 11, color: "var(--muted)" }}>
                net invested <PrivateAmount>{fmtTHBSigned(netByMonth.get(ym) ?? 0)}</PrivateAmount>
              </span>
            )}
          </div>
          <div className="holdings-list">
            {rows.map((t) =>
              editing === t.id ? (
                <TxnEditor
                  key={t.id}
                  draft={draft}
                  onChange={setDraft}
                  onSave={save}
                  onCancel={cancel}
                  onDelete={() => remove(t)}
                  busy={busy}
                />
              ) : isAnchor(t.kind as TxnKind) ? (
                <EventLine
                  key={t.id}
                  txn={t}
                  onOpen={() => startEdit(t)}
                  hideTicker={!!ticker}
                  hideVerb
                />
              ) : (
                <EventLine
                  key={t.id}
                  txn={t}
                  realized={realizedByKey.get(`${t.ticker}|${t.tradeDate}`)}
                  onOpen={() => startEdit(t)}
                  hideTicker={!!ticker}
                />
              ),
            )}
          </div>
        </div>
      ))}

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete this balance?"
        message={
          pendingDelete
            ? `This is the foundation of your ${pendingDelete.ticker} record. Removing it recomputes ${downstreamCount(pendingDelete)} later event${downstreamCount(pendingDelete) === 1 ? "" : "s"} — units, average cost, and any realized gains may change.`
            : undefined
        }
        confirmLabel="Delete and recompute"
        busy={deleting}
        onConfirm={async () => {
          if (!pendingDelete) return;
          setDeleting(true);
          await doDelete(pendingDelete);
          setDeleting(false);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}

// Native inline editor for an EXISTING row — the SAME `.rec-edit` grid +
// SymbolCombobox the unified Add sheet uses, so the two match exactly. Type
// reshapes the row (an anchor → Balance with 5 fields; a
// trade → 7). New entries are created in the modal, not here, so there's no
// portfolio picker — an existing row's portfolio is fixed.
function TxnEditor({
  draft,
  onChange,
  onSave,
  onCancel,
  onDelete,
  busy,
}: {
  draft: Draft;
  // Accepts an updater so multiple patches in one handler compose (the QtyInput sets
  // amount AND units back-to-back; a value-spread `set` would clobber the first).
  onChange: (d: Draft | ((prev: Draft) => Draft)) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  busy: boolean;
}) {
  const { data: holdings } = useHoldings();
  const pool = useMemo<TickerSuggestion[]>(
    () =>
      mergeWithHoldings(
        (holdings ?? []).map((h) => ({
          ticker: h.ticker,
          englishName: h.englishName,
          quoteSource: h.quoteSource,
        })),
      ).slice(0, 200),
    [holdings],
  );

  const set = (patch: Partial<Draft>) => onChange((prev) => ({ ...prev, ...patch }));

  // Resolve a hand-TYPED symbol's source against the catalog (the same shared
  // resolver the Add modal uses) so the badge matches across both editors — picking
  // a suggestion already sets the source; this covers typing a catalog code without
  // picking it. Skips a pinned (user-toggled) source. Reads/writes via the functional
  // updater so a stale ticker in the debounced callback can't clobber a newer edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: ticker + lock are the inputs; onChange is stable (setDraft)
  useEffect(() => {
    const ticker = draft.ticker;
    if (draft.quoteSourceLocked || !ticker.trim()) return;
    const apply = () => {
      const resolved = cachedQuoteSource(ticker);
      if (!resolved) return;
      onChange((prev) =>
        prev.quoteSourceLocked || prev.ticker !== ticker || prev.quoteSource === resolved
          ? prev
          : { ...prev, quoteSource: resolved },
      );
    };
    apply(); // apply an already-cached source immediately
    const timer = setTimeout(() => {
      void resolveQuoteSources([ticker]).then((gained) => {
        if (gained) apply();
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [draft.ticker, draft.quoteSourceLocked]);

  const anchor = isAnchor(draft.kind);
  // Cash events (deposit / withdraw / cash_balance) — a named cash account, no symbol.
  const isCash = isCashKind(draft.kind);
  const cashBalance = draft.kind === "cash_balance";
  // Dividend / fee are pure ฿ flows — no units or price, just an amount.
  const amountOnly = draft.kind === "dividend" || draft.kind === "fee";

  // Best-effort native money on the row, for the "≈ ฿X" FX preview.
  const nativeMoney = cashBalance
    ? Number(draft.value)
    : isCash || amountOnly
      ? Number(draft.amount)
      : Number(draft.value) > 0
        ? Number(draft.value)
        : Number(draft.units) > 0 && Number(draft.pricePerUnit) > 0
          ? Number(draft.units) * Number(draft.pricePerUnit)
          : Number(draft.amount);
  // Currency + trade-date FX, the SAME machinery the Add/Record modal uses.
  const { currency, prefix, fxHint } = useFxEntry(draft, set, nativeMoney);
  const cycleCurrency = () =>
    set({ currency: currency === "THB" ? "USD" : "THB", fxManual: false });
  // A CUSTOM (manual-priced) asset picks its currency (interactive pill, default ฿); a
  // Thai fund / US Stock/ETF derives it read-only from the source.
  const primaryCycle = draft.quoteSource === "manual" ? cycleCurrency : undefined;

  return (
    <div className="ledger-edit-card">
      <div className={`rec-edit${anchor ? " is-anchor" : amountOnly || isCash ? " is-flow" : ""}`}>
        <select
          value={draft.kind}
          onChange={(e) => {
            const k = e.target.value as TxnKind;
            set(
              isCashKind(k)
                ? { kind: k, quoteSource: "cash", quoteSourceLocked: true }
                : { kind: k },
            );
          }}
          aria-label="Type"
        >
          {typeSelectOptions(draft.kind).map((o) => (
            <option key={o.label} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={draft.tradeDate}
          onChange={(e) => set({ tradeDate: e.target.value })}
          aria-label={anchor ? "As-of date" : "Trade date"}
        />
        {isCash ? (
          <input
            value={draft.ticker}
            onChange={(e) => set({ ticker: e.target.value })}
            placeholder="Account"
            aria-label="Cash account name"
          />
        ) : (
          <SymbolCombobox
            value={draft.ticker}
            quoteSource={draft.quoteSource ? (draft.quoteSource as QuoteSource) : undefined}
            sourceLocked={draft.quoteSourceLocked}
            pool={pool}
            onChange={(text) =>
              set({ ticker: text, ...(draft.quoteSourceLocked ? {} : { quoteSource: "" }) })
            }
            onPick={(s) =>
              set({ ticker: s.ticker, quoteSource: s.quoteSource, quoteSourceLocked: false })
            }
            onToggleSource={() => {
              // Cycle Thai fund → Stock/ETF → Custom (manual price).
              const qs = (draft.quoteSource || "manual") as QuoteSource;
              const next: QuoteSource =
                qs === "thai_mutual_fund"
                  ? "market"
                  : qs === "market"
                    ? "manual"
                    : "thai_mutual_fund";
              set({ quoteSource: next, quoteSourceLocked: true });
            }}
          />
        )}
        {isCash ? (
          <div className="rec-money">
            {/* Cash picks its currency — the ฿⇄$ pill is interactive. */}
            <MoneyInput
              echo={prefix(cycleCurrency)}
              value={cashBalance ? (draft.value ?? "") : draft.amount}
              onChange={(e) =>
                set(cashBalance ? { value: e.target.value } : { amount: e.target.value })
              }
              placeholder={cashBalance ? "Balance" : "Amount"}
              inputMode="decimal"
              aria-label={cashBalance ? "Cash balance" : "Cash amount"}
            />
            {fxHint}
          </div>
        ) : amountOnly ? (
          <div className="rec-money">
            <MoneyInput
              echo={prefix(primaryCycle)}
              value={draft.amount}
              onChange={(e) => set({ amount: e.target.value })}
              placeholder="Amount"
              inputMode="decimal"
              aria-label={`Amount in ${currency}`}
            />
            {fxHint}
          </div>
        ) : (
          <>
            <div className="rec-money">
              <QtyInput
                units={draft.units}
                // `value` is the real ฿ total (a trade's amount, a Balance's value) so the
                // toggle has data to re-type. A saved row stores only the typed fact, so
                // open in the mode that fact implies — Units when a count is present, else
                // ฿ — via the shared `qtyDefaultMode` (the SAME rule the Add modal uses).
                value={anchor ? draft.value : draft.amount}
                defaultMode={qtyDefaultMode(draft.units)}
                // The $/฿ currency prefix on the ฿ total — read-only when the source
                // decides it, an interactive pill for a custom asset.
                leading={prefix(primaryCycle)}
                onUnits={(v) => set({ units: v })}
                onValue={(v) => set(anchor ? { value: v } : { amount: v })}
              />
              {fxHint}
            </div>
            {/* Every money field echoes the currency ($/฿) read-only; currency is set on
                the total field. */}
            <MoneyInput
              echo={prefix()}
              value={draft.pricePerUnit}
              onChange={(e) => set({ pricePerUnit: e.target.value })}
              placeholder={anchor ? "Avg cost" : "Price"}
              inputMode="decimal"
              aria-label={anchor ? "Average cost" : "Price"}
              title={
                anchor
                  ? "Average cost you PAID per unit — not today's price (current value comes from the live NAV)."
                  : undefined
              }
            />
            {anchor ? (
              <MoneyInput
                echo={prefix()}
                value={draft.marketPrice}
                onChange={(e) => set({ marketPrice: e.target.value })}
                placeholder="Current price"
                inputMode="decimal"
                aria-label="Current price"
                title="Today's price per unit. Only needed for a custom asset we can't price live — known funds use the live NAV."
              />
            ) : (
              <MoneyInput
                echo={prefix()}
                value={draft.fee}
                onChange={(e) => set({ fee: e.target.value })}
                placeholder="Fee"
                inputMode="decimal"
                aria-label="Fee"
              />
            )}
          </>
        )}
      </div>
      <div className="ledger-edit-actions">
        <span className="rec-type-help">
          <Icon name="info" size={12} />
          {TXN_KIND_HELP[draft.kind]}
        </span>
        {onDelete && (
          <button
            type="button"
            className="btn link sm"
            onClick={onDelete}
            disabled={busy}
            style={{ color: "var(--loss)" }}
          >
            Delete
          </button>
        )}
        <button type="button" className="btn ghost sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn primary sm" onClick={onSave} disabled={busy}>
          {busy ? "Saving…" : "Save"} <Icon name="check" size={12} />
        </button>
      </div>
    </div>
  );
}
