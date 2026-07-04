"use client";

import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { Combobox } from "@/components/ui/Combobox";
import { mergeCashPurposes } from "@/lib/data/cash-purposes";
import { mergeSourceSuggestions } from "@/lib/data/sources";
import type { ShareClassListItem } from "@/lib/db/queries/funds";
import type { UsSecurity } from "@/lib/db/queries/us-securities";
import { saveEarmark, useEarmarks, useHoldings } from "@/lib/fetchers/portfolio";
import { useResource } from "@/lib/fetchers/swr";
import { fmtNum, fmtTHBClean } from "@/lib/format";
import { QUOTE_SOURCE_LABELS, QUOTE_SOURCES, type QuoteSource } from "@/lib/market/sources";
import { cleanUsSecurityName } from "@/lib/market/us-security-name";
import type { AssetClass } from "@/lib/static/types";

export interface HoldingFormValues {
  bucketId: string;
  ticker: string;
  thaiName: string;
  englishName: string;
  category: string;
  assetClass: AssetClass;
  region: string;
  units: number;
  avgCost: number;
  ter: number;
  source: string;
  /** Which provider serves this holding's NAV/price. */
  quoteSource: QuoteSource;
}

export interface HoldingSheetProps {
  open: boolean;
  /** DB id when editing; absent when creating. */
  holdingId?: number;
  initial: HoldingFormValues;
  /** When editing, true if the ticker should be locked. */
  lockTicker?: boolean;
  /** Broker name when this holding is synced from a connection. Locks the Source
   * label (the connection owns it) and explains why. */
  syncedBroker?: string | null;
  /** Optional list of buckets so the user can move a holding between them. */
  bucketOptions?: { id: string; name: string }[];
  onClose: () => void;
  onSave: (values: HoldingFormValues) => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
}

const ASSET_CLASSES: { value: AssetClass; label: string }[] = [
  { value: "equity", label: "Equity" },
  { value: "bond", label: "Bond" },
  { value: "mixed", label: "Mixed" },
  { value: "alternative", label: "Alternative" },
  { value: "cash", label: "Cash" },
  { value: "unknown", label: "Unclassified" },
];

export function HoldingSheet({
  open,
  holdingId,
  initial,
  lockTicker = false,
  syncedBroker,
  bucketOptions,
  onClose,
  onSave,
  onDelete,
}: HoldingSheetProps) {
  const isEdit = holdingId !== undefined;
  const synced = !!syncedBroker;
  const [values, setValues] = useState<HoldingFormValues>(initial);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmPromote, setConfirmPromote] = useState(false);
  // Free-text source label, with suggestions from the user's existing sources.
  const { data: allHoldings } = useHoldings();
  const sourceOptions = mergeSourceSuggestions((allHoldings ?? []).map((h) => h.source));

  // Is this symbol a fund we have in the SSOT catalog? If so, its name/class/etc.
  // come from there — they're locked; only Portfolio + Source stay editable. A
  // custom (off-catalog) asset stays fully editable.
  const q = values.ticker.trim();
  const { data: catalogMatches } = useResource<{ items: ShareClassListItem[]; total: number }>(
    q.length >= 2 ? `/api/fund-classes?query=${encodeURIComponent(q)}&limit=8` : null,
  );
  const catalogMatch = (catalogMatches?.items ?? []).find(
    (m) => m.ticker.trim().toUpperCase() === q.toUpperCase(),
  );
  const known = !!catalogMatch;
  // Promote: a custom (manual-priced) holding whose symbol now matches the
  // catalog should adopt the fund's official details + live price.
  const canPromote = known && values.quoteSource === "manual";

  // Is this a recognized US-listed stock / ETF? When the user picks the
  // "Stock / ETF / Index" source and types a known symbol, autofill its official
  // name + asset class from the us_securities catalog. Skipped for a Thai
  // catalog match (that path owns the row) and for cash.
  const wantUsLookup = values.quoteSource === "market" && q.length >= 1 && !known && !isEdit;
  const { data: usMatches } = useResource<{ items: UsSecurity[]; total: number }>(
    wantUsLookup ? `/api/us-securities?query=${encodeURIComponent(q)}&limit=8` : null,
  );
  const usMatch = (usMatches?.items ?? []).find(
    (m) => m.symbol.trim().toUpperCase() === q.toUpperCase(),
  );

  // Autofill name + asset class from a recognized US security WITHOUT clobbering
  // anything the user already typed (blank name → official name; "unknown" class
  // → equity). Keyed on the matched symbol so it fires once per resolution.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire once per matched symbol; setValues reads the latest values
  useEffect(() => {
    if (!usMatch) return;
    setValues((v) => {
      if (v.quoteSource !== "market") return v;
      const patch: Partial<HoldingFormValues> = {};
      if (!v.englishName.trim()) patch.englishName = cleanUsSecurityName(usMatch.name);
      if (v.assetClass === "unknown") patch.assetClass = "equity";
      return Object.keys(patch).length > 0 ? { ...v, ...patch } : v;
    });
  }, [usMatch?.symbol]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: initial is intentionally captured only on open; the parent recreates it while the sheet is open.
  useEffect(() => {
    if (open) {
      setValues(initial);
      setError(null);
      setSubmitting(false);
    }
    // initial intentionally captured at open time — avoids re-rendering as parent re-renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const update = (patch: Partial<HoldingFormValues>) => setValues((v) => ({ ...v, ...patch }));

  // ── Cash Purpose (#149): per-account Role + optional Label, stored as an earmark.
  const isCash = values.quoteSource === "cash";
  const { data: earmarks } = useEarmarks();
  const mark = (earmarks ?? []).find(
    (e) =>
      e.scope === "account" &&
      e.bucketId === values.bucketId &&
      (e.ticker ?? "").toUpperCase() === values.ticker.trim().toUpperCase(),
  );
  const [cashRole, setCashRole] = useState<"investable" | "reserved">("investable");
  const [cashLabel, setCashLabel] = useState("");
  // Seed the controls from the stored designation when the sheet opens (or once the
  // earmark resolves), matching the values reset above.
  // biome-ignore lint/correctness/useExhaustiveDependencies: seed on open / when the row's mark first resolves
  useEffect(() => {
    if (!open) return;
    setCashRole((mark?.role as "investable" | "reserved") ?? "investable");
    setCashLabel(mark?.purpose ?? "");
  }, [open, mark?.id]);
  // Label suggestions = the user's used labels + curated presets; Account suggestions =
  // the cash accounts they already track.
  const purposeOptions = mergeCashPurposes((earmarks ?? []).map((e) => e.purpose));
  const cashAccounts = [
    ...new Set(
      (allHoldings ?? [])
        .filter((h) => h.quoteSource === "cash")
        .map((h) => h.englishName || h.ticker),
    ),
  ];

  const doSave = async (vals: HoldingFormValues) => {
    setSubmitting(true);
    setError(null);
    try {
      await onSave(vals);
      // Persist the cash Purpose alongside the holding (a no-op designation DELETEs).
      if (vals.quoteSource === "cash") {
        await saveEarmark({
          bucketId: vals.bucketId,
          ticker: vals.ticker,
          role: cashRole,
          amount: null, // "All" for a reserved account; ignored when investable
          purpose: cashLabel,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  };

  const submit = async () => {
    if (!values.ticker.trim()) {
      setError(isCash ? "Account name is required" : "Symbol is required");
      return;
    }
    if (!values.bucketId) {
      setError("Portfolio is required");
      return;
    }
    // A cash account has no fund name / cost basis to validate — its balance comes
    // from the ledger (Set balance), not this form.
    if (!isCash) {
      if (!values.englishName.trim()) {
        setError("Name is required");
        return;
      }
      if (!Number.isFinite(values.units) || values.units <= 0) {
        setError("Quantity must be a positive number");
        return;
      }
    }
    // A custom asset whose symbol now matches the catalog → confirm promotion.
    if (canPromote) {
      setConfirmPromote(true);
      return;
    }
    await doSave(values);
  };

  // Adopt the catalog fund: switch to its live-priced source + official name,
  // keeping the user's units and cost. editHoldingViaLedger re-tickers the ledger
  // (and the projection merges if the fund is already held).
  const promote = () =>
    doSave({
      ...values,
      quoteSource: "thai_mutual_fund",
      englishName: catalogMatch?.englishName || values.englishName,
      thaiName: catalogMatch?.thaiName || values.thaiName,
    });

  const handleDelete = async () => {
    if (!onDelete) return;
    setSubmitting(true);
    try {
      await onDelete();
      setConfirmDelete(false);
      setSubmitting(false);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
      setSubmitting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <>
      <Modal open={open} onClose={onClose} variant="form" labelledBy="hs-title">
        <Modal.Header
          title={isCash ? "Edit cash account" : isEdit ? "Edit holding" : "Add holding"}
          subtitle={
            isCash
              ? "Rename the account, set its purpose, or move it to another portfolio."
              : isEdit
                ? "Update quantity, cost basis, or move to another portfolio."
                : "Add a single holding. Use the import sheet for multiple at once."
          }
          id="hs-title"
        />
        <Modal.Body gap={14}>
          {isCash ? (
            <FormRow label="Type" locked>
              {/* A cash account is just cash, locked, no price source / asset class. */}
              <input className="sheet-input" value="Cash" disabled />
            </FormRow>
          ) : (
            <FormRow
              label="Type"
              locked={lockTicker || known}
              hint="Determines where we fetch this holding's price"
            >
              <select
                className="sheet-input"
                value={values.quoteSource}
                onChange={(e) => update({ quoteSource: e.target.value as QuoteSource })}
                disabled={lockTicker || known}
              >
                {/* Cash is entered through the transactions sheet (deposit / cash
                    balance), not as a fund holding — keep it out of this picker. */}
                {QUOTE_SOURCES.filter((s) => s !== "cash").map((s) => (
                  <option key={s} value={s}>
                    {QUOTE_SOURCE_LABELS[s]}
                  </option>
                ))}
              </select>
            </FormRow>
          )}

          <FormRow label={isCash ? "Account" : "Symbol"} locked={!isCash && (lockTicker || known)}>
            {isCash ? (
              // Always renameable (the rename cascades the ledger + earmark); Combobox
              // suggests the cash accounts you already track, matching the Add modal.
              <Combobox<string>
                // The cash account NAME is the ticker, kept in the user's case (#235).
                value={values.englishName || values.ticker}
                onChange={(text) => update({ englishName: text, ticker: text.trim() })}
                onPick={(s) => update({ englishName: s, ticker: s.trim() })}
                items={cashAccounts}
                getKey={(s) => s}
                renderItem={(s) => s}
                label="Cash account"
                placeholder="e.g. SCB Savings"
                inputClassName="sheet-input"
              />
            ) : (
              <input
                className="sheet-input"
                value={values.ticker}
                // Keep the typed case (#235): a cataloged fund is normalized to the
                // official catalog case on save; a custom symbol keeps what you type.
                onChange={(e) => update({ ticker: e.target.value })}
                disabled={lockTicker || known}
                placeholder="Symbol"
              />
            )}
          </FormRow>

          {known && (
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
                padding: "9px 12px",
                borderRadius: 8,
                background: "var(--accent-soft)",
                fontSize: 12,
                lineHeight: 1.45,
                color: "var(--accent-ink)",
              }}
            >
              <Icon name="info" size={14} />
              <span>
                We track this fund — its name, details, and price come from our data. You can still
                move it between portfolios and edit the source.
              </span>
            </div>
          )}

          {usMatch && !known && (
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
                padding: "9px 12px",
                borderRadius: 8,
                background: "var(--accent-soft)",
                fontSize: 12,
                lineHeight: 1.45,
                color: "var(--accent-ink)",
              }}
            >
              <Icon name="check" size={14} />
              <span>
                Recognized: {cleanUsSecurityName(usMatch.name)} —{" "}
                {usMatch.securityType === "etf" ? "ETF" : "Stock"}
                {usMatch.exchange ? ` · ${usMatch.exchange}` : ""}. Priced in {usMatch.currency},
                shown in THB. We filled the name for you.
              </span>
            </div>
          )}

          {!isCash && (
            <>
              <FormRow label="Name (English)" locked={known}>
                <input
                  className="sheet-input"
                  value={values.englishName}
                  onChange={(e) => update({ englishName: e.target.value })}
                  placeholder="SCB S&P 500 Index Fund"
                  disabled={known}
                />
              </FormRow>

              <FormRow label="Name (Thai)" locked={known} hint="Optional">
                <input
                  className="sheet-input"
                  value={values.thaiName}
                  onChange={(e) => update({ thaiName: e.target.value })}
                  placeholder="เอสซีบี เอสแอนด์พี 500"
                  disabled={known}
                />
              </FormRow>
            </>
          )}

          {bucketOptions && bucketOptions.length > 0 && (
            <FormRow label="Portfolio">
              <select
                className="sheet-input"
                value={values.bucketId}
                onChange={(e) => update({ bucketId: e.target.value })}
              >
                {bucketOptions.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </FormRow>
          )}

          {!isCash &&
            (isEdit ? (
              // Quantity + cost are DERIVED from the ledger (ADR 0004) — they aren't facts
              // this form owns. Editing the aggregate here would mean writing a synthetic
              // snapshot and, for a foreign holding, un-blending an averaged THB basis with
              // no single native rate. So show them read-only and send people to History,
              // where the underlying trades (and their native currency) are edited exactly.
              <div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <FormRow label="Quantity" locked hint="Edit in History">
                    <input
                      className="sheet-input"
                      value={Number.isFinite(values.units) ? fmtNum(values.units, 4) : ""}
                      disabled
                    />
                  </FormRow>
                  <FormRow label="Avg cost" locked hint="THB per unit/share">
                    <input
                      className="sheet-input"
                      value={
                        Number.isFinite(values.avgCost) && values.avgCost > 0
                          ? fmtTHBClean(values.avgCost, 2)
                          : ""
                      }
                      disabled
                    />
                  </FormRow>
                </div>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FormRow label="Quantity" locked={known}>
                  <input
                    className="sheet-input"
                    type="number"
                    step="0.0001"
                    value={Number.isFinite(values.units) ? values.units : ""}
                    onChange={(e) => update({ units: Number.parseFloat(e.target.value) || 0 })}
                    placeholder="0"
                    disabled={known}
                  />
                </FormRow>
                <FormRow label="Avg cost" locked={known} hint="THB per unit/share">
                  <input
                    className="sheet-input"
                    type="number"
                    step="0.01"
                    value={Number.isFinite(values.avgCost) ? values.avgCost : ""}
                    onChange={(e) => update({ avgCost: Number.parseFloat(e.target.value) || 0 })}
                    placeholder="0"
                    disabled={known}
                  />
                </FormRow>
              </div>
            ))}

          {isCash ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <FormRow
                label="Purpose"
                hint="Investable counts toward your return %. Reserved sits out."
              >
                <select
                  className="sheet-input"
                  value={cashRole}
                  onChange={(e) => setCashRole(e.target.value as "investable" | "reserved")}
                >
                  <option value="investable">Investable</option>
                  <option value="reserved">Reserved</option>
                </select>
              </FormRow>
              <FormRow label="Label" hint="Optional objective">
                <Combobox<string>
                  value={cashLabel}
                  onChange={setCashLabel}
                  onPick={setCashLabel}
                  items={purposeOptions}
                  getKey={(s) => s}
                  renderItem={(s) => s}
                  label="Cash purpose label"
                  placeholder="e.g. Emergency"
                  inputClassName="sheet-input"
                />
              </FormRow>
            </div>
          ) : null}

          {!isCash && (
            <>
              <FormRow label="Asset class" locked={known}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {ASSET_CLASSES.map((a) => (
                    <button
                      key={a.value}
                      type="button"
                      onClick={() => update({ assetClass: a.value })}
                      disabled={known}
                      style={{
                        padding: "6px 12px",
                        borderRadius: 8,
                        border: "1px solid",
                        borderColor:
                          values.assetClass === a.value ? "var(--accent)" : "var(--line-soft)",
                        background:
                          values.assetClass === a.value ? "var(--accent-soft)" : "var(--paper)",
                        fontSize: 12.5,
                        cursor: known ? "not-allowed" : "pointer",
                        opacity: known && values.assetClass !== a.value ? 0.5 : 1,
                      }}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </FormRow>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FormRow label="Category" locked={known} hint="e.g. US Equity">
                  <input
                    className="sheet-input"
                    value={values.category}
                    onChange={(e) => update({ category: e.target.value })}
                    placeholder="US Equity"
                    disabled={known}
                  />
                </FormRow>
                <FormRow label="Region" locked={known} hint="US / TH / Global / EM">
                  <input
                    className="sheet-input"
                    value={values.region}
                    onChange={(e) => update({ region: e.target.value })}
                    placeholder="US"
                    disabled={known}
                  />
                </FormRow>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FormRow label="TER (%)" locked={known} hint="Annual expense ratio">
                  <input
                    className="sheet-input"
                    type="number"
                    step="0.01"
                    value={Number.isFinite(values.ter) ? values.ter : ""}
                    onChange={(e) => update({ ter: Number.parseFloat(e.target.value) || 0 })}
                    placeholder="0.45"
                    disabled={known}
                  />
                </FormRow>
                <FormRow
                  label="Source"
                  locked={synced}
                  hint={synced ? `Synced from ${syncedBroker}` : "Where this came from"}
                >
                  <input
                    className="sheet-input"
                    list="edit-source-suggestions"
                    value={values.source}
                    onChange={(e) => update({ source: e.target.value })}
                    placeholder="Type or pick a source"
                    disabled={synced}
                  />
                  {!synced && (
                    <datalist id="edit-source-suggestions">
                      {sourceOptions.map((s) => (
                        <option key={s} value={s} />
                      ))}
                    </datalist>
                  )}
                </FormRow>
              </div>
            </>
          )}

          {error && (
            <div
              style={{
                color: "var(--loss)",
                fontSize: 12.5,
                padding: "8px 12px",
                background: "var(--loss-soft, rgba(220,38,38,0.08))",
                borderRadius: 8,
              }}
            >
              {error}
            </div>
          )}
        </Modal.Body>
        <Modal.Footer
          start={
            isEdit && onDelete ? (
              <button
                type="button"
                className="icon-btn btn-delete"
                onClick={() => setConfirmDelete(true)}
                disabled={submitting}
                aria-label="Delete holding"
                title="Delete holding"
                style={{ color: "var(--loss)" }}
              >
                <Icon name="trash-2" size={16} />
                <span className="btn-delete-label">Delete</span>
              </button>
            ) : undefined
          }
        >
          <button type="button" className="btn ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={submit} disabled={submitting}>
            {submitting ? "Saving…" : isEdit ? "Save changes" : "Add holding"}
          </button>
        </Modal.Footer>
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete holding?"
        message={`Remove ${values.ticker || "this holding"} from this portfolio. This can't be undone.`}
        confirmLabel="Delete holding"
        busy={submitting}
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />

      <ConfirmDialog
        open={confirmPromote}
        title={`This looks like ${catalogMatch?.ticker ?? values.ticker}`}
        message={`We track ${catalogMatch?.englishName || catalogMatch?.ticker || "this fund"}. Use its official details and live price? Your units and cost stay; the price you entered is replaced by the live NAV.`}
        confirmLabel="Use the fund"
        busy={submitting}
        onConfirm={promote}
        onCancel={() => setConfirmPromote(false)}
      />
    </>
  );
}

function FormRow({
  label,
  hint,
  locked,
  children,
}: {
  label: string;
  hint?: string;
  /** Show a lock icon by the label — the explicit "you can't edit this here" cue that a
   * disabled field needs, since this form's editable fields are grey-filled (so a dimmed
   * field can't lean on the usual "grey = disabled" read). */
  locked?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          color: "var(--muted)",
          letterSpacing: "0.04em",
          marginBottom: 6,
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        {label.toUpperCase()}
        {locked && <Icon name="lock" size={10} />}
      </div>
      {children}
      {hint && <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 4 }}>{hint}</div>}
    </div>
  );
}
