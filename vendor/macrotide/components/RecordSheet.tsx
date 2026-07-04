"use client";

// RecordSheet — the unified "Add to portfolio". ONE surface for both a current-
// holdings snapshot (Starting-balance rows → opening anchors) and buy/sell
// activity (trade rows → ledger deltas). There is NO holdings/history mode: the
// kind lives PER ROW (a Type) and is auto-detected from pasted/imported data —
// the same model Maybe Finance (Valuation vs Trade), Beancount (opening-balance
// vs trade), and Fava's per-type add modal all converge on.
//
// Layout: one calm intake (paste / screenshot / + add row) → a review LIST of
// native holdings-style rows, each tappable into the inline `.rec-edit` editor
// whose Type dropdown spans Starting balance + every trade kind and reshapes the
// fields. Narrow modal on desktop / full-bleed bottom sheet on mobile (the Modal
// primitive); the `.rec-edit` grid stacks on narrow, so no wide modal needed.

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { SymbolCombobox } from "@/components/portfolio/SymbolCombobox";
import { Combobox } from "@/components/ui/Combobox";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { QtyInput, qtyDefaultMode } from "@/components/ui/QtyInput";
import { fxCurrency, useFxEntry } from "@/components/ui/useFxEntry";
import { mergeCashPurposes } from "@/lib/data/cash-purposes";
import { mergeWithHoldings, type TickerSuggestion } from "@/lib/data/known-holdings";
import { mergeSourceSuggestions } from "@/lib/data/sources";
import {
  saveEarmark,
  useBrokerConnectors,
  useBuckets,
  useEarmarks,
  useHoldings,
} from "@/lib/fetchers/portfolio";
import { cachedQuoteSource, resolveQuoteSources } from "@/lib/fetchers/quote-source";
import { invalidate, useResource } from "@/lib/fetchers/swr";
import { fmtDate, fmtTHBClean } from "@/lib/format";
import { readExifCapture } from "@/lib/image-exif";
import { normalizeImage } from "@/lib/image-normalize";
import type { QuoteSource } from "@/lib/market/sources";
import { looksLikeBrokerExport, parseBrokerExport } from "@/lib/portfolio/broker-import";
import type { LedgerTxn, TxnKind } from "@/lib/portfolio/lots";
import type { NativeInputs } from "@/lib/portfolio/native-inputs";
import type { ExtractedTxnRow, ImportDocType } from "@/lib/portfolio/ocr";
import { type CashNudge, previewBalanceChange } from "@/lib/portfolio/settlement-cash";
import { TXN_KIND_HELP, TXN_KIND_LABEL, typeSelectOptions } from "@/lib/portfolio/txn-display";
import {
  isCashKind,
  isTxnKind,
  normalizeDate,
  normalizeTxnDraft,
  parseTxnPaste,
  type RowInvalidReason,
  rowValidity,
} from "@/lib/portfolio/txn-import";
import type { ImportSeedRow } from "@/lib/stores/import-seed";

// localStorage flag: user dismissed the "connect your broker" CTA in the Add sheet.
const BROKER_CTA_DISMISS_KEY = "macrotide_hide_broker_cta";

// "opening" is the Starting balance (snapshot anchor); the rest are trade deltas.
type RowKind = TxnKind;

// Verb-first label for the collapsed row. Both anchors read as "Balance".
const VERB: Record<RowKind, string> = {
  opening: "Balance",
  snapshot: "Balance",
  buy: "Bought",
  sell: "Sold",
  dividend: "Dividend",
  fee: "Fee",
  split: "Split",
  reinvest: "Reinvested",
  deposit: "Deposited",
  withdraw: "Withdrew",
  cash_balance: "Balance",
};

const ABBR: Record<RowKind, string> = {
  opening: "BAL",
  snapshot: "BAL",
  buy: "BUY",
  sell: "SELL",
  dividend: "DIV",
  fee: "FEE",
  split: "SPL",
  reinvest: "RE",
  deposit: "DEP",
  withdraw: "WD",
  cash_balance: "CASH",
};

const TONE: Record<RowKind, string> = {
  opening: "var(--amber)",
  buy: "var(--accent)",
  sell: "var(--loss)",
  dividend: "var(--accent-2)",
  reinvest: "var(--accent-2)",
  fee: "var(--muted-2)",
  split: "var(--muted-2)",
  snapshot: "var(--amber)",
  deposit: "var(--accent)",
  withdraw: "var(--loss)",
  cash_balance: "var(--accent-2)",
};

const isAnchor = (k: RowKind): boolean => k === "opening" || k === "snapshot";

/** Shared-gate reason → this surface's terse inline nudge (the Add modal's voice).
 *  `missing-ticker` is handled by the caller (no nudge — fill the symbol first). */
const NEEDS_NUDGE: Record<RowInvalidReason, string> = {
  "missing-ticker": "",
  "missing-date": "needs a date",
  "missing-amount": "needs an amount",
  "missing-ratio": "needs a split ratio",
  "needs-price": "needs a price",
  "balance-needs-figure": "needs units or a ฿ total",
  "custom-needs-price": "needs a current price",
};
const numFmt = (s: string): string => {
  const n = Number(s);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : s;
};

interface Row {
  id: number;
  kind: RowKind;
  tradeDate: string;
  ticker: string;
  englishName?: string;
  units: string;
  price: string; // price/unit (trade) OR avg cost (anchor)
  /** A Balance's current market price per unit — used to value a custom asset
   * that has no live NAV. Empty for trades (their price doubles as the market). */
  currentPrice?: string;
  /** A Balance's stated current ฿ VALUE when the source shows value not units
   * (Thai-app case). Units are derived from value ÷ NAV(date) at save (#130) —
   * carried here so a value-only row persists and reaches the server. */
  value?: string;
  /** A value-only Balance's invested ฿ cost-basis TOTAL (a fact, when the source
   * shows it). Sent as the ledger `amount` magnitude so the cost reaches XIRR; the
   * per-unit avg cost derives from it ÷ units at the fold — never frozen here. */
  costTotal?: string;
  /** True when units/avg-cost were DERIVED from a value (not read) — the editor
   * marks those fields estimated so the user knows to verify. */
  estimated?: boolean;
  fee: string;
  amount: string;
  /** A cash account's currency (deposit/withdraw/cash_balance). Defaults THB. */
  currency?: string;
  /** Native→THB rate for a non-THB holding (cash account OR a foreign-listed
   * security); "" / "1" for THB. The entered figures are in the native
   * currency; the ledger ฿ amount is figure × this rate. */
  fxToThb?: string;
  /** True once the user edits the FX rate by hand — stops the trade-date auto-fetch
   * from overwriting their figure when the ticker / currency / date changes. */
  fxManual?: boolean;
  /** Cash account Purpose (#149) — its RETURN role + an optional objective label;
   * saved as an earmark on submit. Only meaningful for cash rows. */
  cashRole?: "investable" | "reserved";
  cashLabel?: string;
  quoteSource?: QuoteSource;
  /** True once the user explicitly flips the price-source badge — pins the badge
   * highlight and stops a ticker edit from re-inferring over the choice. */
  quoteSourceLocked?: boolean;
  /** Origin — paste rows are owned by the textbox (re-derived on "Update
   * table"); manual / image rows are independent and survive a re-parse. */
  provenance?: "paste" | "manual" | "image";
}

// The viewer's LOCAL calendar date as "YYYY-MM-DD". Not `toISOString()` (UTC):
// near midnight, UTC-today can be a day off from the date the user is actually
// living, which would default a trade to the wrong day.
const today = (): string => {
  const d = new Date();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${day}`;
};

let nextId = 1;
const blankRow = (kind: RowKind): Row => ({
  id: nextId++,
  kind,
  // A Balance defaults to today (as-of now); a trade leaves the date blank to fill.
  tradeDate: isAnchor(kind) ? today() : "",
  ticker: "",
  units: "",
  price: "",
  fee: "",
  amount: "",
  provenance: "manual",
});

// A fresh cash row: a named account, priced as cash, defaulting to "Set balance"
// (the hero) as of today, in THB.
const newCashRow = (): Row => ({
  ...blankRow("cash_balance"),
  tradeDate: today(),
  quoteSource: "cash",
  quoteSourceLocked: true,
  currency: "THB",
  cashRole: "investable",
  cashLabel: "",
});

// An untouched manual row (e.g. the default row on open) — no fund or numbers
// typed. Dropped once real rows arrive from paste/import so it isn't left dangling.
const isBlankManual = (r: Row): boolean =>
  r.provenance === "manual" &&
  !r.ticker.trim() &&
  !r.units.trim() &&
  !r.price.trim() &&
  !r.amount.trim() &&
  !r.fee.trim();

// A row with nothing typed yet (any family — also covers the cash `value` field).
// Switching the Investment|Cash toggle CONVERTS such a row in place instead of
// spawning a second one; an edited row is preserved.
const isRowPristine = (r: Row): boolean =>
  !r.ticker.trim() &&
  !r.units.trim() &&
  !r.price.trim() &&
  !r.amount.trim() &&
  !r.fee.trim() &&
  !(r.value ?? "").trim() &&
  !(r.currentPrice ?? "").trim() &&
  !(r.costTotal ?? "").trim();

// Map a pasted draft → a Row. A row with no trade date is read as a Starting
// balance (the snapshot case); a dated row keeps its detected trade kind.
function draftToRow(d: ReturnType<typeof parseTxnPaste>[number]): Row {
  const kind: RowKind = d.tradeDate ? d.kind : "opening";
  return {
    id: nextId++,
    kind,
    tradeDate: d.tradeDate,
    ticker: d.ticker,
    englishName: d.englishName,
    units: d.units != null ? String(d.units) : "",
    price: d.pricePerUnit != null ? String(d.pricePerUnit) : "",
    fee: d.fee != null ? String(d.fee) : "",
    amount: d.amount != null ? String(d.amount) : "",
    quoteSource: d.quoteSource,
    provenance: "paste",
  };
}

// Map an OCR'd holdings row (snapshot screenshot) → a Starting-balance Row.
// `asOf` is the snapshot date (from the file). Units READ off the source make a
// units row; units DERIVED from a ฿ value (s.estimated — the Thai-app case) make a
// VALUE-driven row: the Balance opens in ฿ mode showing the figure the user
// recognises, and the server re-derives units from NAV(asOf) at save (#130) — we
// don't headline a 5-decimal unit count nobody typed.
function seedHoldingToRow(s: ImportSeedRow, asOf = ""): Row {
  const readUnits = s.estimated !== true && s.units != null ? String(s.units) : "";
  return {
    id: nextId++,
    kind: "opening",
    // The Add-modal path passes `asOf`; the Advisor path stamps it on the row.
    tradeDate: asOf || s.asOf || "",
    ticker: s.ticker,
    englishName: s.englishName,
    units: readUnits,
    // Seed an avg cost ONLY when it's a real per-unit figure read off the source —
    // never a derived estimate (a value-only row's per-unit cost is derived at the
    // fold from costTotal ÷ units, not frozen). The invested TOTAL rides on costTotal.
    price: s.estimated !== true && s.avgCost != null ? String(s.avgCost) : "",
    // Carry the ฿ value whenever units aren't shown (a derived or no-NAV row).
    value: readUnits === "" && s.value != null ? String(s.value) : "",
    costTotal: s.costTotal != null ? String(s.costTotal) : "",
    estimated: s.estimated,
    fee: "",
    amount: "",
    quoteSource: s.quoteSource ?? "manual",
    provenance: "image",
  };
}

function seedTxnToRow(e: ExtractedTxnRow, asOf = ""): Row {
  // Trades carry their own dated rows; fall back to the file date only if absent.
  const tradeDate = normalizeDate(e.tradeDate ?? "") || asOf;
  return {
    id: nextId++,
    kind: tradeDate ? ((e.kind as RowKind) ?? "buy") : "opening",
    tradeDate,
    ticker: e.ticker,
    englishName: e.englishName,
    units: e.units != null ? String(e.units) : "",
    price: e.pricePerUnit != null ? String(e.pricePerUnit) : "",
    fee: e.fee != null ? String(e.fee) : "",
    amount: e.amount != null ? String(e.amount) : "",
    quoteSource: "manual",
    provenance: "image",
  };
}

export interface RecordSheetProps {
  open: boolean;
  onClose: () => void;
  onSaved?: (count: number) => void;
  /** Funded-from-cash nudges the save produced (#232) — the parent surfaces them
   * (the sheet has already closed by then). */
  onCashNudges?: (bucketId: string, nudges: CashNudge[]) => void;
  defaultBucketId?: string | null;
  /** "opening" when entered from Holdings "Add"; "buy" from a Record action. */
  defaultKind?: RowKind;
  /** Which family the modal opens in (#149). "cash" jumps straight to the cash form
   * (the split-button "Add cash" path); defaults to "investment". */
  defaultMode?: "investment" | "cash";
  /** Rows seeded from the Advisor's in-chat holdings table (→ Starting balances). */
  holdingsSeed?: ImportSeedRow[] | null;
  /** Rows seeded from a handoff (→ activity). */
  txnSeed?: ExtractedTxnRow[] | null;
  /** Open the standalone broker-connect wizard (closes this sheet first). */
  onConnectBroker?: () => void;
}

export function RecordSheet({
  open,
  onClose,
  onSaved,
  onCashNudges,
  defaultBucketId,
  defaultKind = "opening",
  defaultMode = "investment",
  holdingsSeed,
  txnSeed,
  onConnectBroker,
}: RecordSheetProps) {
  const { data: buckets } = useBuckets();
  const { data: holdings } = useHoldings();
  const { data: brokerConnectors } = useBrokerConnectors();
  // CTA shows only when a broker is configured, you haven't connected yet, and
  // you haven't dismissed it (persisted).
  const { data: brokerConns } = useResource<unknown[]>("/api/import/broker/connections");
  const [ctaDismissed, setCtaDismissed] = useState(false);
  useEffect(() => {
    try {
      setCtaDismissed(localStorage.getItem(BROKER_CTA_DISMISS_KEY) === "1");
    } catch {}
  }, []);
  // One broker → name it; several → stay generic.
  const brokerCtaLabel =
    brokerConnectors?.length === 1 ? brokerConnectors[0].displayName : "your broker";
  const showBrokerCta =
    !!onConnectBroker &&
    !!brokerConnectors?.length &&
    !ctaDismissed &&
    !(Array.isArray(brokerConns) && brokerConns.length > 0);
  const dismissBrokerCta = () => {
    try {
      localStorage.setItem(BROKER_CTA_DISMISS_KEY, "1");
    } catch {}
    setCtaDismissed(true);
  };
  const [bucketId, setBucketId] = useState("");
  const [source, setSource] = useState("");
  // Investment | Cash segment (#149 D5): Investment = the symbol-based flow (paste /
  // screenshot / Balance / Buy / Sell…); Cash = a scoped form for a named account
  // (Set balance / Deposit / Withdraw), no symbol or fund intake.
  const [mode, setMode] = useState<"investment" | "cash">(defaultMode);
  const [rows, setRows] = useState<Row[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [imgBusy, setImgBusy] = useState(false);
  // Set when an imported screenshot's type (snapshot vs history) was a
  // low-confidence guess — drives the "switch type?" confirm banner. Carries the
  // model's as-of date so a re-read keeps it (the override path skips detection).
  const [unsure, setUnsure] = useState<{
    file: File;
    guessed: ImportDocType;
    asOf: string;
  } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // On each open, target the active portfolio (defaultBucketId). In the All view
  // there's no active portfolio (defaultBucketId undefined) — keep the last pick,
  // falling back to the first portfolio. Re-runs only on open / default change, so
  // it never clobbers a bucket the user changes mid-session.
  useEffect(() => {
    if (!open) return;
    if (defaultBucketId) setBucketId(defaultBucketId);
    else setBucketId((prev) => prev || buckets?.[0]?.id || "");
  }, [open, defaultBucketId, buckets]);

  // Consume seeds once per open.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!open) {
      seededRef.current = false;
      return;
    }
    if (seededRef.current) return;
    const seeded: Row[] = [];
    if (holdingsSeed?.length) seeded.push(...holdingsSeed.map((s) => seedHoldingToRow(s)));
    if (txnSeed?.length) seeded.push(...txnSeed.map((e) => seedTxnToRow(e)));
    if (seeded.length) {
      seededRef.current = true;
      setRows(seeded);
    }
  }, [open, holdingsSeed, txnSeed]);

  // On open with no seeds, start with ONE editable row (opened in the editor) so
  // the modal is immediately usable instead of blank. Runs on the open transition
  // only; a fresh open also clears a previous, cancelled session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: open-transition only
  useEffect(() => {
    if (!open || holdingsSeed?.length || txnSeed?.length) return;
    // Open straight into the requested family — "cash" (the split-button "Add cash"
    // path) seeds a scoped Set-balance row; otherwise the usual fund row.
    const r =
      defaultMode === "cash"
        ? newCashRow()
        : blankRow(defaultKind === "opening" ? "opening" : "buy");
    setRows([r]);
    setEditing(r.id);
    setPasteText("");
    setError(null);
    setMode(defaultMode);
  }, [open]);

  const sourceOptions = useMemo(
    () => mergeSourceSuggestions((holdings ?? []).map((h) => h.source)),
    [holdings],
  );
  // Substring-filtered source suggestions for the custom combobox (the native
  // datalist filtered itself; this one does it explicitly).
  const sourceItems = useMemo(() => {
    const q = source.trim().toLowerCase();
    const base = q ? sourceOptions.filter((s) => s.toLowerCase().includes(q)) : sourceOptions;
    return base.slice(0, 8);
  }, [source, sourceOptions]);
  const tickerOptions = useMemo<TickerSuggestion[]>(
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
  // Existing cash account names — autocomplete the Account field (Set balance an account
  // you already track, or name a new one).
  const cashAccounts = useMemo(
    () => [
      ...new Set(
        (holdings ?? [])
          .filter((h) => h.quoteSource === "cash")
          .map((h) => h.englishName || h.ticker),
      ),
    ],
    [holdings],
  );
  // Existing Purpose labels for the Label combobox + the current designation per account.
  const { data: earmarks } = useEarmarks();
  const purposeLabels = useMemo(
    () => mergeCashPurposes((earmarks ?? []).map((e) => e.purpose)),
    [earmarks],
  );
  // The bucket's ledger, fetched only while a Set-balance row is being entered —
  // feeds the "raise ≈ recent sale proceeds → no money moved" default (#232). The
  // suggestion helper is pure, so the fold runs client-side on the fetched rows.
  const wantLedger = open && !!bucketId && rows.some((r) => r.kind === "cash_balance");
  const { data: ledgerRows } = useResource<
    Array<{
      id: number;
      ticker: string;
      kind: string;
      tradeDate: string;
      units: number | null;
      amount: number;
      fxToThb: number | null;
      reconcile: boolean | null;
      createdAt: string | null;
    }>
  >(wantLedger ? `/api/transactions?bucket=${encodeURIComponent(bucketId)}` : null);
  const bucketLedger = useMemo<LedgerTxn[] | undefined>(
    () =>
      ledgerRows?.map((r) => ({
        id: r.id,
        ticker: r.ticker,
        kind: isTxnKind(r.kind) ? r.kind : "buy",
        tradeDate: r.tradeDate,
        units: r.units,
        amount: r.amount,
        fxToThb: r.fxToThb,
        reconcile: r.reconcile,
        createdAt: r.createdAt ?? undefined,
      })),
    [ledgerRows],
  );

  const reset = () => {
    setRows([]);
    setEditing(null);
    setPasteText("");
    setError(null);
    setUnsure(null);
  };

  // Ingest a broker export (JSON from the one-click importer, or pasted) → seed
  // its trade rows as independent imported rows in the review list.
  const ingestBrokerPayload = (raw: string) => {
    const { rows: txnRows, stats, warnings } = parseBrokerExport(raw);
    if (txnRows.length === 0) {
      setError(warnings[0] ?? "No transactions found in that broker export.");
      return;
    }
    const seeded = txnRows.filter((r) => r.ticker?.trim()).map((r) => seedTxnToRow(r));
    setEditing(null);
    setRows((prev) => [...prev.filter((r) => !isBlankManual(r)), ...seeded]);
    const acctNote = stats.accounts > 1 ? ` from ${stats.accounts} portfolios` : "";
    setError(
      warnings.length
        ? `Imported ${stats.imported} row(s)${acctNote}. ${warnings.join(" ")}`
        : null,
    );
  };

  // Re-derive the PASTE rows from the textbox, leaving manual/image rows intact.
  // The textbox owns its rows: editing it + "Update table" updates/replaces/
  // deletes only those (manual rows are independent).
  const syncPasteRows = (text: string) => {
    // A pasted broker export (JSON) goes through the broker parser, not the
    // line-based paste format.
    if (looksLikeBrokerExport(text)) {
      ingestBrokerPayload(text);
      return;
    }
    const drafts = parseTxnPaste(text).filter((d) => d.ticker.trim());
    if (drafts.length === 0) {
      if (text.trim())
        setError("Couldn't read any rows — one entry per line (e.g. EXAMPLE-FUND-A, 100, 25.00).");
      setRows((prev) => prev.filter((r) => r.provenance !== "paste"));
      return;
    }
    setError(null);
    // Real rows arrived → drop the untouched default/blank manual row and collapse
    // any open editor, so the review list shows what was pasted, not an empty stub.
    setEditing(null);
    setRows((prev) => [
      ...prev.filter((r) => r.provenance !== "paste" && !isBlankManual(r)),
      ...drafts.map(draftToRow),
    ]);
  };

  // Ingest dropped/chosen files — screenshots (OCR → Starting balances) and
  // CSV/text (parsed → detected rows). Multiple files at once.
  // Read one screenshot. The endpoint auto-detects holdings-snapshot (→ Starting
  // balances) vs transaction-history (→ trade rows) and returns the matching rows
  // plus a confidence; `as` forces a type when the user resolves a low-confidence
  // guess via the banner.
  const importFile = async (
    file: File,
    as?: ImportDocType,
    asOfHint = "",
  ): Promise<{ rows: Row[]; docType: ImportDocType; confidence: "high" | "low"; asOf: string }> => {
    const fd = new FormData();
    // Normalize to the shared 2048/0.8 JPEG so the OCR pipeline gets the same
    // image the Advisor does (same model) — bounds upload + tile cost, keeps the
    // resolution the model needs to read dense tables.
    const norm = await normalizeImage(file);
    fd.append("image", norm.blob, file.name);
    // Filename + capture time ride as CONTEXT for the model's as-of-date call (a
    // date shown in the image wins; we never parse the filename ourselves). Prefer
    // the original file's EXIF capture time (read before normalize, which strips
    // EXIF); fall back to the file's mtime.
    fd.append("filename", file.name);
    const exif = await readExifCapture(file);
    const capturedAt =
      exif?.capturedAt ?? (file.lastModified ? new Date(file.lastModified).toISOString() : null);
    if (capturedAt) fd.append("capturedAt", capturedAt);
    if (as) fd.append("as", as);
    const res = await fetch("/api/import/image", { method: "POST", body: fd });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as {
      docType: ImportDocType;
      confidence: "high" | "low";
      asOf?: string | null;
      holdings?: ImportSeedRow[];
      transactions?: ExtractedTxnRow[];
    };
    // The override path skips classification (no asOf) — re-use the date the
    // first read found.
    const asOf = body.asOf ?? asOfHint;
    const rows =
      body.docType === "transactions"
        ? (body.transactions ?? [])
            .filter((r) => r.ticker?.trim())
            .map((r) => seedTxnToRow(r, asOf))
        : (body.holdings ?? [])
            .filter((r) => r.ticker?.trim())
            .map((r) => seedHoldingToRow(r, asOf));
    return { rows, docType: body.docType, confidence: body.confidence, asOf };
  };
  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setImgBusy(true);
    setError(null);
    setUnsure(null);
    try {
      const collected: Row[] = [];
      let unsureFile: { file: File; guessed: ImportDocType; asOf: string } | null = null;
      for (const file of files) {
        if (file.type.startsWith("image/")) {
          const det = await importFile(file);
          collected.push(...det.rows);
          if (det.confidence === "low" && det.rows.length) {
            unsureFile = { file, guessed: det.docType, asOf: det.asOf };
          }
        } else {
          collected.push(
            ...parseTxnPaste(await file.text())
              .filter((d) => d.ticker.trim())
              .map(draftToRow),
          );
        }
      }
      if (collected.length) {
        setEditing(null);
        setRows((prev) => [...prev.filter((r) => !isBlankManual(r)), ...collected]);
        setUnsure(unsureFile);
      } else setError("Couldn't read those files. Try a sharper screenshot, or paste the rows.");
    } catch {
      setError("Couldn't read those files. Try a sharper screenshot, or paste the rows.");
    } finally {
      setImgBusy(false);
    }
  };
  // Re-read the unsure image as the OTHER type and swap in those rows.
  const switchImportType = async () => {
    if (!unsure) return;
    const other: ImportDocType = unsure.guessed === "transactions" ? "holdings" : "transactions";
    setImgBusy(true);
    setError(null);
    try {
      const det = await importFile(unsure.file, other, unsure.asOf);
      setRows((prev) => [...prev.filter((r) => r.provenance !== "image"), ...det.rows]);
      setUnsure(null);
    } catch {
      setError("Couldn't re-read that image. Try pasting the rows instead.");
    } finally {
      setImgBusy(false);
    }
  };
  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    void handleFiles(files);
  };

  const addManual = () => {
    if (mode === "cash") {
      const r = newCashRow();
      setRows((prev) => [...prev, r]);
      setEditing(r.id);
      return;
    }
    const kind: RowKind = (holdings?.length ?? 0) > 0 ? defaultKind : "opening";
    const r = blankRow(kind === "opening" ? "opening" : "buy");
    setRows((prev) => [...prev, r]);
    setEditing(r.id);
  };

  const freshInvestmentRow = (): Row => blankRow(defaultKind === "opening" ? "opening" : "buy");

  // Switch the intake family. If the only row is untouched, CONVERT it to the other
  // family in place (investment Balance ↔ cash Balance) — no second row. If you've
  // edited it (or there are several), keep your work and add a fresh row of the new
  // family instead (so a new entry is created only when the row was edited).
  const switchMode = (m: "investment" | "cash") => {
    if (m === mode) return;
    setMode(m);
    if (rows.length === 1 && isRowPristine(rows[0])) {
      const next = m === "cash" ? newCashRow() : freshInvestmentRow();
      next.id = rows[0].id;
      setRows([next]);
      setEditing(next.id);
      return;
    }
    if (rows.some((r) => isCashKind(r.kind) === (m === "cash"))) return; // already have one
    const fresh = m === "cash" ? newCashRow() : freshInvestmentRow();
    setRows((prev) => [...prev, fresh]);
    setEditing(fresh.id);
  };

  // Resolve each row's price source against the REAL fund catalog (in the catalog →
  // its fund source, else custom) so the badge is right on the fly for ANY typed or
  // imported symbol. Skips rows the user pinned; debounced + cached (the shared
  // resolver the History editor uses too) so it fires once per new symbol and
  // converges, only patching when the source actually differs.
  useEffect(() => {
    const applyCached = () =>
      setRows((prev) => {
        let changed = false;
        const next = prev.map((r) => {
          if (r.quoteSourceLocked || !r.ticker.trim()) return r;
          const resolved = cachedQuoteSource(r.ticker);
          if (resolved && resolved !== r.quoteSource) {
            changed = true;
            return { ...r, quoteSource: resolved };
          }
          return r;
        });
        return changed ? next : prev;
      });

    applyCached(); // paint anything already cached immediately
    const tickers = rows
      .filter((r) => r.ticker.trim() && !r.quoteSourceLocked)
      .map((r) => r.ticker);
    const timer = setTimeout(() => {
      void resolveQuoteSources(tickers).then((gained) => {
        if (gained) applyCached();
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [rows]);

  const patch = (id: number, p: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const removeRow = (id: number) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
    if (editing === id) setEditing(null);
  };

  // A row is ready iff the shared gate accepts it — the SAME predicate the History
  // editor's save() runs, so the Add modal and History accept/reject identically.
  const valid = (r: Row): boolean =>
    rowValidity({
      tradeDate: r.tradeDate,
      kind: r.kind,
      ticker: r.ticker,
      units: r.units,
      value: r.value,
      pricePerUnit: r.price,
      amount: r.amount,
      fee: r.fee,
      quoteSource: r.quoteSource,
      currentPrice: r.currentPrice,
    }).ok;
  const readyRows = rows.filter(valid);

  const submit = async () => {
    if (!bucketId) {
      setError("Pick a portfolio first.");
      return;
    }
    if (readyRows.length === 0) {
      setError("Nothing ready to save yet — fill in at least one row.");
      return;
    }
    // A non-THB holding needs its trade-date FX rate to store a THB cost basis;
    // without it we'd silently record the native figure as baht. Block with a clear
    // ask rather than mis-store — the rate auto-fills on open, so this is the rare
    // cold-cache / offline case the user resolves by typing it.
    const missingFx = readyRows.find((r) => {
      if (r.kind === "split") return false; // a split moves no cash — no FX needed
      const c = fxCurrency(r);
      return c !== "THB" && !(Number(r.fxToThb) > 0);
    });
    if (missingFx) {
      setError(
        `Add the ${fxCurrency(missingFx)}→฿ FX rate for ${missingFx.ticker.trim() || "the non-THB row"} so its cost basis stores in baht.`,
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // The verbatim native figures the user typed, kept for a non-THB row so a
      // reopen shows the exact number ($500), not a `THB ÷ rate` reconstruction.
      // Provenance only — the THB columns stay authoritative. Drops empties and
      // returns undefined for THB (nothing to keep) or an all-empty bundle.
      const nativeBundle = (currency: string, fields: NativeInputs): NativeInputs | undefined => {
        if (currency === "THB") return undefined;
        const out: NativeInputs = {};
        for (const [k, v] of Object.entries(fields)) {
          if (typeof v === "number" && Number.isFinite(v) && v > 0) {
            out[k as keyof NativeInputs] = v;
          }
        }
        return Object.keys(out).length > 0 ? out : undefined;
      };
      const transactions = readyRows.map((r) => {
        const quoteSource = r.quoteSource || "manual";
        // Native→THB for a foreign-listed security's cost basis: the entered
        // figures are in the holding's currency; the ledger folds THB. THB → rate 1
        // (no-op). Cash has its own native-units convention below.
        const secCurrency = fxCurrency(r);
        const secRate = secCurrency === "THB" ? 1 : Number(r.fxToThb) > 0 ? Number(r.fxToThb) : 1;
        const toThb = (v: number | null | undefined): number | undefined =>
          v == null ? undefined : v * secRate;
        if (isCashKind(r.kind)) {
          // Cash: the entered figure is in the account currency = NATIVE units (THB by
          // default). `units` stays native (its position is valued at live FX); the
          // ledger ฿ `amount` is native × the trade-date rate (1 for THB). cash_balance
          // carries the asserted native balance (`units`) + its ฿ value; deposit/withdraw
          // carry the ฿ amount the server signs (deposit −, withdraw +).
          const currency = (r.currency || "THB").trim().toUpperCase() || "THB";
          const rate = currency === "THB" ? 1 : Number(r.fxToThb) > 0 ? Number(r.fxToThb) : 1;
          const native = r.kind === "cash_balance" ? Number(r.value || r.amount) : Number(r.amount);
          const figure = native > 0 ? native : 0;
          const thb = figure * rate;
          return {
            tradeDate: r.tradeDate || today(),
            kind: r.kind,
            // The cash account NAME is the ticker, kept in the user's own case (#235
            // supersedes the #149 upper-case + englishName-shadow workaround). The
            // server stores it as typed; matching is case-folded everywhere.
            ticker: r.ticker.trim(),
            englishName: r.ticker.trim() || undefined,
            units: figure > 0 ? figure : undefined,
            value: r.kind === "cash_balance" && thb > 0 ? thb : undefined,
            amount: r.kind === "cash_balance" ? 0 : thb,
            quoteSource: "cash",
            tradeCurrency: currency,
            fxToThb: rate,
            // Cash needs no nativeInputs: its native figure already lives losslessly
            // in `units` (the editor reads cash amounts from there, never via ÷rate).
            source: source.trim() || undefined,
          };
        }
        if (isAnchor(r.kind)) {
          const hasUnits = Number(r.units) > 0;
          const avg = r.price.trim() === "" ? null : Number(r.price);
          // Persist a per-unit avg cost only when it's a real (read/typed) figure —
          // never a derived estimate, which would freeze a NAV-dependent number
          // (facts-only, ADR 0004). A value-only row's per-unit cost derives at the fold.
          const realAvg = r.estimated ? null : avg;
          // The cost magnitude (positive) for the ledger `amount`; the server signs it
          // (opening = cash out, a restatement = 0) so a costed opening reaches XIRR.
          // Units read → from the real avg cost; value-only → the invested total.
          const costMagnitude =
            hasUnits && realAvg != null
              ? Number(r.units) * realAvg
              : Number(r.costTotal) > 0
                ? Number(r.costTotal)
                : 0;
          return {
            tradeDate: r.tradeDate || today(),
            kind: r.kind,
            // Send the typed case; the server stores the official catalog case (#235).
            ticker: r.ticker.trim(),
            englishName: r.englishName,
            // Send units when read; otherwise omit and send the (THB) value so the
            // server derives units from NAV(tradeDate) (#130). Money facts convert to
            // THB via the trade-date rate; `units` stay a native share count.
            units: hasUnits ? Number(r.units) : undefined,
            value: !hasUnits && Number(r.value) > 0 ? toThb(Number(r.value)) : undefined,
            pricePerUnit: toThb(realAvg),
            // The Balance's current price → the asset's market-price point (THB).
            marketPrice: r.currentPrice?.trim() ? toThb(Number(r.currentPrice)) : undefined,
            amount: toThb(costMagnitude) ?? 0,
            quoteSource,
            tradeCurrency: secCurrency,
            fxToThb: secRate,
            nativeInputs: nativeBundle(secCurrency, {
              value: !hasUnits && Number(r.value) > 0 ? Number(r.value) : undefined,
              price: realAvg ?? undefined,
              marketPrice: r.currentPrice?.trim() ? Number(r.currentPrice) : undefined,
              amount: costMagnitude,
            }),
            source: source.trim() || undefined,
          };
        }
        const d = normalizeTxnDraft({
          tradeDate: r.tradeDate,
          kind: r.kind,
          ticker: r.ticker,
          units: r.units,
          pricePerUnit: r.price,
          amount: r.amount,
          fee: r.fee,
          quoteSource: r.quoteSource,
        });
        return {
          tradeDate: d.tradeDate,
          kind: d.kind,
          ticker: d.ticker,
          englishName: r.englishName,
          // `units` (and a split ratio) are currency-free counts; the money fields
          // convert to THB via the trade-date rate. A split carries no cash.
          units: d.units,
          pricePerUnit: d.kind === "split" ? d.pricePerUnit : toThb(d.pricePerUnit),
          fee: d.kind === "split" ? d.fee : toThb(d.fee),
          amount: d.kind === "split" ? 0 : (toThb(d.amount) ?? 0),
          quoteSource: d.quoteSource || quoteSource,
          tradeCurrency: secCurrency,
          fxToThb: secRate,
          nativeInputs:
            d.kind === "split"
              ? undefined
              : nativeBundle(secCurrency, {
                  price: d.pricePerUnit ?? undefined,
                  fee: d.fee ?? undefined,
                  amount: d.amount ?? undefined,
                }),
          source: source.trim() || undefined,
        };
      });
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bucketId, transactions }),
      });
      // Facts-only ledger (ADR 0004): a value-only Balance always saves — even with no
      // NAV on its date yet — storing the ฿ value as the fact; its units derive at the
      // fold when that date's NAV lands. So there's no "couldn't price it" reject here.
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { count: number; cashNudges?: CashNudge[] };
      // Save the cash Purpose for any Set-balance row that set one — only when Reserved
      // or a label is given, so a plain Set balance never clobbers an existing designation.
      for (const r of readyRows) {
        if (
          r.kind === "cash_balance" &&
          (r.cashRole === "reserved" || (r.cashLabel ?? "").trim())
        ) {
          await saveEarmark({
            // Match the ledger ticker's natural case (#235); setAccountEarmark
            // canonicalizes + matches case-insensitively anyway.
            ticker: r.ticker.trim(),
            bucketId,
            role: r.cashRole ?? "investable",
            amount: null,
            purpose: r.cashLabel,
          });
        }
      }
      invalidate(/^\/api\/transactions/);
      invalidate(/^\/api\/holdings/);
      invalidate(/^\/api\/portfolios/);
      invalidate("/api/earmarks");
      // Funded-from-cash nudges (#232) outlive the sheet — the parent shows them
      // where the user lands after saving.
      if (body.cashNudges?.length) onCashNudges?.(bucketId, body.cashNudges);
      onSaved?.(body.count);
      reset();
      onClose();
    } catch {
      setError("Couldn't save. Check the values and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const hasRows = rows.length > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="form"
      className="modal--txnwide"
      labelledBy="rec-title"
    >
      <Modal.Header
        title="Add to portfolio"
        subtitle={
          mode === "cash"
            ? "Set a bank balance, or record a deposit / withdrawal."
            : "Paste, snap a screenshot, or add a row. We sort out what's a holding and what's a trade — change any row's type below."
        }
        id="rec-title"
        action={
          <div className="rec-segment rec-segment--compact" role="tablist" aria-label="Entry type">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "investment"}
              data-active={mode === "investment"}
              onClick={() => switchMode("investment")}
            >
              Investment
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "cash"}
              data-active={mode === "cash"}
              onClick={() => switchMode("cash")}
            >
              Cash
            </button>
          </div>
        }
      />
      <Modal.Body gap={12}>
        {showBrokerCta && onConnectBroker && (
          <div className="import-cta">
            <button type="button" className="import-cta__main" onClick={onConnectBroker}>
              <Icon name="download" size={14} />
              <span className="import-cta__text">
                <strong>Import from {brokerCtaLabel} automatically</strong>
                <span>Skip manual entry — connect once and it syncs.</span>
              </span>
            </button>
            <button
              type="button"
              className="import-cta__x"
              onClick={dismissBrokerCta}
              aria-label="Dismiss"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <label className="rec-field">
            <span className="rec-field__label">PORTFOLIO</span>
            <select
              className="sheet-input"
              value={bucketId}
              onChange={(e) => setBucketId(e.target.value)}
            >
              {(buckets ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="rec-field">
            <span className="rec-field__label">SOURCE</span>
            <Combobox<string>
              value={source}
              onChange={setSource}
              onPick={(s) => setSource(s)}
              items={sourceItems}
              getKey={(s) => s}
              renderItem={(s) => s}
              label="Source"
              placeholder="Broker (optional)"
              inputClassName="sheet-input"
            />
          </label>
        </div>

        {/* Investment | Cash lives in the header (#149 D5). Cash hides the fund intake
            (paste/screenshot) and scopes the rows to a named cash account.
            Investment intake — paste, drop screenshots/CSV, or add a row. Hidden in
            Cash mode (cash is entered by hand against a named account). */}
        {mode === "cash" ? null : (
          <div
            className="rec-intake"
            data-drag={dragOver || undefined}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void handleFiles(Array.from(e.dataTransfer.files ?? []));
            }}
          >
            <div className="rec-paste">
              <textarea
                rows={5}
                placeholder={
                  "Paste your holdings or a buy/sell log — one per line.\nEXAMPLE-FUND-A, 100, 25.00\n2024-03-12, Buy, K-EQUITY, 50, 18.40, 920\n\nOr drop screenshots / a CSV here."
                }
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                onPaste={(e) => {
                  // Auto-parse on paste — rows appear immediately, AND the raw text
                  // stays so you can edit it and re-sync with Apply.
                  const pasted = e.clipboardData.getData("text");
                  if (!pasted.trim()) return;
                  const t = e.currentTarget;
                  const start = t.selectionStart ?? t.value.length;
                  const end = t.selectionEnd ?? t.value.length;
                  const next = t.value.slice(0, start) + pasted + t.value.slice(end);
                  e.preventDefault();
                  setPasteText(next);
                  syncPasteRows(next);
                }}
              />
            </div>
            <div className="rec-intake__actions">
              {/* Apply sits to the LEFT of Images/CSV and only appears once there's
                text to read — so it never floats over the box or shifts its height. */}
              {pasteText.trim() && (
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={() => syncPasteRows(pasteText)}
                  title="Read the rows from this text"
                >
                  Apply
                </button>
              )}
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => fileRef.current?.click()}
                disabled={imgBusy}
              >
                <Icon name="chart" size={12} /> {imgBusy ? "Reading…" : "Images / CSV"}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,.csv,.txt,text/csv,text/plain"
                multiple
                hidden
                onChange={onFileInput}
              />
            </div>
          </div>
        )}

        {error && <div className="rec-error">{error}</div>}
        {unsure && (
          <div className="rec-ask">
            <span>
              Read this as{" "}
              <strong>
                {unsure.guessed === "transactions"
                  ? "a transaction history"
                  : "a holdings snapshot"}
              </strong>{" "}
              — not certain.
            </span>
            <button
              type="button"
              className="btn ghost sm"
              onClick={switchImportType}
              disabled={imgBusy}
            >
              Switch to {unsure.guessed === "transactions" ? "holdings" : "transactions"}
            </button>
          </div>
        )}

        {/* Review list — native holdings-style rows; tap to edit. */}
        {hasRows && (
          <div className="holdings-list" style={{ padding: 0 }}>
            {rows.map((r) =>
              editing === r.id ? (
                <RowEditor
                  key={r.id}
                  row={r}
                  tickers={tickerOptions}
                  cashAccounts={cashAccounts}
                  purposeOptions={purposeLabels}
                  bucketLedger={bucketLedger}
                  onChange={(p) => patch(r.id, p)}
                  onDone={() => setEditing(null)}
                  onRemove={() => removeRow(r.id)}
                />
              ) : (
                <DraftRow
                  key={r.id}
                  row={r}
                  onEdit={() => setEditing(r.id)}
                  onRemove={() => removeRow(r.id)}
                />
              ),
            )}
          </div>
        )}

        <button type="button" className="rec-add-row" onClick={addManual}>
          <Icon name="plus" size={13} />{" "}
          {mode === "cash" ? "Add a cash entry" : "Add an investment entry"}
        </button>

        {/* The Advisor chat-import path is fund-focused (it parses trades/holdings); cash
            entry isn't wired through it yet, so hide the prompt in Cash mode. */}
        {mode === "cash" ? null : (
          <p className="rec-hint">
            <Icon name="sparkle" size={12} /> Or tell Advisor in chat — e.g. “Add ฿50k of K-FIXED-A
            from SCB.” It confirms before saving.
          </p>
        )}
      </Modal.Body>
      <Modal.Footer
        start={
          hasRows ? (
            <span style={{ fontSize: 12, color: "var(--muted)" }}>{readyRows.length} ready</span>
          ) : undefined
        }
      >
        <button type="button" className="btn ghost" onClick={onClose} disabled={submitting}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={submit}
          disabled={submitting || readyRows.length === 0 || !bucketId}
        >
          {submitting ? "Saving…" : `Save ${readyRows.length || ""}`.trim()}{" "}
          <Icon name="check" size={13} />
        </button>
      </Modal.Footer>
    </Modal>
  );
}

// Collapsed draft row — the native holdings-row grammar.
function DraftRow({
  row,
  onEdit,
  onRemove,
}: {
  row: Row;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const anchor = isAnchor(row.kind);
  const hasTicker = row.ticker.trim().length > 0;
  // Filled rows read as a verb ("Bought K-EQUITY", "Balance · K-FIXED"); a blank
  // row just names its type ("Balance" / "Buy"), never the past-tense verb.
  const name = hasTicker
    ? `${VERB[row.kind]}${anchor ? " · " : " "}${row.ticker}`
    : TXN_KIND_LABEL[row.kind];
  const sub: string[] = [];
  if (row.tradeDate) sub.push(fmtDate(row.tradeDate));
  if (row.units.trim()) sub.push(`${numFmt(row.units)}${anchor ? " units" : ""}`);
  if (row.price.trim()) sub.push(anchor ? `avg ฿${numFmt(row.price)}` : `@ ฿${numFmt(row.price)}`);
  // Amount shown on the right: a typed ฿ total (`amount` — what a total-entered trade
  // or a dividend/fee carries) wins; otherwise derive it from a units × price entry.
  const amountOnly = row.kind === "dividend" || row.kind === "fee";
  const amt = anchor
    ? ""
    : row.amount.trim()
      ? fmtTHBClean(Math.abs(Number(row.amount)))
      : !amountOnly && row.units.trim() && row.price.trim()
        ? fmtTHBClean(Number(row.units) * Number(row.price))
        : "";
  // What this row still NEEDS to be saveable — the SHARED gate's reason (the same
  // predicate valid() runs), mapped to a terse inline fragment. One source of truth,
  // so the nudge can't drift from what actually blocks the save. Surfaced amber in the
  // subline. A missing symbol shows nothing — the ticker field is the obvious next step.
  const gate = rowValidity({
    tradeDate: row.tradeDate,
    kind: row.kind,
    ticker: row.ticker,
    units: row.units,
    value: row.value,
    pricePerUnit: row.price,
    amount: row.amount,
    fee: row.fee,
    quoteSource: row.quoteSource,
    currentPrice: row.currentPrice,
  });
  const needs = gate.ok || gate.reason === "missing-ticker" ? null : NEEDS_NUDGE[gate.reason];
  // Cost is OPTIONAL — a softer nudge ("adding one unlocks gains"), shown only once the
  // row is otherwise complete (so a required gap takes priority).
  const costUnknown =
    !needs && anchor && hasTicker && !row.price.trim() && !(Number(row.costTotal) > 0);
  return (
    <div className="holding" style={{ display: "flex", gap: 4 }}>
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${name || "row"}`}
        style={{
          display: "grid",
          gridTemplateColumns: "32px 1fr auto",
          alignItems: "center",
          gap: 10,
          flex: 1,
          minWidth: 0,
          background: "none",
          border: "none",
          padding: 0,
          font: "inherit",
          color: "inherit",
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <span className="swatch" style={{ background: TONE[row.kind] }}>
          {ABBR[row.kind]}
        </span>
        <span style={{ minWidth: 0 }}>
          <span className="name" style={{ display: "block" }}>
            {name || "New row"}
          </span>
          <span className="sub" style={{ display: "block" }}>
            {/* No symbol yet → unfilled, regardless of a Balance's default date. */}
            {hasTicker ? sub.join(" · ") || "Tap to fill in" : "Tap to fill in"}
            {needs ? (
              <span style={{ color: "var(--amber)" }}> · {needs}</span>
            ) : costUnknown ? (
              <span style={{ color: "var(--amber)" }}> · no cost yet</span>
            ) : null}
          </span>
        </span>
        <span className="value">{amt}</span>
      </button>
      <button
        type="button"
        className="icon-btn quiet"
        onClick={onRemove}
        aria-label="Remove row"
        style={{ alignSelf: "center", flexShrink: 0 }}
      >
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}

// Expanded editor — the native `.rec-edit` grid; Type spans anchor + trades.
function RowEditor({
  row,
  tickers,
  cashAccounts,
  purposeOptions,
  bucketLedger,
  onChange,
  onDone,
  onRemove,
}: {
  row: Row;
  tickers: TickerSuggestion[];
  cashAccounts: string[];
  purposeOptions: string[];
  /** The bucket's ledger (fetched while a Set balance is edited) — feeds the
   * sale-proceeds "no money moved" default (#232). */
  bucketLedger?: LedgerTxn[];
  onChange: (p: Partial<Row>) => void;
  onDone: () => void;
  onRemove: () => void;
}) {
  const anchor = isAnchor(row.kind);
  // Cash events (deposit / withdraw / cash_balance) — entered against a named cash
  // account in its currency (THB by default), no fund symbol or NAV.
  const isCash = isCashKind(row.kind);
  const cashBalance = row.kind === "cash_balance";
  // Dividend / fee are pure ฿ flows — no units or price, just an amount.
  const amountOnly = row.kind === "dividend" || row.kind === "fee";
  // The consequence line (#232) — the SAME arithmetic the fold runs at save: a raise
  // absorbs live in-transit sale proceeds first (an internal transfer), only the
  // remainder is new money; a drop is money out. Pure narration, no control — there
  // is nothing to set, so nothing to set wrong. A FIRST balance narrates nothing: its
  // full amount counting as capital is correct and needs no alarm-shaped "+฿500,000".
  const assertedThb = (() => {
    const currency = (row.currency || "THB").trim().toUpperCase() || "THB";
    const rate = currency === "THB" ? 1 : Number(row.fxToThb) > 0 ? Number(row.fxToThb) : 1;
    const native = Number(row.value || row.amount);
    return native > 0 ? native * rate : 0;
  })();
  const preview = useMemo(() => {
    if (!cashBalance || !bucketLedger || !row.ticker.trim() || !row.tradeDate || !(assertedThb > 0))
      return null;
    return previewBalanceChange(bucketLedger, {
      ticker: row.ticker,
      tradeDate: row.tradeDate,
      assertedThb,
    });
  }, [cashBalance, bucketLedger, row.ticker, row.tradeDate, assertedThb]);
  const classifyHint = (() => {
    if (!preview || preview.first) return null;
    const { delta, absorbed } = preview;
    if (Math.abs(delta) < 0.005) return null;
    if (delta < 0) {
      return `Records ${fmtTHBClean(-delta)} out on ${fmtDate(row.tradeDate)} — counted as money you took out.`;
    }
    const added = delta - absorbed;
    if (absorbed > 0.005 && added > 0.005) {
      return `${fmtTHBClean(absorbed)} of this is your recent fund sale landing; ${fmtTHBClean(added)} is counted as money you added.`;
    }
    if (absorbed > 0.005) {
      return "This is your recent fund sale landing in the account — not counted as new money.";
    }
    return `Records ${fmtTHBClean(delta)} in on ${fmtDate(row.tradeDate)} — counted as money you added.`;
  })();
  // A Balance recorded by its ฿ value (not a unit count): avg cost is optional here
  // — units (and any cost) are derived from the value, so the cost field steps back.
  const anchorValueDriven = anchor && Number(row.value) > 0;
  // A symbol priced by a live feed (a catalog fund, or a market ETF) makes its
  // price / current-price OPTIONAL — we can value it without one. A custom asset or a
  // not-yet-typed symbol shows NO cue (just "Price"), like the other required fields:
  // we only ever flag "optional", never "needed".
  const pricedByFeed = row.ticker.trim().length > 0 && (row.quoteSource ?? "manual") !== "manual";
  // A TRADE's Price is optional ONLY for a feed-priced fund — the NAV bridges units ⇄
  // amount, so whichever side you give (units or the ฿ amount), the other (and the
  // price) is found. A CUSTOM asset has no NAV, so the price is the only bridge between
  // its units and its cash — never optional there (without it, an amount becomes 0 units).
  const tradePriceOptional =
    !anchor && pricedByFeed && (Number(row.amount) > 0 || Number(row.units) > 0);

  // Best-effort native money on the row, for the "≈ ฿X" rate preview: a Balance's
  // value, a units×price cost, a cash/flow amount, else the invested total.
  const nativeMoney = cashBalance
    ? Number(row.value)
    : isCash || amountOnly
      ? Number(row.amount)
      : Number(row.value) > 0
        ? Number(row.value)
        : Number(row.units) > 0 && Number(row.price) > 0
          ? Number(row.units) * Number(row.price)
          : Number(row.amount) > 0
            ? Number(row.amount)
            : Number(row.costTotal);

  // Currency + trade-date FX, shared via useFxEntry. Currency shows as a $/฿
  // prefix on the money box: a security's is DERIVED from its price source (read-only —
  // change it by flipping the source), cash's is an interactive ฿⇄$ pill. A non-THB row
  // gets one FX line under its first money field.
  const { currency, prefix, fxHint } = useFxEntry(row, onChange, nativeMoney);
  const cycleCurrency = () =>
    onChange({ currency: currency === "THB" ? "USD" : "THB", fxManual: false });
  // Currency is read-only when the source decides it (a Thai fund is ฿, a US Stock/ETF is
  // $); a CUSTOM (manual-priced) asset has nothing to derive from, so the user picks it —
  // an interactive ฿⇄$ pill on the primary money field, default ฿.
  const secCurrencyEditable = row.quoteSource === "manual";
  const primaryCycle = secCurrencyEditable ? cycleCurrency : undefined;

  // A Set balance carries 6 fields (Type·Date·Account·Total·Purpose·Label) → reuse the
  // 6-column investment grid (one line on desktop). Deposit/withdraw + dividend/fee have
  // 4, so they keep the wider `is-flow` grid.
  const cls = `rec-edit${anchor ? " is-anchor" : amountOnly || (isCash && !cashBalance) ? " is-flow" : ""}`;
  return (
    <div className="ledger-edit-card">
      <div className={cls}>
        <label className="rec-field">
          <span className="rec-label">Type</span>
          <select
            value={row.kind}
            onChange={(e) => {
              const k = e.target.value as RowKind;
              // Switching INTO a cash kind: pin the source to "cash", default the
              // date, and keep whatever ฿ figure was typed (cash_balance reads it as
              // `value`, deposit/withdraw as `amount`).
              if (isCashKind(k)) {
                onChange({
                  kind: k,
                  quoteSource: "cash",
                  quoteSourceLocked: true,
                  ...(k === "cash_balance"
                    ? { value: row.value ?? row.amount, amount: "" }
                    : { amount: row.amount || (row.value ?? "") }),
                  ...(!row.tradeDate ? { tradeDate: today() } : {}),
                });
                return;
              }
              // The ฿ total lives in `value` on a Balance, `amount` on a trade —
              // carry it across when the type flips so a figure typed in ฿ mode
              // survives the switch (and clear the field it left). Leaving cash also
              // releases the pinned source so the symbol re-infers.
              const toAnchor = isAnchor(k);
              const ledgerMove =
                toAnchor === anchor
                  ? {}
                  : toAnchor
                    ? { value: row.amount, amount: "" }
                    : { amount: row.value ?? "", value: "" };
              onChange({
                kind: k,
                ...ledgerMove,
                ...(isCash ? { quoteSource: undefined, quoteSourceLocked: false } : {}),
                // Switching to a Balance with no date yet defaults it to today.
                ...(toAnchor && !row.tradeDate ? { tradeDate: today() } : {}),
              });
            }}
            aria-label="Type"
          >
            {typeSelectOptions(row.kind).map((o) => (
              <option key={o.label} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="rec-field">
          <span className="rec-label">{anchor || cashBalance ? "As-of date" : "Date"}</span>
          <input
            type="date"
            value={row.tradeDate}
            onChange={(e) => onChange({ tradeDate: e.target.value })}
            aria-label={anchor || cashBalance ? "As-of date" : "Trade date"}
          />
        </label>
        {isCash ? (
          <label className="rec-field">
            <span className="rec-label">Account</span>
            <Combobox<string>
              value={row.ticker}
              onChange={(text) => onChange({ ticker: text, englishName: undefined })}
              onPick={(s) => onChange({ ticker: s, englishName: undefined })}
              items={cashAccounts}
              getKey={(s) => s}
              renderItem={(s) => s}
              label="Cash account"
              placeholder="e.g. Savings"
            />
          </label>
        ) : (
          <div className="rec-field">
            <span className="rec-label">Symbol</span>
            <SymbolCombobox
              value={row.ticker}
              quoteSource={row.quoteSource}
              sourceLocked={row.quoteSourceLocked}
              pool={tickers}
              onChange={(text) =>
                onChange({
                  ticker: text,
                  englishName: undefined,
                  // Editing the symbol re-infers the source unless the user pinned it.
                  ...(row.quoteSourceLocked ? {} : { quoteSource: undefined }),
                })
              }
              onPick={(s) =>
                onChange({
                  ticker: s.ticker,
                  englishName: s.name,
                  quoteSource: s.quoteSource,
                  quoteSourceLocked: false,
                })
              }
              onToggleSource={() => {
                // Cycle Thai fund → Stock/ETF → Custom (manual price).
                const qs = row.quoteSource ?? "manual";
                const next: QuoteSource =
                  qs === "thai_mutual_fund"
                    ? "market"
                    : qs === "market"
                      ? "manual"
                      : "thai_mutual_fund";
                onChange({ quoteSource: next, quoteSourceLocked: true });
              }}
            />
          </div>
        )}
        {isCash ? (
          <>
            <label className="rec-field">
              <span className="rec-label">{cashBalance ? "Total" : "Amount"}</span>
              {/* Cash picks its currency — the ฿⇄$ pill is interactive; resetting the
                  manual flag re-fetches the new currency's trade-date rate. */}
              <MoneyInput
                echo={prefix(cycleCurrency)}
                value={cashBalance ? (row.value ?? "") : row.amount}
                onChange={(e) =>
                  onChange(cashBalance ? { value: e.target.value } : { amount: e.target.value })
                }
                placeholder={cashBalance ? "e.g. 100,000" : "e.g. 5,000"}
                inputMode="decimal"
                aria-label={cashBalance ? "Cash balance" : "Cash amount"}
              />
              {fxHint}
            </label>
            {cashBalance ? (
              <>
                <label className="rec-field">
                  <span className="rec-label">Purpose</span>
                  <select
                    value={row.cashRole ?? "investable"}
                    onChange={(e) =>
                      onChange({ cashRole: e.target.value as "investable" | "reserved" })
                    }
                    aria-label="Cash purpose"
                  >
                    <option value="investable">Investable</option>
                    <option value="reserved">Reserved</option>
                  </select>
                </label>
                <label className="rec-field">
                  <span className="rec-label">Label</span>
                  <Combobox<string>
                    value={row.cashLabel ?? ""}
                    onChange={(text) => onChange({ cashLabel: text })}
                    onPick={(s) => onChange({ cashLabel: s })}
                    items={purposeOptions}
                    getKey={(s) => s}
                    renderItem={(s) => s}
                    label="Cash purpose label"
                    placeholder="e.g. Emergency"
                  />
                </label>
              </>
            ) : null}
          </>
        ) : amountOnly ? (
          <label className="rec-field">
            <span className="rec-label">Amount</span>
            <MoneyInput
              echo={prefix(primaryCycle)}
              value={row.amount}
              onChange={(e) => onChange({ amount: e.target.value })}
              placeholder="Amount"
              inputMode="decimal"
              aria-label={`Amount in ${currency}`}
            />
            {fxHint}
          </label>
        ) : (
          <>
            <div className="rec-field">
              <span className="rec-label">{anchor ? "Units or total" : "Units or amount"}</span>
              <QtyInput
                units={row.units}
                // A Balance persists its ฿ figure in `value`; a trade in its `amount`
                // (its authoritative money field) — so a total typed in ฿ mode survives
                // collapse/expand and the server can derive units from it (#130). Reopen
                // in the mode the stored fact implies, via the SAME helper History uses.
                value={anchor ? row.value : row.amount}
                defaultMode={qtyDefaultMode(row.units)}
                // The currency rides as a left-edge $/฿ prefix on the ฿ total —
                // read-only when the source decides it, an interactive pill for a custom asset.
                leading={prefix(primaryCycle)}
                onUnits={(v) => onChange({ units: v })}
                onValue={(v) => onChange(anchor ? { value: v } : { amount: v })}
              />
              {fxHint}
            </div>
            <label className="rec-field">
              <span className="rec-label">
                {anchor ? "Avg cost" : "Price"}
                {/* Trade Price is optional once the ฿ amount is in (units derive from it).
                    Avg cost on a Balance is never "optional" — encouraged via the nudge. */}
                {tradePriceOptional && <span className="rec-opt"> · optional</span>}
              </span>
              {/* Every money field echoes the currency ($/฿); the estimate/optional border
                  cues move to the `.amt-field` wrapper (see globals.css), so the prefix
                  doesn't fight them. */}
              <MoneyInput
                echo={prefix()}
                value={row.price}
                onChange={(e) => onChange({ price: e.target.value, estimated: false })}
                placeholder={tradePriceOptional ? "Optional" : anchor ? "What you paid" : "Price"}
                inputMode="decimal"
                aria-label={anchor ? "Average cost" : "Price"}
                // Avg cost is NOT marked "optional": skippable, but adding it unlocks
                // gains/return — so it reads as a normal field, and the row nudges
                // (amber "no cost yet") when it's blank. A pre-filled figure DERIVED from
                // the ฿ value is an estimate to verify (amber dashed, data-estimated).
                data-optional={tradePriceOptional ? "" : undefined}
                data-estimated={anchor && anchorValueDriven && row.estimated ? "" : undefined}
                title={
                  anchor
                    ? "Average cost you PAID per unit — optional; left blank, your gains stay blank until you add it. Not today's price (current value comes from the live NAV)."
                    : undefined
                }
              />
            </label>
            {anchor ? (
              <label className="rec-field">
                <span className="rec-label">
                  Current price
                  {pricedByFeed && <span className="rec-opt"> · optional</span>}
                </span>
                <MoneyInput
                  echo={prefix()}
                  value={row.currentPrice ?? ""}
                  onChange={(e) => onChange({ currentPrice: e.target.value })}
                  // Optional ONLY for a feed-priced symbol (live NAV); for a custom asset
                  // it's required, but we don't mark required — just "Price", like the
                  // other required fields. Placeholder mirrors the label.
                  placeholder={pricedByFeed ? "Optional" : "Price"}
                  inputMode="decimal"
                  aria-label="Current price"
                  data-optional={pricedByFeed ? "" : undefined}
                  title={
                    pricedByFeed
                      ? "Today's price per unit — optional for a known fund (we use the live NAV)."
                      : "Today's price per unit. For a custom asset with no live feed, set this to value the holding."
                  }
                />
              </label>
            ) : (
              <label className="rec-field">
                <span className="rec-label">
                  Fee<span className="rec-opt"> · optional</span>
                </span>
                <MoneyInput
                  echo={prefix()}
                  value={row.fee}
                  onChange={(e) => onChange({ fee: e.target.value })}
                  placeholder="Optional"
                  inputMode="decimal"
                  aria-label="Fee"
                  data-optional=""
                />
              </label>
            )}
          </>
        )}
      </div>
      {/* Purpose (Role + Label) now lives in the main `.rec-edit` grid above — single row
          on desktop, wraps on narrow — instead of a separate block here. */}
      {classifyHint ? (
        <p className="rec-hint" aria-live="polite">
          {classifyHint}
        </p>
      ) : null}
      <div className="ledger-edit-actions">
        <span className="rec-type-help">
          <Icon name="info" size={12} />
          {TXN_KIND_HELP[row.kind]}
        </span>
        <button
          type="button"
          className="btn link sm"
          onClick={onRemove}
          style={{ color: "var(--loss)" }}
        >
          Remove
        </button>
        <button type="button" className="btn primary sm" onClick={onDone}>
          Done <Icon name="check" size={12} />
        </button>
      </div>
    </div>
  );
}
