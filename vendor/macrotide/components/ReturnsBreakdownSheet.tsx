"use client";

// ReturnsBreakdownSheet — decomposes the hero's "total return" so the headline
// number and the chart's "All" pill stop reading as a contradiction (#152).
//
// The hero shows total return on contributed capital (value − net money in). A
// switching-heavy book ALSO shows a much smaller "unrealized" gain on the
// CURRENT holdings, because every fund switch banks the realized gain into the
// new position's cost basis (resetting the denominator). Both numbers are
// correct — they answer different questions. This sheet lays them side by side,
// plus the realized / dividend / fee parts that make up the difference.
//
// Data: GET /api/transactions/analytics?bucket=ID (realized, income, expense,
// cost basis, money-weighted IRR) — the same endpoint the history + position
// pages use. Total value and money-in come from the portfolio series (props) so
// they tie out exactly to the hero.

import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { PrivateAmount } from "@/components/PrivateAmount";
import { useResource } from "@/lib/fetchers/swr";
import { fmtPct, fmtTHBClean } from "@/lib/format";
import { summarizeReturns } from "@/lib/portfolio/returns-breakdown";
import type { TransactionAnalytics } from "@/lib/portfolio/transaction-analytics";

type AnalyticsResponse = TransactionAnalytics & { transactionCount: number };

// Sign OUTSIDE the ฿, with a real minus (U+2212) so +/− line up in tabular figures:
// +฿12,300 / −฿450 / ฿0. Magnitude formats through the shared baht helper.
function fmtSignedTHB(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${fmtTHBClean(Math.abs(n))}`;
}

export function ReturnsBreakdownSheet({
  open,
  onClose,
  bucketId,
  portfolioName,
  totalValue,
  netContributed,
  cashMode = "incl",
  onCashModeChange,
  showCashToggle = false,
  idleCash = 0,
}: {
  open: boolean;
  onClose: () => void;
  /** "all" for the combined book, otherwise the bucket id. */
  bucketId: string;
  portfolioName: string;
  /** Total wealth for the RETURN view (mode-adjusted) — matches the screen headline. */
  totalValue: number;
  /**
   * Net external money contributed (deposits − withdrawals), or null when the
   * ledger-derived contribution series isn't available (static placeholder).
   */
  netContributed: number | null;
  /** Contribution mode (#149): "funds" excludes uninvested cash from the IRR. */
  cashMode?: "incl" | "funds";
  /** Flip the basis from inside the sheet — the sheet's own figures recompute, so
   * the effect is visible here (it's a contextual shortcut; the ⋯ menu is canonical). */
  onCashModeChange?: (m: "incl" | "funds") => void;
  /** Only show the basis line when the book actually holds cash. */
  showCashToggle?: boolean;
  /** Uninvested (non-reserved) cash in THB — for the basis line. */
  idleCash?: number;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="detail"
      className="rb-sheet"
      labelledBy="returns-breakdown-title"
    >
      <Modal.Header
        title="Returns breakdown"
        subtitle={portfolioName}
        id="returns-breakdown-title"
      />
      <Modal.Body gap={18}>
        {open && (
          <ReturnsBreakdownBody
            bucketId={bucketId}
            totalValue={totalValue}
            netContributed={netContributed}
            cashMode={cashMode}
            onCashModeChange={onCashModeChange}
            showCashToggle={showCashToggle}
            idleCash={idleCash}
          />
        )}
      </Modal.Body>
    </Modal>
  );
}

function ReturnsBreakdownBody({
  bucketId,
  totalValue,
  netContributed,
  cashMode,
  onCashModeChange,
  showCashToggle,
  idleCash,
}: {
  bucketId: string;
  totalValue: number;
  netContributed: number | null;
  cashMode: "incl" | "funds";
  onCashModeChange?: (m: "incl" | "funds") => void;
  showCashToggle?: boolean;
  idleCash?: number;
}) {
  const params = new URLSearchParams();
  if (bucketId !== "all") params.set("bucket", bucketId);
  if (cashMode === "funds") params.set("cash", "funds");
  const qs = params.toString();
  const key = `/api/transactions/analytics${qs ? `?${qs}` : ""}`;
  const { data, isLoading } = useResource<AnalyticsResponse>(key);

  if (isLoading || !data) {
    return <p className="muted">Loading…</p>;
  }

  const r = summarizeReturns({
    totalValue,
    netContributed,
    costBasisTotal: data.costBasisTotal,
    realizedTotal: data.realizedTotal,
    incomeTotal: data.incomeTotal,
    expenseTotal: data.expenseTotal,
    irr: data.irr,
  });

  const gainColor = (n: number) => (n >= 0 ? "var(--gain)" : "var(--loss)");

  return (
    <div className="returns-breakdown">
      {/* Hero — the answer. Big and signed; it sits ABOVE the aligned row grid so
          it can be large without breaking the column. */}
      <div className="rb-hero">
        <div className="rb-hero-label">Total return</div>
        {r.totalReturnAbs != null ? (
          <>
            <div className="rb-hero-value" style={{ color: gainColor(r.totalReturnAbs) }}>
              <PrivateAmount>{fmtSignedTHB(r.totalReturnAbs)}</PrivateAmount>
              {r.totalReturnPct != null && (
                <span className="rb-hero-pct">{fmtPct(r.totalReturnPct)}</span>
              )}
            </div>
            <div className="rb-hero-sub">
              {r.annualizedPct != null
                ? `${fmtPct(r.annualizedPct)} a year, money-weighted`
                : "on the money you've contributed"}
            </div>
          </>
        ) : (
          <div className="rb-hero-sub">Needs a recorded contribution history.</div>
        )}
      </div>

      {/* Contribution-basis line (#149). The sheet's own figures are mode-dependent, so
          flipping here recomputes them in view — a contextual shortcut (the ⋯ menu on the
          portfolio is the canonical control; both call the same setter). */}
      {showCashToggle && onCashModeChange && (
        <p className="rb-cash-mode-note">
          {cashMode === "incl" ? (
            <>
              Includes{" "}
              {idleCash && idleCash > 0.5 ? (
                <PrivateAmount>{fmtTHBClean(idleCash)}</PrivateAmount>
              ) : (
                "your"
              )}{" "}
              idle cash.{" "}
              <button type="button" className="link-btn" onClick={() => onCashModeChange("funds")}>
                Exclude cash
                <Icon name="chevron-right" size={11} />
              </button>
            </>
          ) : (
            <>
              Excludes{" "}
              {idleCash && idleCash > 0.5 ? (
                <PrivateAmount>{fmtTHBClean(idleCash)}</PrivateAmount>
              ) : (
                "your"
              )}{" "}
              idle cash.{" "}
              <button type="button" className="link-btn" onClick={() => onCashModeChange("incl")}>
                Include cash
                <Icon name="chevron-right" size={11} />
              </button>
            </>
          )}
        </p>
      )}

      <section className="rb-group">
        <h4 className="rb-group-title">Summary</h4>
        <Row label="Total value" value={r.totalValue} />
        {r.usesContribution && (
          <Row
            label="Money invested"
            hint="deposits − withdrawals"
            value={r.netContributed ?? undefined}
          />
        )}
      </section>

      <section className="rb-group">
        <h4 className="rb-group-title">Where it comes from</h4>
        <Row label="Cost basis of holdings" value={r.costBasisTotal} />
        <Row
          label="Unrealized gain"
          hint="on current holdings"
          value={r.unrealizedAbs}
          pct={r.unrealizedPct}
          signed
        />
        <Row label="Realized gain" hint="booked from past sells" value={r.realizedTotal} signed />
        {/* Hide zero contributors — a "฿0" Dividends/Fees row reads as "none ever",
            which is misleading (esp. fees: the fund's ongoing TER is already in the
            values above, so this line only ever counts fees you paid SEPARATELY). */}
        {Math.round(r.incomeTotal) !== 0 && <Row label="Dividends" value={r.incomeTotal} signed />}
        {Math.round(r.expenseTotal) !== 0 && (
          <Row label="Fees paid" hint="loads / switching fees" value={-r.expenseTotal} signed />
        )}
      </section>

      <p className="rb-note muted">
        Switching funds rolls each gain into the new holding's cost basis, so unrealized gain keeps
        resetting. <strong>Total return</strong> instead weighs what you've contributed against
        today's value. Fund fees (TER) are already deducted.
      </p>
    </div>
  );
}

// One row: label (left, with an optional muted hint) and value (right). The ฿
// amount is the column — same size + tabular on every row, right-aligned; an
// optional % sits on a smaller line UNDER it so it never ragged-edges the column.
function Row({
  label,
  hint,
  value,
  pct,
  signed = false,
}: {
  label: string;
  hint?: string;
  value?: number;
  pct?: number | null;
  signed?: boolean;
}) {
  if (value == null) return null;
  const color = signed ? (value >= 0 ? "var(--gain)" : "var(--loss)") : undefined;
  return (
    <div className="rb-row">
      <div className="rb-label">
        <span>{label}</span>
        {hint && <span className="rb-hint">{hint}</span>}
      </div>
      <div className="rb-value">
        <span className="rb-amount" style={color ? { color } : undefined}>
          <PrivateAmount>{signed ? fmtSignedTHB(value) : fmtTHBClean(value)}</PrivateAmount>
        </span>
        {pct != null && (
          <span className="rb-pct" style={color ? { color } : undefined}>
            {fmtPct(pct)}
          </span>
        )}
      </div>
    </div>
  );
}
