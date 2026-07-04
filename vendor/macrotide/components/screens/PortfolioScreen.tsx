"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BrandMark } from "@/components/BrandMark";
import { ModelDonut } from "@/components/charts";
import { DetailSheetHost } from "@/components/DetailSheetHost";
import { type HoldingFormValues, HoldingSheet } from "@/components/HoldingSheet";
import { RecentActivityPeek } from "@/components/history/RecentActivityPeek";
import { Icon } from "@/components/Icon";
import {
  AllocationDonut,
  BreakdownChart,
  DriftBars,
  NavChart,
} from "@/components/InteractiveChartsLazy";
import { Modal } from "@/components/Modal";
import { PrivateAmount } from "@/components/PrivateAmount";
import { BenchmarkPicker } from "@/components/portfolio/BenchmarkPicker";
import { ReturnsBreakdownSheet } from "@/components/ReturnsBreakdownSheet";
import { SyncedIcon } from "@/components/SyncedBadge";
import { KebabMenu } from "@/components/ui/KebabMenu";
import { MiniTag } from "@/components/ui/MiniTag";
import { Skeleton, SkeletonRows } from "@/components/ui/Skeleton";
import {
  useModelPortfoliosView,
  usePortfolioView,
  useSelectedModelId,
} from "@/lib/fetchers/legacy";
import {
  type FeeCreepFinding,
  type HiddenActionItem,
  mutateActionItemState,
  restoreActionItem,
  type SeriesRange,
  useBenchmarkSeries,
  useEarmarks,
  useFeeCreep,
  useHiddenActionItems,
  useLookThrough,
} from "@/lib/fetchers/portfolio";
import { invalidate } from "@/lib/fetchers/swr";
import { fmtPct } from "@/lib/format";
import { BENCHMARK_TR_OPTIONS } from "@/lib/market/benchmark-options";
import { DEFAULT_QUOTE_SOURCE, isQuoteSource } from "@/lib/market/sources";
import { DetailStackProvider, useDetailStack } from "@/lib/nav/detail-stack";
import { feeCreepKey } from "@/lib/portfolio/action-item-key";
import { REASON_CHIPS, type ReasonChip } from "@/lib/portfolio/action-item-resurface";
import { formatTooltipDate, NAV_CHART_HEIGHT, seriesReturnPct } from "@/lib/portfolio/adapter";
import {
  applyCashMode,
  type CashMode,
  returnValue as cashReturnValue,
  uninvestedCash,
} from "@/lib/portfolio/cash-mode";
import { canLogScale } from "@/lib/portfolio/chart-scale";
import { buildNamedChecks, type NamedCheck } from "@/lib/portfolio/checks";
import {
  feeCheckInlineIntro,
  feeChecksButtonLabel,
  feeSwitchPrompt,
  orderFeeChecks,
  presentFeeChecks,
} from "@/lib/portfolio/fee-creep-presentation";
import { computeHealth, rebalanceHint, summarizeHealth } from "@/lib/portfolio/health";
import {
  holdingCategoryLabel,
  holdingGeography,
  holdingKind,
} from "@/lib/portfolio/holding-taxonomy";
import { performanceDisclaimer } from "@/lib/portfolio/performance-disclaimer";
import { heroReturn } from "@/lib/portfolio/returns-breakdown";
import { holdingColor } from "@/lib/portfolio/risk-palette";
import { periodTwr, twrSeries } from "@/lib/portfolio/twr";
import type { AssetClass, Holding, Portfolio } from "@/lib/static/types";
import { usePortfolioUi } from "@/lib/stores/portfolio-ui";
import { usePrivacy } from "@/lib/stores/privacy";
import { onActivate } from "@/lib/ui-events";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import { usePopoverPlacement } from "@/lib/usePopoverPlacement";

function holdingToFormValues(h: Holding, fallbackBucketId: string): HoldingFormValues {
  return {
    bucketId: h.bucketId ?? fallbackBucketId,
    ticker: h.ticker,
    thaiName: h.thai ?? "",
    englishName: h.name,
    category: h.category,
    assetClass: h.class,
    region: h.region,
    units: h.units,
    avgCost: h.units > 0 ? h.cost / h.units : 0,
    // The edit form represents an unknown fee as 0 (the field starts blank).
    ter: h.ter ?? 0,
    source: h.source,
    quoteSource: isQuoteSource(h.quoteSource) ? h.quoteSource : DEFAULT_QUOTE_SOURCE,
  };
}

const SWATCH_ABBR: Record<string, string> = {
  "SCBS&P500": "S&P",
  "K-USA-A(A)": "USA",
  "K-WORLDX": "WLD",
  "K-FIXED-A": "FIX",
  "KFGBRAND-A": "KFG",
  "KFGTECH-A": "TEC",
  "KFCASH-A": "$",
  "K-INDIA-A(A)": "IND",
  ABSM: "ABS",
  "K-USARMF": "USR",
  "K-WORLDXRMF": "WLR",
  "K-GINCOMERMF": "INC",
};

function swatchAbbr(t: string) {
  return SWATCH_ABBR[t] || t.slice(0, 3);
}

// Color for a holding-row's inline TER token. Unlike the fund-detail badge (which
// greens the cheap band), a cheap fee stays muted here so it blends into the sub
// line — only an elevated fee draws the eye: amber 0.5–1.5%, red > 1.5%.
function terRowColor(ter: number): string {
  if (ter <= 0.5) return "var(--muted)";
  return ter <= 1.5 ? "var(--amber, #d89a1f)" : "var(--loss)";
}

// Human labels for the "Not for me" reason chips (keys from REASON_CHIPS).
const REASON_CHIP_LABELS: Record<ReasonChip, string> = {
  too_small: "Too small to matter",
  tax_switching: "Tax & switching cost",
  prefer_this_fund: "I prefer this fund",
  already_considered: "Already considered",
};

// One fee check on the See-details page: the held fund + its TER, the cheaper
// comparable alternatives and the annual saving, then the two honest #74
// controls inline — Archive ("I've seen this; file it") and "Not for me"
// (reject, with the four reason chips + an optional "Other…" free text). This is
// where the user acts; the Portfolio tab's inline section is info-only. Wires to
// the existing archive/reject handlers (unchanged backend); the parent drops the
// card optimistically on either action.
function FeeCheckPageCard({
  finding,
  onArchive,
  onReject,
}: {
  finding: FeeCreepFinding;
  onArchive: (finding: FeeCreepFinding) => void;
  onReject: (finding: FeeCreepFinding, reason: ReasonChip | string | null) => void;
}) {
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reasonText, setReasonText] = useState("");

  return (
    <div
      className="card"
      style={{
        borderColor: "var(--amber)",
        background: "var(--amber-soft, color-mix(in srgb, var(--amber) 8%, transparent))",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 8,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.01em" }}>
            {finding.heldTicker}
          </span>
          <div style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 2 }}>
            {finding.heldName}
          </div>
        </div>
        <span
          className="num"
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--amber)",
            whiteSpace: "nowrap",
          }}
        >
          {finding.heldTer.toFixed(2)}% TER
        </span>
      </div>

      {/* The fee comparison — held fund vs cheaper alternatives. */}
      <div>
        <div
          style={{
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: "var(--muted)",
            letterSpacing: "0.04em",
            marginBottom: 6,
          }}
        >
          CHEAPER COMPARABLE EXPOSURE
        </div>
        {finding.alternatives.map((alt, i) => (
          <div
            key={alt.projId}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 8,
              padding: "5px 0",
              borderBottom:
                i < finding.alternatives.length - 1 ? "1px solid var(--line-soft)" : undefined,
            }}
          >
            <span style={{ fontSize: 12.5, color: "var(--ink-soft)", minWidth: 0 }}>
              {alt.abbrName}
              {alt.englishName ? (
                <span style={{ color: "var(--muted)", marginLeft: 4 }}>· {alt.englishName}</span>
              ) : null}
            </span>
            <span
              className="num"
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: "var(--gain)",
                whiteSpace: "nowrap",
              }}
            >
              {alt.ter.toFixed(2)}%
            </span>
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>Potential annual saving:</span>
          <span className="num" style={{ fontSize: 13, fontWeight: 600, color: "var(--gain)" }}>
            −{finding.savingsPp.toFixed(2)}pp/yr
          </span>
        </div>
      </div>

      {/* The two honest actions. Intrinsic width (no flex:1). */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          paddingTop: 4,
        }}
      >
        <button
          type="button"
          className="btn ghost sm"
          style={{ gap: 4 }}
          onClick={() => onArchive(finding)}
          aria-label={`Archive the fee check for ${finding.heldTicker}`}
          title="File this. It returns only if the saving grows materially."
        >
          <Icon name="archive" size={12} /> Archive
        </button>
        <button
          type="button"
          className="btn ghost sm"
          style={{ gap: 4 }}
          onClick={() => setReasonOpen((v) => !v)}
          aria-expanded={reasonOpen}
          aria-label={`Reject the fee check for ${finding.heldTicker}`}
          title="This advice isn't right for me. Optionally tell us why."
        >
          <Icon name="thumbs-down" size={12} /> Not for me
        </button>
      </div>

      {reasonOpen && (
        <div>
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 8 }}>
            Why isn&apos;t this right for you? (optional)
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
            {REASON_CHIPS.map((chip) => (
              <button
                key={chip}
                type="button"
                className="btn ghost sm"
                onClick={() => onReject(finding, chip)}
              >
                {REASON_CHIP_LABELS[chip]}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              placeholder="Other… (optional)"
              aria-label="Other reason"
              style={{
                flex: 1,
                fontSize: 12,
                padding: "6px 9px",
                borderRadius: 6,
                border: "1px solid var(--line)",
                background: "var(--bg)",
                color: "var(--ink)",
              }}
            />
            <button
              type="button"
              className="btn sm"
              onClick={() => onReject(finding, reasonText.trim() || null)}
            >
              Confirm
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// The "See details" page — a full-height detail Modal that reads as a dedicated
// sub-view of Portfolio (not a new tab/route). It houses ALL the fee-check
// management UI moved off the Portfolio tab: a calm summary line, the fee checks
// in severity order each WITH the per-item Archive / "Not for me" controls, and a
// "Hidden checks (N)" list to restore anything filed or rejected. The Modal owns
// its own focus trap, Escape/close, and scroll region, so the Portfolio tab's
// per-screen scroll memory is untouched while it is open.
function FeeChecksPage({
  open,
  onClose,
  findings,
  hidden,
  onArchive,
  onReject,
  onRestore,
}: {
  open: boolean;
  onClose: () => void;
  findings: FeeCreepFinding[];
  hidden: HiddenActionItem[];
  onArchive: (finding: FeeCreepFinding) => void;
  onReject: (finding: FeeCreepFinding, reason: ReasonChip | string | null) => void;
  onRestore: (itemKey: string) => void;
}) {
  const view = useMemo(() => presentFeeChecks(findings), [findings]);
  const ordered = useMemo(() => [...view.top, ...view.rest], [view]);

  return (
    <Modal open={open} onClose={onClose} variant="detail" labelledBy="fee-checks-page-title">
      <Modal.Header
        title="Fee check"
        id="fee-checks-page-title"
        subtitle="Comparable exposure, lower cost"
      />
      <Modal.Body gap={14}>
        {ordered.length > 0 ? (
          <>
            {/* Calm, no-deadline summary line. */}
            <div style={{ fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.5 }}>
              {view.summary}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {ordered.map((f) => (
                <FeeCheckPageCard
                  key={f.heldTicker}
                  finding={f}
                  onArchive={onArchive}
                  onReject={onReject}
                />
              ))}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
            No active fee checks. Anything you filed or rejected is listed below.
          </div>
        )}

        {/* Hidden checks (N) — the single restore path for filed / rejected items. */}
        {hidden.length > 0 && (
          <div>
            <div
              style={{
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                color: "var(--muted)",
                letterSpacing: "0.04em",
                marginTop: 4,
                marginBottom: 8,
              }}
            >
              HIDDEN CHECKS ({hidden.length})
            </div>
            <div className="card" style={{ padding: "6px 12px" }}>
              {hidden.map((h) => {
                const ticker = h.itemKey.replace(/^fee_creep:/, "");
                const label = h.state === "not_for_me" ? "Not for me" : "Archived";
                const reasonLabel =
                  h.reason && h.reason in REASON_CHIP_LABELS
                    ? REASON_CHIP_LABELS[h.reason as ReasonChip]
                    : h.reason;
                return (
                  <div
                    key={h.itemKey}
                    className="row between"
                    style={{ padding: "6px 0", gap: 8, alignItems: "center" }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 500 }}>{ticker}</div>
                      <div style={{ fontSize: 11, color: "var(--muted)" }}>
                        {label}
                        {reasonLabel ? ` · ${reasonLabel}` : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => onRestore(h.itemKey)}
                      aria-label={`Restore the fee check for ${ticker}`}
                    >
                      Restore
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.45 }}>
          Comparable exposure means same asset class. Lower fee, not necessarily better fund. Tax
          implications and switching costs apply.
        </div>
      </Modal.Body>
    </Modal>
  );
}

// The status pill for a named check. "none" is a not-yet-set-up state (e.g.
// drift with no target) — a neutral CTA, never a failing grade.
const CHECK_PILL: Record<NamedCheck["status"], { label: string; color: string }> = {
  good: { label: "On track", color: "var(--gain)" },
  watch: { label: "Watch", color: "var(--amber)" },
  action: { label: "Act", color: "var(--loss)" },
  none: { label: "Set up", color: "var(--muted)" },
};

// One named-check row: the certain VALUE up front, a status pill, and the reason
// (where the look-through story lives, always hedged). Replaces the 0-100 grade.
function NamedCheckRow({ check, last }: { check: NamedCheck; last: boolean }) {
  const pill = CHECK_PILL[check.status];
  return (
    <div
      style={{ padding: "9px 0", borderBottom: last ? undefined : "1px solid var(--line-soft)" }}
    >
      <div className="row between" style={{ gap: 8, alignItems: "baseline", marginBottom: 3 }}>
        <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em" }}>
          {check.label}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 12, color: "var(--ink-soft)", whiteSpace: "nowrap" }}>
            {check.value}
          </span>
          {/* Fixed-width, centred pill. One width across all statuses (sized to
              the longest, "On track") gives the values a clean right-aligned
              column and the pills a tidy column — they no longer ragged-edge. */}
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.02em",
              textTransform: "uppercase",
              color: pill.color,
              border: `1px solid ${pill.color}`,
              borderRadius: 4,
              padding: "1px 4px",
              // Fixed (not min) width so every badge is the SAME length, sized to
              // the longest label ("On track"). Shorter labels centre within it.
              width: 60,
              boxSizing: "border-box",
              textAlign: "center",
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            {pill.label}
          </span>
        </span>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.45 }}>{check.reason}</div>
    </div>
  );
}

interface ViewPortfolio {
  name: string;
  notes: string | null;
  type: string;
  holdings: Holding[];
  series: { d: string; v: number }[];
  netInvested: { d: string; v: number }[];
  netInvestedForReturn: { d: string; v: number }[];
  cashDecomp?: Portfolio["cashDecomp"];
  totalValue: number;
  initialInvestment: number;
  perfPct: Portfolio["perfPct"];
  asOf: string;
}

// "+ Add" split button (#149): the main button opens the Add modal on Investment (the
// frequent case, one click); the caret offers "Cash" for the occasional bank-balance entry
// — keeping the common path fastest while making cash an explicit, discoverable choice.
// Reuses the shared `.kebab__menu` styling, but placed adaptively with
// `usePopoverPlacement` + a body portal (two-axis flip, floats above the side
// panel) — same as the `+ Compare` dropdown, not a fixed `right: 0` lock.
function AddSplitButton({
  onInvestment,
  onCash,
}: {
  onInvestment: () => void;
  onCash?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Anchor placement to the caret (the dropdown half of the split), so the menu
  // aligns with the split button — not the wider "Add" main button.
  const caretRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuStyle = usePopoverPlacement(caretRef, menuRef, { open });
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      // The menu is portaled to <body> (outside `ref`), so check it explicitly.
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div className="add-split kebab" ref={ref}>
      <button type="button" className="btn ghost sm add-split__main" onClick={onInvestment}>
        <Icon name="plus" size={12} /> Add
      </button>
      <button
        ref={caretRef}
        type="button"
        className="btn ghost sm add-split__caret"
        aria-label="More add options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="chevron-down" size={14} />
      </button>
      {open
        ? createPortal(
            // `right: auto` clears the class's `right: 0` so the fixed left/top from
            // usePopoverPlacement drive placement; portaled so it floats above the panel.
            <div
              ref={menuRef}
              className="kebab__menu"
              role="menu"
              style={{ ...menuStyle, right: "auto" }}
            >
              <button
                type="button"
                role="menuitem"
                className="kebab__item"
                onClick={() => {
                  setOpen(false);
                  onInvestment();
                }}
              >
                Investment
              </button>
              <button
                type="button"
                role="menuitem"
                className="kebab__item"
                onClick={() => {
                  setOpen(false);
                  onCash?.();
                }}
              >
                Cash
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

// Small filled triangle for the scorecard rows — points up for a gain, down for a
// loss, and inherits the row's gain/loss color via currentColor.
function TrendCaret({ up }: { up: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 10 10"
      aria-hidden="true"
      style={{ flex: "none", fill: "currentColor" }}
    >
      <path d={up ? "M5 1.5 9 8.5 1 8.5Z" : "M5 8.5 1 1.5 9 1.5Z"} />
    </svg>
  );
}

// Return-basis kebab (#149): the "Include cash / Exclude cash" lever in the shared
// kebab popover, so it lives ON the page (its effect is visible) instead of inside
// a modal. Only the non-default choice gets a check + the hero tag, keeping the
// default quiet. Reuses the same .kebab__menu pattern as the "+ Add" split button.
function CashModeKebab({
  mode,
  onChange,
  hasReserved,
  hintDismissed,
  onDismissHint,
}: {
  mode: CashMode;
  onChange: (m: CashMode) => void;
  hasReserved: boolean;
  hintDismissed: boolean;
  onDismissHint: () => void;
}) {
  // A state toggle on the word "Cash": plain = investable cash counts toward the
  // return (the default, neutral); struck through + green = cash excluded (active).
  // Strikethrough reads as "not counted" without the remove-button feel an ✕ would
  // borrow from the Compare pill. A one-time note (until dismissed) explains it.
  const active = mode === "funds";
  // The note appears the first time the user clicks Cash (not auto on load) and
  // stays until dismissed. `hinted` is this-session; `hintDismissed` is persisted.
  const [hinted, setHinted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const showHint = hinted && !hintDismissed;
  const hintStyle = usePopoverPlacement(triggerRef, hintRef, { open: showHint });
  return (
    <div className="kebab cash-mode-kebab">
      <button
        ref={triggerRef}
        type="button"
        className="chart-toolbtn"
        data-active={active || undefined}
        aria-pressed={active}
        aria-label="Exclude investable cash from the return"
        title={
          active
            ? "Cash excluded — investable cash sits out of your return; click to include it"
            : "Cash counted — click to exclude investable cash (a fairer read against an index)"
        }
        onClick={() => {
          onChange(active ? "incl" : "funds");
          if (!hintDismissed) setHinted(true);
        }}
      >
        Cash
      </button>
      {showHint
        ? createPortal(
            // Portaled to <body> so it floats above the right detail panel.
            <div ref={hintRef} className="cash-hint" role="note" style={hintStyle}>
              <p className="cash-hint__body">
                Investable cash counts toward your return by default. Exclude it to compare your
                investments against an index, without the cash drag.
                {hasReserved ? " Reserved cash always sits out." : ""}
              </p>
              <button type="button" className="btn ghost sm" onClick={onDismissHint}>
                Got it
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

// Plain-English definitions for the jargon surfaced as tappable terms in the chart
// caption (see TermTip + the caption line in PortfolioScreen).
const TERM_DEFS = {
  twr: "How your holdings performed, regardless of when you added or withdrew money. How much you personally made is the money-weighted figure in the returns breakdown.",
  scale:
    "Equal percentage moves are drawn the same height, so early years stay readable. Deposits still show as steps.",
  mix: "How your money splits between invested funds and cash over time. The shares move with the market and your trades, not just decisions you made.",
  invested:
    "The dotted line is your net contributions: money in minus money out. The shaded gap to your value is your gain, or a loss when value falls below it.",
};

// A jargon term in the chart caption: a dotted-underline word that opens its
// plain-English definition in place (the underline IS the affordance, so help is
// discoverable without a separate panel). Placement reuses usePopoverPlacement.
function TermTip({ label, def }: { label: string; def: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  const style = usePopoverPlacement(ref, popRef, { open });
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !popRef.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="term"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open
        ? createPortal(
            // Portaled to <body> so it floats above the right detail panel instead
            // of being trapped behind it by the scroll host's stacking context.
            <span ref={popRef} className="chart-info" role="note" style={style}>
              <span className="chart-info__note">{def}</span>
            </span>,
            document.body,
          )
        : null}
    </>
  );
}

export interface PortfolioScreenProps {
  onOpenSettings: () => void;
  onOpenModels: () => void;
  onOpenChat: () => void;
  onOpenImport: () => void;
  /** Open the Add modal straight into the Cash family (#149 split button). */
  onOpenCash?: () => void;
  /** Open the full Activity (transaction history) screen. */
  onOpenActivity?: () => void;
  /** Open a holding's own record (the per-position drill-in screen). */
  onOpenPosition?: (ticker: string) => void;
  /** Open the portfolios manager — the dock panel on wide, a full page on phone. */
  onOpenPortfolios?: () => void;
  /** Show the top-right kebab that opens the account menu (mobile only). */
  showMenu?: boolean;
}

// Wraps the screen in a DetailStackProvider so its detail overlays share one
// "modal as page" stack (host rendered inside). The body is PortfolioScreenInner.
export function PortfolioScreen(props: PortfolioScreenProps) {
  return (
    <DetailStackProvider>
      <PortfolioScreenInner {...props} />
    </DetailStackProvider>
  );
}

function PortfolioScreenInner({
  onOpenSettings,
  onOpenModels,
  onOpenImport,
  onOpenCash,
  onOpenActivity,
  onOpenPosition,
  onOpenPortfolios,
  showMenu = true,
}: PortfolioScreenProps) {
  // Active portfolio lives in the shared store so the right-rail PortfoliosPanel
  // stays in sync without a window-event handshake.
  const {
    activeId: activePfId,
    setActiveId,
    filter: filterRaw,
    setFilter,
    requestNew,
    requestEdit,
  } = usePortfolioUi();
  const filter = filterRaw as AssetClass | "all";
  const [benchmark, setBenchmark] = useState<string>("none");
  // Chart view state is PER-DEVICE (localStorage), not synced — the device usually
  // implies the use case (a phone glance vs a desktop deep-dive), so the chart
  // opens however you last left it on THIS device. Covers period, mode, scale, and
  // the cash basis. (For genuinely cross-device prefs we'd persist server-side.)
  const [range, setRange] = useLocalStorageState<string>("macrotide.period", "1Y");
  // Cash basis (#149): does idle investable cash drag the return ("incl", default)
  // or sit out ("funds")?
  const [cashMode, setCashMode] = useLocalStorageState<CashMode>("macrotide.cashMode", "incl");
  // Y-axis scale (linear/log) for the value chart — only offered on long ranges
  // (≥1Y), where a log axis earns its keep; on short windows log ≈ linear.
  const [yAxisScale, setYAxisScale] = useLocalStorageState<"linear" | "log">(
    "macrotide.yAxisScale",
    "linear",
  );
  // Chart mode — what the graph plots. "value" = absolute wealth (how much),
  // "performance" = a time-weighted return curve (how well), "breakdown" = what the
  // money is made of. The one control that changes what the line *is*.
  const [chartMode, setChartMode] = useLocalStorageState<"value" | "performance" | "breakdown">(
    "macrotide.chartMode",
    "value",
  );
  // One-time note for the Cash toggle — shown on first click, then never again on
  // this device.
  const [cashHintDismissed, setCashHintDismissed] = useLocalStorageState<boolean>(
    "macrotide.cashHintDismissed",
    false,
  );
  const dismissCashHint = () => setCashHintDismissed(true);
  // Breakdown mode: share-of-100% (default — strips deposit-driven height jumps)
  // vs absolute ฿. Ephemeral; the mode itself is what persists.
  const [breakdownNorm, setBreakdownNorm] = useState(true);
  const { hidden: valuesHidden, toggle: togglePrivacy } = usePrivacy();
  // Tapping a holding row opens a read-only detail view (detailHolding); the
  // per-row Edit affordance opens the edit form (holdingSheet). Reading a
  // holding no longer drops the user straight into an edit form.
  const [holdingSheet, setHoldingSheet] = useState<Holding | null>(null);
  // Detail overlays share one stack (modal-as-page): a US holding opens the US
  // sheet, whose cross-links push a Thai fund on top (Back returns to it); a Thai
  // holding opens the holding view. One host renders the top; ✕ closes all.
  const detailStack = useDetailStack();
  const openHoldingDetail = (h: Holding) => {
    detailStack.push(
      h.quoteSource === "market"
        ? { kind: "us", symbol: h.ticker }
        : { kind: "holding", holding: h },
    );
  };
  // Whether the "See details" page is open — the full-screen sub-view that
  // houses the fee-check list with per-item Archive / "Not for me" and the
  // Hidden-checks (N) restore list. The Portfolio tab's inline section is
  // info-only; all management lives on this page.
  const [feeDetailsOpen, setFeeDetailsOpen] = useState(false);
  // Whether the returns-breakdown sheet is open — decomposes the hero's total
  // return into cost basis / unrealized / realized / dividends / fees so the
  // headline and the chart pill stop reading as a contradiction (#152).
  const [breakdownOpen, setBreakdownOpen] = useState(false);

  // App owns the create/edit sheet; request it through the shared store.
  const openNewPortfolio = () => requestNew();
  const openEditPortfolio = (id: string) => requestEdit(id);

  async function saveHolding(values: HoldingFormValues) {
    const id = holdingSheet?.id;
    if (id === undefined) return;
    // Position (units/avgCost) is derived from the ledger and edited in History, not
    // here (ADR 0004) — the edit form is metadata-only, so we don't send it and never
    // write a snapshot that would override the transaction history.
    const payload = {
      bucketId: values.bucketId,
      ticker: values.ticker,
      thaiName: values.thaiName || null,
      englishName: values.englishName,
      category: values.category || null,
      assetClass: values.assetClass,
      region: values.region || null,
      ter: values.ter,
      source: values.source || null,
      quoteSource: values.quoteSource,
    };
    const res = await fetch(`/api/holdings/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Update failed (${res.status})`);
    invalidate(/^\/api\/holdings/);
  }

  async function deleteHolding(id: number) {
    const res = await fetch(`/api/holdings/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`Delete failed (${res.status})`);
    invalidate(/^\/api\/holdings/);
  }

  const seriesRange: SeriesRange = useMemo(() => {
    switch (range) {
      case "1M":
        return "1mo";
      case "3M":
        return "3mo";
      // YTD fetches a full year and is clipped to Jan 1 client-side, so it needs
      // no new server range (and avoids rippling "ytd" through every provider).
      case "YTD":
        return "1y";
      case "5Y":
        return "5y";
      case "All":
        return "max";
      default:
        return "1y";
    }
  }, [range]);

  const {
    portfolios,
    aggregate,
    hasDistributingHolding,
    estimatedThrough,
    cashSeries,
    historyStart,
    isLoading,
  } = usePortfolioView(seriesRange);
  // 5Y is offered only once the book is ~5y old; below that it just duplicates
  // "All", so it stays hidden until it would show something distinct.
  const hasFiveYears =
    historyStart != null && Date.now() - Date.parse(historyStart) >= 5 * 365.25 * 24 * 3600 * 1000;
  const { models } = useModelPortfoliosView();
  const { data: feeCreepData, mutate: mutateFeeCreep } = useFeeCreep();
  const { data: hiddenData } = useHiddenActionItems();
  const planSelectedModelId = useSelectedModelId();

  // Real benchmark overlay: fetch the selected index over the SAME range as the
  // chart, then map it onto the portfolio's date-label space so NavChart can
  // align + rebase it. Empty series (upstream cold / backing off) → no overlay.
  const { data: benchmarkResp } = useBenchmarkSeries(
    benchmark === "none" ? null : benchmark,
    seriesRange,
  );
  const benchmarkSeries = useMemo(
    () =>
      benchmarkResp && benchmarkResp.series.length > 0
        ? benchmarkResp.series.map((p) => ({ d: p.date, v: p.value }))
        : null,
    [benchmarkResp],
  );

  const activePf = useMemo<Portfolio | null>(() => {
    if (activePfId === "all" || !portfolios) return null;
    return portfolios.find((p) => p.id === activePfId) ?? null;
  }, [activePfId, portfolios]);

  const view: ViewPortfolio | null = useMemo(() => {
    if (!aggregate) return null;
    if (!activePf) {
      return {
        name: "All portfolios",
        notes: null,
        type: "free",
        holdings: aggregate.holdings,
        series: aggregate.series,
        netInvested: aggregate.netInvested ?? [],
        netInvestedForReturn: aggregate.netInvestedForReturn ?? aggregate.netInvested ?? [],
        cashDecomp: aggregate.cashDecomp,
        totalValue: aggregate.totalValue,
        initialInvestment: aggregate.initialInvestment,
        perfPct: aggregate.perfPct,
        asOf: aggregate.asOf,
      };
    }
    return {
      name: activePf.name,
      notes: activePf.notes,
      type: activePf.type,
      holdings: activePf.holdings,
      series: activePf.series,
      netInvested: activePf.netInvested ?? [],
      netInvestedForReturn: activePf.netInvestedForReturn ?? activePf.netInvested ?? [],
      cashDecomp: activePf.cashDecomp,
      totalValue: activePf.totalValue,
      initialInvestment: activePf.initialInvestment,
      perfPct: activePf.perfPct,
      asOf: activePf.asOf,
    };
  }, [activePf, aggregate]);

  const filtered = useMemo(() => {
    if (!view) return [] as Holding[];
    const list = filter === "all" ? view.holdings : view.holdings.filter((h) => h.class === filter);
    // Sort by weight (current value, descending); ties / zero-value fall back to name (A–Z).
    return [...list].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  }, [view, filter]);

  // Cash earmarks (#149) → per-account designation (Investable | Reserved + label),
  // keyed by ticker for the holding-row tag.
  const { data: earmarks } = useEarmarks();
  const markByTicker = useMemo(() => {
    const m = new Map<string, { role: string; purpose: string | null }>();
    for (const e of earmarks ?? []) {
      if (e.ticker) m.set(e.ticker.toUpperCase(), { role: e.role, purpose: e.purpose });
    }
    return m;
  }, [earmarks]);

  const byClass = useMemo(() => {
    if (!view || view.totalValue <= 0) {
      return { equity: 0, bond: 0, mixed: 0, alternative: 0, cash: 0, unknown: 0 };
    }
    const groups: Record<string, number> = {};
    view.holdings.forEach((h) => {
      groups[h.class] = (groups[h.class] || 0) + h.value;
    });
    const total = view.totalValue;
    return {
      equity: ((groups.equity || 0) / total) * 100,
      bond: ((groups.bond || 0) / total) * 100,
      mixed: ((groups.mixed || 0) / total) * 100,
      alternative: ((groups.alternative || 0) / total) * 100,
      cash: ((groups.cash || 0) / total) * 100,
      unknown: ((groups.unknown || 0) / total) * 100,
    };
  }, [view]);

  // Target model for plan/health drift — resolve before the early returns so
  // the health memo below can depend on it (hooks must run unconditionally).
  const targetModel = useMemo(() => {
    if (!models) return null;
    if (activePf?.targetModelId) return models.find((m) => m.id === activePf.targetModelId) ?? null;
    return models.find((m) => m.id === planSelectedModelId) ?? null;
  }, [models, activePf, planSelectedModelId]);

  // Fee-creep findings scoped to the active view's holdings.
  const feeCreepFindings = useMemo<FeeCreepFinding[]>(() => {
    if (!feeCreepData || !view) return [];
    const activeTickers = new Set(view.holdings.map((h) => h.ticker));
    return feeCreepData.filter((f) => activeTickers.has(f.heldTicker));
  }, [feeCreepData, view]);

  // Inline fee-check view: the SAME severity ordering + top-N split the
  // See-details page uses (presentFeeChecks), so both agree on "most material".
  // The tab renders only the top cards; the full list lives on See details.
  const inlineFeeView = useMemo(() => presentFeeChecks(feeCreepFindings), [feeCreepFindings]);

  // Hidden (archived / rejected) fee-creep items — the "Hidden checks (N)" list.
  // Scoped to fee_creep so the surface stays about the section it sits under.
  const hiddenFeeChecks = useMemo<HiddenActionItem[]>(
    () => (hiddenData?.hidden ?? []).filter((h) => h.itemType === "fee_creep"),
    [hiddenData],
  );

  // Optimistically drop one or more fee-creep cards from the SWR cache so they
  // disappear at once, then record each server-side. Suppression is keyed by
  // fee_creep:{heldTicker} (identity only), so a choice survives NAV ticks but a
  // genuinely worse finding can resurface (lib/portfolio/action-item-resurface).
  const dropCards = (tickers: string[]) => {
    const drop = new Set(tickers);
    mutateFeeCreep((curr) => (curr ?? []).filter((f) => !drop.has(f.heldTicker)), {
      revalidate: false,
    });
  };

  // Archive ("I've seen this; file it") — the soft action; resurfaces on a
  // material jump in the saving. No reason, no feedback signal. Restore lives in
  // the "Hidden checks (N)" list, the single restore path. Triggered from the
  // See-details page; the page stays open so the user can file several in a row.
  const archiveFeeCreep = (finding: FeeCreepFinding) => {
    dropCards([finding.heldTicker]);
    void mutateActionItemState({
      itemType: "fee_creep",
      itemKey: feeCreepKey(finding.heldTicker),
      state: "archived",
      savingsPp: finding.savingsPp,
    });
  };

  // "Not for me" (reject) — optionally with a reason chip or free text. Writes a
  // Journal feedback entry server-side and is stickier than Archive.
  const rejectFeeCreep = (finding: FeeCreepFinding, reason: ReasonChip | string | null) => {
    dropCards([finding.heldTicker]);
    void mutateActionItemState({
      itemType: "fee_creep",
      itemKey: feeCreepKey(finding.heldTicker),
      state: "not_for_me",
      reason: reason || null,
      savingsPp: finding.savingsPp,
      topic: `Fee check — ${finding.heldTicker}`,
    });
  };

  // Section-level "Ask advisor" — one fee-focused Advisor prompt for the whole
  // section, scoped to the most material finding (biggest annual saving) and its
  // cheapest comparable alternative, via the shared ai-prompt CustomEvent. No-op
  // when there is no finding with an alternative to switch into.
  const askAdvisorAboutFees = () => {
    const top = orderFeeChecks(feeCreepFindings)[0];
    if (!top) return;
    const prompt = feeSwitchPrompt(top);
    if (!prompt) return;
    window.dispatchEvent(new CustomEvent("ai-prompt", { detail: prompt }));
  };

  // Restore a single hidden item from the Hidden-checks list — the single
  // restore path now that the post-archive Undo toast is gone.
  const restoreHidden = (itemKey: string) => {
    void restoreActionItem(itemKey).then(() => mutateFeeCreep());
  };

  // Underlying-exposure look-through for the active scope, fetched server-side
  // (needs market.db) and injected into the client health computation so the
  // diversification check reflects the real underlying concentration.
  const { data: lookThroughData } = useLookThrough(activePfId);

  // Real, computed health signals — drift vs target, blended fee, concentration
  // (incl. look-through), cash drag. No mock fixtures.
  const health = useMemo(
    () =>
      view
        ? computeHealth(
            view.holdings,
            view.totalValue,
            targetModel?.mix ?? null,
            targetModel?.ter ?? null,
            lookThroughData?.lookThrough ?? null,
          )
        : null,
    [view, targetModel, lookThroughData],
  );

  if (isLoading || !view || !portfolios) {
    return (
      <div className="screen">
        <div className="topbar">
          <div className="brand" style={{ flex: 1 }}>
            <BrandMark />
            <span>Macrotide</span>
          </div>
        </div>
        <div style={{ padding: "20px 16px" }} aria-hidden>
          <Skeleton width="42%" height={30} />
          <Skeleton width="26%" height={13} style={{ marginTop: 8 }} />
          <Skeleton height={NAV_CHART_HEIGHT} style={{ marginTop: 18 }} />
          <SkeletonRows rows={4} height={52} padding="18px 0 0" />
        </div>
      </div>
    );
  }

  if (portfolios.length === 0) {
    return (
      <div className="screen">
        <div className="topbar">
          <div className="brand" style={{ flex: 1 }}>
            <BrandMark />
            <span>Macrotide</span>
          </div>
          {showMenu && (
            <button className="icon-btn" aria-label="More" onClick={onOpenSettings}>
              <Icon name="ellipsis-vertical" size={13} />
            </button>
          )}
        </div>
        <div style={{ padding: "24px 20px" }}>
          <div className="card" style={{ padding: "36px 22px", textAlign: "center" }}>
            <div style={{ fontSize: 28, marginBottom: 10 }}>○</div>
            <div
              style={{
                fontSize: 17,
                fontWeight: 500,
                letterSpacing: "-0.02em",
                marginBottom: 8,
              }}
            >
              No portfolios yet
            </div>
            <div
              style={{
                fontSize: 13,
                color: "var(--muted)",
                lineHeight: 1.5,
                marginBottom: 22,
                maxWidth: 320,
                margin: "0 auto 22px",
              }}
            >
              A portfolio holds a set of holdings — funds, stocks, ETFs, or cash. Most people start
              with one "Core" portfolio for long-term holdings, plus optional ones for
              tax-advantaged accounts.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button className="btn primary" onClick={openNewPortfolio}>
                <Icon name="plus" size={13} /> Create your first portfolio
              </button>
              <button className="btn ghost" onClick={onOpenImport}>
                Import existing holdings
              </button>
              <button className="btn ghost" onClick={onOpenModels}>
                Browse templates
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Hero "all-time" = total return on the money actually contributed from outside
  // (value − net contributions), matching the chart's "All" pill. The older
  // cost-basis return understated lifetime return for switching-heavy books (each
  // switch banks realized gain into the new position's basis); that number now
  // lives in the returns breakdown, labeled "unrealized". One shared helper drives
  // both so they can't drift apart. Falls back to cost basis when there's no
  // ledger-derived contribution series (static placeholder).
  // Contribution-mode return view (#149): drop reserved cash always, and ALL cash
  // in "Funds only". The hero BALANCE (view.totalValue) stays full net worth; only
  // these return figures + the chart's value/contribution lines follow the mode.
  const retView = applyCashMode(cashMode, view.series, view.netInvested, view.cashDecomp);
  // YTD = a 1Y fetch clipped to Jan 1 of the current year, applied to every dated
  // series the chart consumes so the value line, the TWR curve, the pill, and the
  // benchmark all share the same window.
  const ytdFrom = range === "YTD" ? `${new Date().getUTCFullYear()}-01-01` : null;
  const clipYtd = <T extends { d: string }>(s: T[]): T[] =>
    ytdFrom ? s.filter((p) => p.d >= ytdFrom) : s;
  const retSeries = clipYtd(retView.series);
  const retNetInvested = clipYtd(retView.netInvested);
  // The TIME-WEIGHTED return uses the full-proceeds-at-walk-away contribution line
  // (so a realized gain leaving the book isn't read as a phantom loss). Same cash
  // slices removed; the value line + contribution line + hero P/L stay on
  // `retNetInvested` (cost-basis, money-weighted).
  const retNetInvestedForReturn = clipYtd(
    applyCashMode(cashMode, view.series, view.netInvestedForReturn, view.cashDecomp).netInvested,
  );
  const retTotalValue = cashReturnValue(cashMode, view.totalValue, view.cashDecomp);
  // Whether the pill is worth showing: there's HELD cash the mode could move
  // (in-transit settlement float isn't removed by either mode, so it doesn't count).
  const cashInPlay = (view.cashDecomp?.heldCashValue.at(-1)?.v ?? 0) > 0.5;
  const idleCash = uninvestedCash(view.cashDecomp);
  const hasReserved = (view.cashDecomp?.reservedCashValue.at(-1)?.v ?? 0) > 0.5;

  const netContributed = retNetInvested.at(-1)?.v ?? null;
  const { pnl, pnlPct } = heroReturn(retTotalValue, netContributed, view.initialInvestment);

  // Value mode plots ABSOLUTE wealth on every range (no window-start rebase): the
  // scale toggle (linear/log) must change only HOW the line is drawn, never what
  // it means, and an always-positive absolute series is what makes log valid.
  // "How did I do this window" is answered by the time-weighted pill below (and,
  // soon, the Performance mode) — not by rebasing the value line.
  //
  // Log scale (the `Log` toggle) is offered on every range — even short ones, where a volatile
  // (crypto/stock) book can still span a wide enough ratio for it to matter. The
  // chart gaps fully-out-of-market ฿0 dates (a log axis can't place a 0), so it
  // stays valid; it falls back to linear only if nothing positive is plotted.
  const effectiveScale: "linear" | "log" = yAxisScale;

  // Performance mode: a running time-weighted return curve as a growth factor
  // (starts at 1, always positive). The endpoint equals the period pill; the
  // chart renders it as a % via the formatter below. Deposits don't move it.
  const perfSeries = twrSeries(retSeries, retNetInvestedForReturn);

  // Breakdown mode: funds vs cash over time. Uses the FULL net-worth series and
  // the cash decomposition (not the return-adjusted retSeries) so it shows the
  // real composition regardless of the Include/Funds-only return toggle.
  const breakdownValue = clipYtd(view.series);
  const breakdownCash = clipYtd(view.cashDecomp?.cashValue ?? []);

  const logApplied =
    effectiveScale === "log" &&
    chartMode !== "breakdown" &&
    (chartMode === "performance" ? perfSeries.length > 0 : canLogScale(retSeries.map((p) => p.v)));

  // % return for the range pill — TIME-WEIGHTED (#236). Chains each day's return
  // on the wealth held that day, netting external flows out via the contribution
  // line, so a big mid-window deposit rebases the next day rather than dividing a
  // window's gain by a tiny start base (the start-฿11k / +฿800k / 73% blowup). It
  // reflects the active cash mode for free — retSeries/retNetInvested are already
  // mode-adjusted. Falls back to the price-ratio when net-invested data is absent
  // (static placeholder). This answers "how did this window perform"; the chart
  // tooltip's cumulative Gain % stays money-weighted ("gain on what I put in").
  const periodReturn =
    retSeries.length === 0
      ? null
      : retNetInvestedForReturn.length === 0
        ? seriesReturnPct(retSeries)
        : periodTwr(retSeries, retNetInvestedForReturn);
  // In-transit cash is reported for the whole book; per-portfolio views skip
  // the tooltip note rather than implying a per-bucket number we don't have. In
  // "Funds only" the cash is OUT of the value line, so the note would contradict
  // the chart — drop it.
  const chartCash =
    activePf || cashMode === "funds"
      ? null
      : clipYtd(cashSeries?.map((p) => ({ d: p.date, v: p.value })) ?? []);
  // Benchmark shares the chart's window (incl. the YTD clip).
  const chartBenchmark = benchmark !== "none" && benchmarkSeries ? clipYtd(benchmarkSeries) : null;

  // ── Chart caption — the windowed number, placed by mode ───────────────────
  // The all-time "what I made" stays in the hero (stable). This is its windowed
  // companion, and the unit follows the mode:
  //  • Value: money made over the window = value change − net deposits. A safe
  //    ABSOLUTE (no divide → no short-window blowup); a ฿ amount has no
  //    time-weighted twin, so the caption is ฿-only here.
  //  • Performance: the time-weighted pill return + the benchmark gap (a bare %
  //    isn't actionable; it earns its place next to a benchmark).
  const windowGain =
    retSeries.length < 2
      ? null
      : retNetInvested.length >= 2
        ? retSeries[retSeries.length - 1].v -
          retSeries[0].v -
          (retNetInvested[retNetInvested.length - 1].v - retNetInvested[0].v)
        : retSeries[retSeries.length - 1].v - retSeries[0].v;
  // A benchmark has no external flows, so its window return is just the price ratio.
  const benchmarkReturn =
    chartBenchmark && chartBenchmark.length > 1 ? seriesReturnPct(chartBenchmark) : null;
  const benchShort =
    benchmark !== "none"
      ? (BENCHMARK_TR_OPTIONS.find((b) => b.key === benchmark)?.short ?? "index")
      : null;
  const benchGap =
    periodReturn != null && benchmarkReturn != null ? periodReturn - benchmarkReturn : null;
  const rangeLabel: Record<string, string> = {
    "1M": "past month",
    "3M": "past 3 months",
    YTD: "year to date",
    "1Y": "past year",
    "5Y": "past 5 years",
    All: "all-time",
  };

  // Which scorecard rows render (single source of truth for the JSX below AND the
  // chart-height math). Row 1 (all-time) is always present; the windowed row shows
  // in Return always / in Value off "All"; the benchmark row only in Return+Compare.
  const showWindowRow =
    (chartMode === "performance" && periodReturn != null) ||
    (chartMode === "value" && range !== "All" && windowGain != null);
  const showBenchRow =
    chartMode === "performance" && benchGap != null && !!benchShort && benchmarkReturn != null;
  // Instead of reserving the tallest scorecard (a blank gap), let the chart absorb
  // the slack so the scorecard + chart stays a constant height and the controls
  // below never move. scoreH() mirrors the CSS: each row is 18px with an equal 3px
  // gap between rows (see .score-row).
  const scorecardRows = 1 + (showWindowRow ? 1 : 0) + (showBenchRow ? 1 : 0);
  const scoreH = (rows: number) => 18 * rows + 3 * Math.max(0, rows - 1);
  const chartHeight = NAV_CHART_HEIGHT + (scoreH(3) - scoreH(scorecardRows));

  const showAnalysis = activePfId === "all" || activePf?.targetModelId;

  // `health` is derived from `view`, which is guaranteed non-null past the
  // early returns above — this guard just narrows the type for TS.
  if (!health) return null;

  const hasHoldings = view.holdings.length > 0;
  const headline = summarizeHealth(health, targetModel?.name ?? null);
  const { trim, add } = rebalanceHint(health.drift);
  const HEADLINE_TONE: Record<string, string> = {
    good: "var(--gain)",
    watch: "var(--amber)",
    action: "var(--loss)",
  };

  // The four named checks that replace the 0-100 grade (drift, fees,
  // diversification, cash) — each a value + status pill + reason.
  const checks = buildNamedChecks(health, targetModel?.name ?? null);

  return (
    <div className="screen">
      <div className="topbar">
        <div className="brand" style={{ flex: 1 }}>
          <BrandMark />
          <span>Macrotide</span>
        </div>
        {showMenu && (
          <button className="icon-btn" aria-label="More" onClick={onOpenSettings}>
            <Icon name="ellipsis-vertical" size={13} />
          </button>
        )}
      </div>

      <div className="portfolio-switch">
        {onOpenPortfolios && (
          <button
            type="button"
            className="pf-switch-menu"
            onClick={onOpenPortfolios}
            aria-label="Manage portfolios"
            title="Portfolios"
          >
            <Icon name="menu" size={14} />
          </button>
        )}
        <button data-active={activePfId === "all"} onClick={() => setActiveId("all")}>
          <span className="pf-icon">
            <Icon name="layers" size={12} />
          </span>{" "}
          All
        </button>
        {portfolios.map((p) => (
          <button key={p.id} data-active={activePfId === p.id} onClick={() => setActiveId(p.id)}>
            <span className="pf-icon">
              <Icon name={p.icon || "wallet"} size={12} />
            </span>{" "}
            {p.name}
          </button>
        ))}
        <button
          style={{
            background: "transparent",
            border: "1px dashed var(--line)",
            color: "var(--muted)",
          }}
          onClick={openNewPortfolio}
        >
          <Icon name="plus" size={12} /> New
        </button>
      </div>

      {activePf?.notes && <div className="pf-notes">{activePf.notes}</div>}

      <div className="hero-block">
        <div className="hero-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span>
            {activePfId === "all" ? "Combined balance" : view.name}
            {view.asOf ? ` · ${view.asOf}` : ""}
          </span>
          {activePf && (
            <button
              type="button"
              className="hero-edit-btn"
              onClick={() => openEditPortfolio(activePf.id)}
              aria-label={`Edit ${activePf.name}`}
              title={`Edit ${activePf.name}`}
            >
              <Icon name="pencil" size={11} />
            </button>
          )}
          <button
            type="button"
            className="hero-edit-btn"
            onClick={togglePrivacy}
            aria-label={valuesHidden ? "Show portfolio values" : "Hide portfolio values"}
            title={valuesHidden ? "Show values" : "Hide values"}
            aria-pressed={valuesHidden}
          >
            <Icon name={valuesHidden ? "eye-off" : "eye"} size={12} />
          </button>
        </div>
        <div className="hero-value">
          <PrivateAmount wide>
            ฿{Math.floor(view.totalValue).toLocaleString("en-US")}
            <span className="cents">.{view.totalValue.toFixed(2).split(".")[1] || "00"}</span>
          </PrivateAmount>
        </div>
        {/* Scorecard — three return rows in one consistent language: a gain/loss
            ▲/▼ caret leads each, the value carries the color, a secondary % sits in
            parens, and the context (period, metric, benchmark) trails muted. Left
            edges align into a caret column.
              1. all-time, money-weighted (the pill's old home) — tap to break down.
              2. windowed: ฿ made in Value (hidden on "All" — echoes row 1), or the
                 time-weighted % in Return (shown even on "All", a different number
                 that the benchmark row below compares against). "time-weighted" is
                 the GIPS-standard term, twin of row 1's money-weighted return.
              3. benchmark gap (Return + Compare): ▲/▼ = ahead/behind, vs the index. */}
        <div className="scorecard">
          <button
            type="button"
            className="score-row score-row--tap"
            data-down={pnl < 0 || undefined}
            onClick={() => setBreakdownOpen(true)}
            aria-label="See how this return breaks down"
            title="See how this return breaks down"
          >
            <TrendCaret up={pnl >= 0} />
            <span className="score-val">
              <PrivateAmount>฿{Math.abs(Math.round(pnl)).toLocaleString("en-US")}</PrivateAmount>
            </span>
            <span className="score-pct">· {fmtPct(Math.abs(pnlPct)).slice(1)}</span>
            <span className="score-ctx">
              {/* Lead with the span ("all-time") so this row reads as the lifetime
                  headline vs the period rows below; keep the excluding-cash basis as
                  a qualifier when that mode is on. */}
              {cashInPlay && cashMode === "funds" ? "all-time · excluding cash" : "all-time"}
              <Icon name="chevron-right" size={11} />
            </span>
          </button>
          {showWindowRow &&
            (chartMode === "performance"
              ? periodReturn != null && (
                  <div className="score-row" data-down={periodReturn < 0 || undefined}>
                    <TrendCaret up={periodReturn >= 0} />
                    <span className="score-val">{fmtPct(Math.abs(periodReturn)).slice(1)}</span>
                    <span className="score-ctx">{rangeLabel[range] ?? range} · time-weighted</span>
                  </div>
                )
              : windowGain != null && (
                  <div className="score-row" data-down={windowGain < 0 || undefined}>
                    <TrendCaret up={windowGain >= 0} />
                    <span className="score-val">
                      <PrivateAmount>
                        ฿{Math.abs(Math.round(windowGain)).toLocaleString("en-US")}
                      </PrivateAmount>
                    </span>
                    <span className="score-ctx">{rangeLabel[range] ?? range}</span>
                  </div>
                ))}
          {showBenchRow && benchGap != null && benchmarkReturn != null && (
            <div className="score-row" data-down={benchGap < 0 || undefined}>
              <TrendCaret up={benchGap >= 0} />
              <span className="score-val">{Math.abs(benchGap).toFixed(1)}pp</span>
              <span className="score-ctx">
                vs {fmtPct(benchmarkReturn)} {benchShort}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="section">
        {/* The graph. Its controls — period, mode, cash, scale, Compare — are all
            below it; the windowed return + benchmark live in the hero scorecard
            above. */}
        <div style={{ marginTop: 16 }}>
          {chartMode === "breakdown" ? (
            <BreakdownChart
              value={breakdownValue}
              cash={breakdownCash}
              normalized={breakdownNorm}
              valuesHidden={valuesHidden}
              height={chartHeight}
              emptyTitle={view.holdings.length === 0 ? "NO HOLDINGS YET" : "NO HISTORY YET"}
              emptyHint={
                view.holdings.length === 0
                  ? "Add holdings to see what your money is made of."
                  : "We're still fetching price history — it fills in automatically in a moment."
              }
            />
          ) : chartMode === "performance" ? (
            <NavChart
              data={perfSeries}
              valuesHidden={valuesHidden}
              scaleMode={effectiveScale}
              valueFormatter={(v) => fmtPct((v - 1) * 100)}
              seriesLabel="Return"
              baselineRef={1}
              benchmarkData={chartBenchmark}
              benchmarkLabel={
                benchmark !== "none"
                  ? (BENCHMARK_TR_OPTIONS.find((b) => b.key === benchmark)?.short ?? null)
                  : null
              }
              height={chartHeight}
              accent="var(--accent)"
              emptyTitle={view.holdings.length === 0 ? "NO HOLDINGS YET" : "NO HISTORY YET"}
              emptyHint={
                view.holdings.length === 0
                  ? "Add holdings to see how this portfolio has performed."
                  : "We're still fetching price history — it fills in automatically in a moment."
              }
            />
          ) : (
            <NavChart
              data={retSeries}
              investedData={retNetInvested}
              cashData={chartCash}
              valuesHidden={valuesHidden}
              scaleMode={effectiveScale}
              benchmarkData={chartBenchmark}
              benchmarkLabel={
                benchmark !== "none"
                  ? (BENCHMARK_TR_OPTIONS.find((b) => b.key === benchmark)?.short ?? null)
                  : null
              }
              height={chartHeight}
              accent="var(--accent)"
              emptyTitle={view.holdings.length === 0 ? "NO HOLDINGS YET" : "NO HISTORY YET"}
              emptyHint={
                view.holdings.length === 0
                  ? "Add holdings to see how this portfolio tracks over time."
                  : "We're still fetching price history — it fills in automatically in a moment."
              }
            />
          )}
        </div>
        {/* Chart control toolbar — flat worded controls in one wrapping row; each
            part (period, mode, and each tool) flows and wraps individually. A thin
            ::before rule separates the parts; the rule before a part that wrapped to
            a new line is clipped (see .chart-toolbar), so a wrapped line never opens
            with a divider. */}
        <div className="chart-toolbar">
          <div className="toolbar-part">
            {["1M", "3M", "YTD", "1Y", ...(hasFiveYears ? ["5Y"] : []), "All"].map((r) => (
              <button
                key={r}
                type="button"
                className="chart-toolbtn"
                data-active={range === r || undefined}
                aria-pressed={range === r}
                onClick={() => setRange(r)}
              >
                {r}
              </button>
            ))}
          </div>
          <div className="toolbar-part">
            {(
              [
                ["value", "Value"],
                ["performance", "Return"],
                ["breakdown", "Mix"],
              ] as const
            ).map(([m, lbl]) => (
              <button
                key={m}
                type="button"
                className="chart-toolbtn"
                data-active={chartMode === m || undefined}
                aria-pressed={chartMode === m}
                onClick={() => setChartMode(m)}
              >
                {lbl}
              </button>
            ))}
          </div>
          {chartMode === "breakdown" ? (
            <div className="toolbar-part">
              <button
                type="button"
                className="chart-toolbtn"
                data-active={breakdownNorm || undefined}
                aria-pressed={breakdownNorm}
                onClick={() => setBreakdownNorm(true)}
                title="Share of total (100%)"
              >
                Share
              </button>
              <button
                type="button"
                className="chart-toolbtn"
                data-active={!breakdownNorm || undefined}
                aria-pressed={!breakdownNorm}
                onClick={() => setBreakdownNorm(false)}
                title="Absolute amount — stacked height is your total"
              >
                Amount
              </button>
            </div>
          ) : (
            <>
              {/* Cash precedes Log: Mode + Cash change what the line MEANS
                  (which series, cash in or out); Log only changes how it's
                  drawn. Group the meaning-changers, then the drawing lens. */}
              {cashInPlay && (
                <CashModeKebab
                  mode={cashMode}
                  onChange={setCashMode}
                  hasReserved={hasReserved}
                  hintDismissed={cashHintDismissed}
                  onDismissHint={dismissCashHint}
                />
              )}
              <button
                type="button"
                className="chart-toolbtn"
                data-active={effectiveScale === "log" || undefined}
                aria-pressed={effectiveScale === "log"}
                onClick={() => setYAxisScale(effectiveScale === "log" ? "linear" : "log")}
                title="Log scale — equal % moves are the same height, fairer across long spans"
              >
                Log
              </button>
              <BenchmarkPicker value={benchmark} onChange={setBenchmark} />
            </>
          )}
        </div>
        {/* One adaptive caption line: a short sentence for the current view with the
            jargon as dotted-underline TERMS that open their definition in place. One
            visible line (teaches at a glance, discoverable), depth on the word — vs a
            caption stack or an opaque catch-all icon. The actionable cash nudge stays
            its own inline line below. */}
        {(() => {
          // The base sentence for the current mode, then any active caveat clauses
          // joined into ONE flowing sentence (commas + a final "and", no dashes).
          // Jargon renders as tappable TermTips.
          const core =
            chartMode === "performance" ? (
              <>
                Your <TermTip label="time-weighted" def={TERM_DEFS.twr} /> return over time
              </>
            ) : chartMode === "breakdown" ? (
              <>
                How your money splits between <TermTip label="funds and cash" def={TERM_DEFS.mix} />{" "}
                over time
              </>
            ) : (
              <>
                Your value over time, compared with what you've{" "}
                <TermTip label="put in" def={TERM_DEFS.invested} />
              </>
            );
          const dividendNote =
            chartMode !== "breakdown"
              ? performanceDisclaimer(benchmark !== "none", hasDistributingHolding)
              : null;
          const clauses: { k: string; node: ReactNode }[] = [];
          if (chartMode !== "breakdown" && logApplied)
            clauses.push({
              k: "scale",
              node: (
                <>
                  shown on a <TermTip label="log scale" def={TERM_DEFS.scale} />
                </>
              ),
            });
          if (dividendNote)
            clauses.push({
              k: "div",
              node: (
                <>
                  with some <TermTip label="dividends" def={dividendNote} /> paid out
                </>
              ),
            });
          if (estimatedThrough)
            clauses.push({
              k: "est",
              node: (
                <>
                  older values{" "}
                  <TermTip
                    label="estimated"
                    def={`Values before ${formatTooltipDate(estimatedThrough)} are estimated from your recorded prices.`}
                  />
                </>
              ),
            });
          return (
            <div className="chart-caption-line">
              {core}
              {clauses.map((c, i) => (
                <span key={c.k}>
                  {i === clauses.length - 1 && clauses.length > 1 ? ", and " : ", "}
                  {c.node}
                </span>
              ))}
              .
            </div>
          );
        })()}
        {/* Excluding cash is most wanted exactly here: an index is fully invested, so a
            blended return (incl. idle cash) is an unfair comparison. Surface the lever at
            the moment of need rather than as permanent chrome (#149). Symmetric — offer to
            fold cash back in once excluded. */}
        {chartMode !== "breakdown" && benchmark !== "none" && cashInPlay && idleCash > 0.5 && (
          <p
            style={{
              fontSize: 11,
              color: "var(--muted)",
              lineHeight: 1.45,
              margin: "6px 4px 0",
            }}
          >
            {cashMode === "incl" ? (
              <>
                Your return counts idle cash, but an index is fully invested.{" "}
                <button type="button" className="link-btn" onClick={() => setCashMode("funds")}>
                  Exclude cash
                  <Icon name="chevron-right" size={11} />
                </button>
              </>
            ) : (
              <>
                You're comparing investments only, for a fair read against the index.{" "}
                <button type="button" className="link-btn" onClick={() => setCashMode("incl")}>
                  Include cash
                  <Icon name="chevron-right" size={11} />
                </button>
              </>
            )}
          </p>
        )}
      </div>

      {/* ── Health: the plain-language headline + four named checks. This leads
           the analysis instead of a 0-100 grade — a chase-able number nudges the
           tinkering that hurts passive investors. The charts below are the
           drill-down. See docs/explanation/portfolio-health.md. */}
      {hasHoldings && (
        <div className="section" style={{ marginTop: 8 }}>
          <div className="section-header" style={{ padding: "0 4px" }}>
            <h3>Health</h3>
            <button type="button" className="link" onClick={onOpenModels}>
              {targetModel ? `Target: ${targetModel.name} →` : "Set a target →"}
            </button>
          </div>

          {/* Level 0 — the one thing that matters now. */}
          <div className="card" style={{ marginBottom: 10 }}>
            <div
              style={{
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                color: HEADLINE_TONE[headline.tone],
                letterSpacing: "0.04em",
                marginBottom: 4,
              }}
            >
              ● TOP THING TO KNOW
            </div>
            <div
              style={{ fontSize: 14, fontWeight: 500, marginBottom: 6, letterSpacing: "-0.01em" }}
            >
              {headline.title}
            </div>
            <div
              style={{
                fontSize: 12.5,
                color: "var(--ink-soft)",
                lineHeight: 1.5,
                marginBottom: 10,
              }}
            >
              {headline.body}
            </div>
            <button
              className="btn sm primary"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("ai-prompt", {
                    detail: {
                      display: headline.prompt,
                      send: headline.prompt,
                      context: { screen: "portfolio", intent: "score_review" },
                    },
                  }),
                );
              }}
            >
              <Icon name="chat" size={12} /> Discuss
            </button>
          </div>

          {/* Level 1 — the four named checks (value · status · reason). */}
          <div className="card">
            <div
              style={{
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                color: "var(--muted)",
                letterSpacing: "0.04em",
                marginBottom: 2,
              }}
            >
              ● CHECKS
            </div>
            {checks.map((c, i) => (
              <NamedCheckRow key={c.key} check={c} last={i === checks.length - 1} />
            ))}
            <div
              style={{
                fontSize: 10,
                color: "var(--muted)",
                marginTop: 8,
                lineHeight: 1.4,
                borderTop: "1px solid var(--line-soft)",
                paddingTop: 6,
              }}
            >
              Plain checks, not a grade — each maps to one action. Deterministic, no AI; the charts
              below show the detail behind each.
            </div>
          </div>
        </div>
      )}

      {hasHoldings && (
        <div style={{ marginBottom: 14 }}>
          <div className="section-header" style={{ padding: "0 20px" }}>
            <h3>Charts</h3>
          </div>
          <div className="chart-row">
            <div className="chart-card">
              <div className="h">ALLOCATION · BY ASSET CLASS</div>
              <AllocationDonut data={health.byClass} height={150} />
              <div className="stack-sm" style={{ fontSize: 11, marginTop: 4 }}>
                {health.byClass.map((s) => (
                  <div key={s.key} className="row between" style={{ gap: 6, padding: "2px 0" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span
                        style={{ width: 7, height: 7, borderRadius: "50%", background: s.color }}
                      ></span>
                      <span>{s.label}</span>
                    </span>
                    <span className="num" style={{ color: "var(--muted)" }}>
                      {s.pct.toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="chart-card">
              <div className="h">
                DRIFT FROM TARGET{targetModel ? ` · ${targetModel.name}` : ""}
              </div>
              {targetModel ? (
                <>
                  <div
                    className="v"
                    style={{
                      color: health.trackingGapPp >= 5 ? "var(--amber)" : "var(--gain)",
                    }}
                  >
                    {health.trackingGapPp.toFixed(1)}pp
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8 }}>
                    {health.trackingGapPp >= 5
                      ? "Off target — consider a rebalance"
                      : "Closely tracking your target"}
                  </div>
                  <DriftBars data={health.drift} height={150} />
                </>
              ) : (
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--muted)",
                    lineHeight: 1.5,
                    padding: "16px 0",
                  }}
                >
                  Pick a target model to track how far each holding has drifted from its intended
                  weight.
                </div>
              )}
            </div>

            <div className="chart-card">
              <div className="h">GEOGRAPHY · BY FUND DOMICILE</div>
              <div className="stacked-bar">
                {health.byRegion.map((g) => (
                  <span key={g.key} style={{ width: `${g.pct}%`, background: g.color }}></span>
                ))}
              </div>
              <div className="stack-sm" style={{ fontSize: 11 }}>
                {health.byRegion.slice(0, 6).map((g) => (
                  <div key={g.key} className="row between" style={{ gap: 6, padding: "2px 0" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span
                        style={{ width: 7, height: 7, borderRadius: "50%", background: g.color }}
                      ></span>
                      <span>{g.label}</span>
                    </span>
                    <span className="num" style={{ color: "var(--muted)" }}>
                      {g.pct.toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="chart-card">
              <div className="h">CONCENTRATION</div>
              <div className="v">
                {health.concentration.top ? `${health.concentration.top.pct.toFixed(0)}%` : "—"}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10 }}>
                {health.concentration.top
                  ? `Largest holding · ${health.concentration.top.ticker}`
                  : "No holdings"}
              </div>
              <div className="stack-sm" style={{ fontSize: 11 }}>
                <div className="row between" style={{ padding: "2px 0" }}>
                  <span>Top 3 holdings</span>
                  <span className="num" style={{ color: "var(--muted)" }}>
                    {health.concentration.top3Pct.toFixed(0)}%
                  </span>
                </div>
                <div className="row between" style={{ padding: "2px 0" }}>
                  <span>Holdings held</span>
                  <span className="num" style={{ color: "var(--muted)" }}>
                    {health.concentration.holdingCount}
                  </span>
                </div>
                <div className="row between" style={{ padding: "2px 0" }}>
                  <span>Cash drag</span>
                  <span
                    className="num"
                    style={{ color: health.cashPct >= 10 ? "var(--amber)" : "var(--muted)" }}
                  >
                    {health.cashPct.toFixed(1)}%
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {showAnalysis && targetModel && (trim || add) && (
        <div className="section" style={{ marginTop: 8 }}>
          <div className="section-header" style={{ padding: "0 4px" }}>
            <h3>Suggested rebalance</h3>
            <button type="button" className="link" onClick={onOpenModels}>
              Target: {targetModel.name} →
            </button>
          </div>

          <div
            className="card"
            style={{
              marginTop: 4,
              background: "var(--accent-soft)",
              borderColor: "transparent",
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                color: "var(--accent-ink)",
                letterSpacing: "0.04em",
                marginBottom: 6,
              }}
            >
              ● SUGGESTED REBALANCE
            </div>
            <div style={{ marginBottom: 10 }}>
              {trim && (
                <div className="row between" style={{ padding: "3px 0", fontSize: 12.5 }}>
                  <span style={{ color: "var(--accent-ink)" }}>
                    Trim <strong>{trim.ticker}</strong>
                  </span>
                  <span className="num" style={{ color: "var(--accent-ink)" }}>
                    {trim.current.toFixed(0)}% → {trim.target.toFixed(0)}%
                  </span>
                </div>
              )}
              {add && (
                <div className="row between" style={{ padding: "3px 0", fontSize: 12.5 }}>
                  <span style={{ color: "var(--accent-ink)" }}>
                    Add to <strong>{add.ticker}</strong>
                  </span>
                  <span className="num" style={{ color: "var(--accent-ink)" }}>
                    {add.current.toFixed(0)}% → {add.target.toFixed(0)}%
                  </span>
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                className="btn sm primary"
                onClick={() => {
                  const prompt = `My portfolio has drifted ${health.trackingGapPp.toFixed(1)}pp from my ${targetModel.name} target. Give me a step-by-step rebalance plan with specific amounts.`;
                  window.dispatchEvent(
                    new CustomEvent("ai-prompt", {
                      // Carry the gap + target the screen already computed so the
                      // Advisor can plan without re-deriving them via read_portfolio.
                      detail: {
                        display: prompt,
                        send: prompt,
                        context: {
                          screen: "portfolio",
                          intent: "rebalance",
                          subject: targetModel.name,
                          signals: { trackingGapPp: Number(health.trackingGapPp.toFixed(1)) },
                        },
                      },
                    }),
                  );
                }}
              >
                Plan the rebalance <Icon name="arrowRight" size={12} />
              </button>
            </div>
          </div>
        </div>
      )}

      {feeCreepFindings.length > 0 && (
        <div className="section" style={{ marginTop: 14 }}>
          <div className="section-header" style={{ padding: "0 4px" }}>
            <h3>Fee check</h3>
          </div>
          {/* Info-only on the Portfolio tab: the held fund, its cheaper comparable
              alternative(s), and the saving — exactly as it read before the
              action-item redesign. The honest Archive / "Not for me" controls and
              the Hidden-checks restore list live on the "See details" page, so the
              tab stays calm. Exactly one section-level "Ask advisor" + one "See
              details" beneath; no per-card actions. */}
          <div
            className="card"
            style={{
              borderColor: "var(--amber)",
              background: "var(--amber-soft, color-mix(in srgb, var(--amber) 8%, transparent))",
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                color: "var(--amber)",
                letterSpacing: "0.04em",
                marginBottom: 6,
              }}
            >
              ● FEE CREEP — COMPARABLE EXPOSURE, LOWER COST
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--ink-soft)",
                lineHeight: 1.5,
                marginBottom: 10,
              }}
            >
              {feeCheckInlineIntro(feeCreepFindings.length)}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {inlineFeeView.top.map((f) => (
                <div
                  key={f.heldTicker}
                  style={{
                    borderTop: "1px solid var(--line-soft)",
                    paddingTop: 8,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      marginBottom: 4,
                    }}
                  >
                    <div>
                      <span style={{ fontSize: 13, fontWeight: 500, letterSpacing: "-0.01em" }}>
                        {f.heldTicker}
                      </span>
                      <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: 6 }}>
                        {f.heldName}
                      </span>
                    </div>
                    <span
                      className="num"
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: "var(--amber)",
                        whiteSpace: "nowrap",
                        marginLeft: 8,
                      }}
                    >
                      {f.heldTer.toFixed(2)}% TER
                    </span>
                  </div>
                  {f.alternatives.slice(0, 2).map((alt) => (
                    <div
                      key={alt.projId}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "3px 0",
                        paddingLeft: 10,
                      }}
                    >
                      <span style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>
                        {alt.abbrName}
                        {alt.englishName ? (
                          <span style={{ color: "var(--muted)", marginLeft: 4 }}>
                            · {alt.englishName}
                          </span>
                        ) : null}
                      </span>
                      <span
                        className="num"
                        style={{ fontSize: 11.5, color: "var(--gain)", whiteSpace: "nowrap" }}
                      >
                        {alt.ter.toFixed(2)}%
                      </span>
                    </div>
                  ))}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      marginTop: 6,
                      paddingLeft: 10,
                    }}
                  >
                    <span style={{ fontSize: 11, color: "var(--muted)" }}>Potential saving:</span>
                    <span
                      className="num"
                      style={{ fontSize: 12, fontWeight: 600, color: "var(--gain)" }}
                    >
                      −{f.savingsPp.toFixed(2)}pp/yr
                    </span>
                  </div>
                </div>
              ))}
            </div>
            {/* One section-level "See details" (primary) + one "Ask advisor"
                (secondary) for the whole section. When the section is capped the
                primary button carries the true total ("See all N") — the count
                lives on the one action that reveals the rest, so there's no
                separate cap-note line. Copy comes from the same pure helper the
                tests cover, so inline + page agree. Intrinsic width (no lone
                flex:1) so neither button stretches full-width on a wide pane. */}
            <div style={{ marginTop: 12, display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn sm primary"
                onClick={() => setFeeDetailsOpen(true)}
                aria-label="See fee-check details"
              >
                {feeChecksButtonLabel(feeCreepFindings.length, inlineFeeView.top.length)}
              </button>
              <button
                type="button"
                className="btn sm ghost"
                style={{ gap: 4 }}
                onClick={askAdvisorAboutFees}
                aria-label="Ask Advisor about these fees"
              >
                <Icon name="chat" size={12} /> Ask advisor
              </button>
            </div>
            <div
              style={{
                fontSize: 10,
                color: "var(--muted)",
                marginTop: 8,
                lineHeight: 1.4,
                borderTop: "1px solid var(--line-soft)",
                paddingTop: 6,
              }}
            >
              Comparable exposure means same asset class. Lower fee, not necessarily better fund.
              Tax implications and switching costs apply.
            </div>
          </div>
        </div>
      )}

      {onOpenActivity && (
        <RecentActivityPeek
          bucketId={activePfId === "all" ? undefined : activePfId}
          onSeeAll={onOpenActivity}
        />
      )}

      <div className="section-header" style={{ padding: "0 20px", marginBottom: 4, marginTop: 18 }}>
        <h3>Holdings</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="link">{view.holdings.length} holdings</span>
          <AddSplitButton onInvestment={onOpenImport} onCash={onOpenCash} />
        </div>
      </div>
      <div className="filter-chips">
        <button
          type="button"
          className="chip"
          data-active={filter === "all"}
          onClick={() => setFilter("all")}
        >
          All
        </button>
        <button
          type="button"
          className="chip"
          data-active={filter === "equity"}
          onClick={() => setFilter("equity")}
        >
          Equity {byClass.equity.toFixed(0)}%
        </button>
        <button
          type="button"
          className="chip"
          data-active={filter === "bond"}
          onClick={() => setFilter("bond")}
        >
          Bonds {byClass.bond.toFixed(0)}%
        </button>
        {byClass.mixed > 0.5 && (
          <button
            type="button"
            className="chip"
            data-active={filter === "mixed"}
            onClick={() => setFilter("mixed")}
          >
            Mixed {byClass.mixed.toFixed(0)}%
          </button>
        )}
        {byClass.alternative > 0.5 && (
          <button
            type="button"
            className="chip"
            data-active={filter === "alternative"}
            onClick={() => setFilter("alternative")}
          >
            Alt {byClass.alternative.toFixed(0)}%
          </button>
        )}
        {byClass.cash > 0.5 && (
          <button
            type="button"
            className="chip"
            data-active={filter === "cash"}
            onClick={() => setFilter("cash")}
          >
            Cash {byClass.cash.toFixed(0)}%
          </button>
        )}
        {byClass.unknown > 0.5 && (
          <button
            type="button"
            className="chip"
            data-active={filter === "unknown"}
            onClick={() => setFilter("unknown")}
          >
            Unclassified {byClass.unknown.toFixed(0)}%
          </button>
        )}
      </div>

      <div className="holdings-list">
        {filtered.length === 0 && (
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
            {view.holdings.length === 0 ? (
              <>
                <div style={{ marginBottom: 10, color: "var(--ink-soft)" }}>
                  No holdings in this portfolio yet.
                </div>
                <button className="btn sm primary" onClick={onOpenImport}>
                  <Icon name="plus" size={12} /> Add your first holding
                </button>
              </>
            ) : (
              <>No {filter} holdings here. Switch filters to see the rest.</>
            )}
          </div>
        )}
        {filtered.map((h) => {
          const pct = view.totalValue > 0 ? (h.value / view.totalValue) * 100 : 0;
          // Any holding can be viewed; only DB-backed holdings (with an id) can
          // be edited via the holdings API.
          const editable = h.id !== undefined;
          // Cash earmark (#149): a set-aside account shows a lock marker next to the
          // Cash chip, plus its purpose on line 2. Resolve it once for the row.
          const mark = markByTicker.get(h.ticker.toUpperCase());
          const kind = holdingKind(h);
          const reservedCash = h.quoteSource === "cash" && mark?.role === "reserved";
          return (
            <div
              key={(h.id ?? h.ticker) + (h.source || "")}
              className="holding"
              style={{
                // Override .holding's grid: the row is now a flex container for
                // [view button, edit button]; the view button carries the
                // original 3-column grid so the swatch/name/value layout is
                // unchanged.
                display: "flex",
                gap: 4,
              }}
            >
              {/* Main click target — opens the read-only detail view. A real
                  <button> so it's keyboard-focusable; styled to inherit the
                  row's chrome and carry the row's grid. Sibling of the Edit
                  button (never nested) so the markup stays valid. Mirrors the
                  FundSelect row pattern. */}
              <button
                type="button"
                aria-label={`Open ${h.ticker} position`}
                onClick={() => (onOpenPosition ? onOpenPosition(h.ticker) : openHoldingDetail(h))}
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
                  margin: 0,
                  textAlign: "left",
                  font: "inherit",
                  color: "inherit",
                  cursor: "pointer",
                }}
              >
                <div className="swatch" style={{ background: holdingColor(h) }}>
                  {swatchAbbr(h.ticker)}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="name" style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {/* Cash shows its account name in the user's case; the ticker stays
                          the upper-cased identity used everywhere else (#149). */}
                      {h.quoteSource === "cash" ? h.name || h.ticker : h.ticker}
                    </span>
                    {/* Type chip (Fund / ETF / Stock / Cash) so a mixed Thai + US + cash
                        list is scannable at a glance. Shared MiniTag in the SAME muted grey
                        as the Explore list's asset-class / feeder badges (color --muted, bg
                        --card-soft) so the two lists' badges are identical. Set-aside cash
                        gets a lock INSIDE the chip ("locked cash") — a STATUS, not a type. */}
                    {kind && (
                      <MiniTag
                        label={kind}
                        color="var(--muted)"
                        bg="var(--card-soft)"
                        icon={reservedCash ? <Icon name="lock" size={9} /> : undefined}
                        title={reservedCash ? "Reserved" : undefined}
                      />
                    )}
                    {h.syncedBroker && <SyncedIcon broker={h.syncedBroker} />}
                  </div>
                  <div className="sub">
                    Weight {pct.toFixed(1)}%
                    {h.ter != null && (
                      <>
                        {" · "}
                        <span style={{ color: terRowColor(h.ter) }}>TER {h.ter.toFixed(2)}%</span>
                      </>
                    )}
                    {(() => {
                      // Line 2 = asset class · exposure geography (each shown only when
                      // known; the chip carries the instrument type, never repeated here).
                      // Cash carries neither — it shows the user's own earmark label
                      // (`purpose`) verbatim when set; the lock marker already flags
                      // reserved, so an unlabelled account shows nothing (#149).
                      const base = [holdingCategoryLabel(h), holdingGeography(h)]
                        .filter(Boolean)
                        .join(" · ");
                      const tag = h.quoteSource === "cash" ? (mark?.purpose ?? "") : base;
                      // Skip the separator entirely when there's nothing to show (an
                      // uncategorized custom asset, or plain investable cash) rather than
                      // dangle a " · ".
                      if (!tag) return null;
                      return (
                        <>
                          {" · "}
                          {tag}
                        </>
                      );
                    })()}
                  </div>
                </div>
                <div className="stack-xs" style={{ alignItems: "flex-end" }}>
                  <div className="value">
                    <PrivateAmount>฿{Math.round(h.value).toLocaleString("en-US")}</PrivateAmount>
                  </div>
                  <div className={`pct ${h.d1 >= 0 ? "delta up" : "delta down"}`}>
                    {/* Pinned to 2dp (not adaptive): this is an aligned column,
                        so a fixed decimal count keeps the values lined up. */}
                    {fmtPct(h.d1, 2)}
                  </div>
                </div>
              </button>
              {editable && (
                <div style={{ marginLeft: 8, flexShrink: 0, alignSelf: "center" }}>
                  <KebabMenu
                    label={`${h.ticker} actions`}
                    items={[
                      // Fund details don't apply to a cash account.
                      ...(h.quoteSource === "cash"
                        ? []
                        : [
                            {
                              label:
                                h.quoteSource === "market" ? "Security details" : "Fund details",
                              onClick: () => openHoldingDetail(h),
                            },
                          ]),
                      { label: "Edit holding", onClick: () => setHoldingSheet(h) },
                    ]}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {activePfId === "all" && targetModel && (
        <div className="section" style={{ marginTop: 14 }}>
          <div
            className="card"
            style={{ padding: 14, cursor: "pointer" }}
            {...onActivate(onOpenModels)}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <ModelDonut mix={targetModel.mix} size={44} thickness={7} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 10,
                    fontFamily: "var(--font-mono)",
                    color: "var(--muted)",
                    letterSpacing: "0.04em",
                    marginBottom: 2,
                  }}
                >
                  YOUR TARGET
                </div>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 500,
                    letterSpacing: "-0.01em",
                  }}
                >
                  {targetModel.name}
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                  Browse {Math.max(0, (models?.length ?? 0) - 1)} other index strategies →
                </div>
              </div>
              <Icon name="arrowRight" size={14} />
            </div>
          </div>
        </div>
      )}

      <div className="section" style={{ marginTop: 4 }}>
        <div
          style={{
            fontSize: 11,
            color: "var(--muted)",
            lineHeight: 1.5,
            padding: "0 4px",
            fontFamily: "var(--font-mono)",
          }}
        >
          ⓘ Educational analysis only. Not personalised financial advice.
        </div>
      </div>

      <FeeChecksPage
        open={feeDetailsOpen}
        onClose={() => setFeeDetailsOpen(false)}
        findings={feeCreepFindings}
        hidden={hiddenFeeChecks}
        onArchive={archiveFeeCreep}
        onReject={rejectFeeCreep}
        onRestore={restoreHidden}
      />

      <ReturnsBreakdownSheet
        open={breakdownOpen}
        onClose={() => setBreakdownOpen(false)}
        bucketId={activePfId}
        portfolioName={activePfId === "all" ? "All portfolios" : view.name}
        totalValue={retTotalValue}
        netContributed={netContributed}
        cashMode={cashMode}
        onCashModeChange={setCashMode}
        showCashToggle={cashInPlay}
        idleCash={idleCash}
      />

      {/* One host for every detail overlay: holding view, US security, and the
          Thai funds its cross-links push — one modal with Back/Close. */}
      <DetailSheetHost onEditHolding={setHoldingSheet} onOpenPosition={onOpenPosition} />

      <HoldingSheet
        open={!!holdingSheet}
        holdingId={holdingSheet?.id}
        lockTicker
        syncedBroker={holdingSheet?.syncedBroker}
        initial={
          holdingSheet
            ? holdingToFormValues(
                holdingSheet,
                holdingSheet.bucketId ?? activePf?.id ?? portfolios[0]?.id ?? "",
              )
            : {
                bucketId: "",
                ticker: "",
                thaiName: "",
                englishName: "",
                category: "",
                assetClass: "equity",
                region: "",
                units: 0,
                avgCost: 0,
                ter: 0,
                source: "",
                quoteSource: DEFAULT_QUOTE_SOURCE,
              }
        }
        bucketOptions={portfolios.map((p) => ({ id: p.id, name: p.name }))}
        onClose={() => setHoldingSheet(null)}
        onSave={saveHolding}
        onDelete={
          holdingSheet?.id !== undefined
            ? () => deleteHolding(holdingSheet.id as number)
            : undefined
        }
      />
    </div>
  );
}
