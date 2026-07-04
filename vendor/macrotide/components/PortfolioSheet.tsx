"use client";

import { iconNames } from "lucide-react/dynamic";
import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";

export interface PortfolioFormValues {
  id: string;
  name: string;
  icon: string;
  color: string;
  notes: string;
}

export interface PortfolioSheetProps {
  open: boolean;
  /** When set, the sheet opens in edit mode pre-filled from these values. */
  initial?: PortfolioFormValues | null;
  onClose: () => void;
  onSave: (values: PortfolioFormValues) => void | Promise<void>;
  /** Only available in edit mode. */
  onDelete?: () => void | Promise<void>;
}

// Curated default set surfaced before the user searches. Names match lucide
// kebab-case so they pass through to DynamicIcon cleanly.
const CURATED_ICONS: string[] = [
  "wallet",
  "piggy-bank",
  "target",
  "shield",
  "trending-up",
  "leaf",
  "rocket",
  "gem",
  "briefcase",
  "landmark",
  "chart-pie",
  "coins",
];

// 30 = 5 rows × 6 cols; fits in view without needing a scrollbar or border.
const MAX_SEARCH_RESULTS = 30;

const DEFAULT_VALUES: PortfolioFormValues = {
  id: "",
  name: "",
  icon: "wallet",
  color: "var(--accent)",
  notes: "",
};

function newId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function PortfolioSheet({ open, initial, onClose, onSave, onDelete }: PortfolioSheetProps) {
  const isEdit = !!initial;
  const [values, setValues] = useState<PortfolioFormValues>(initial ?? DEFAULT_VALUES);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [iconQuery, setIconQuery] = useState("");

  // Re-sync form when opening for a different portfolio.
  useEffect(() => {
    if (open) {
      setValues(initial ?? { ...DEFAULT_VALUES, id: newId() });
      setError(null);
      setIconQuery("");
      setSubmitting(false);
    }
  }, [open, initial]);

  // Search runs against all 1700+ lucide icon names. With no query we show the
  // curated set; otherwise filter by substring and cap at MAX_SEARCH_RESULTS so
  // the grid stays scannable.
  const visibleIcons = useMemo(() => {
    const q = iconQuery.trim().toLowerCase();
    if (!q) return CURATED_ICONS;
    return iconNames.filter((n) => n.includes(q)).slice(0, MAX_SEARCH_RESULTS);
  }, [iconQuery]);

  const update = (patch: Partial<PortfolioFormValues>) => setValues((v) => ({ ...v, ...patch }));

  const submit = async () => {
    if (!values.name.trim()) {
      setError("Name is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSave(values);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  };

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
      <Modal open={open} onClose={onClose} variant="form" labelledBy="ps-title">
        <Modal.Header
          title={isEdit ? "Edit portfolio" : "New portfolio"}
          subtitle={
            isEdit
              ? "Update portfolio details. Changes apply immediately."
              : "A portfolio holds a set of fund positions — e.g. Core, Tax-saving, Experiment."
          }
          id="ps-title"
        />
        <Modal.Body gap={14}>
          <FormRow label="Name">
            <input
              className="sheet-input"
              value={values.name}
              onChange={(e) => update({ name: e.target.value })}
              placeholder="Core"
            />
          </FormRow>

          <FormRow label="Icon">
            <input
              className="sheet-input"
              type="text"
              value={iconQuery}
              onChange={(e) => setIconQuery(e.target.value)}
              placeholder="Search icons (try: target, leaf, chart)"
              style={{ marginBottom: 10 }}
            />
            <div className="icon-grid">
              {visibleIcons.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => update({ icon: key })}
                  aria-label={key}
                  title={key}
                  data-selected={values.icon === key}
                >
                  <Icon name={key} size={20} />
                </button>
              ))}
              {iconQuery && visibleIcons.length === 0 && (
                <div className="icon-grid-empty">No icons match &ldquo;{iconQuery}&rdquo;.</div>
              )}
            </div>
            {iconQuery && visibleIcons.length === MAX_SEARCH_RESULTS && (
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>
                Showing first {MAX_SEARCH_RESULTS} matches. Refine your search to see more.
              </div>
            )}
          </FormRow>

          <FormRow label="Notes" hint="Optional one-liner; shown on the portfolio card.">
            <textarea
              className="sheet-input"
              value={values.notes}
              onChange={(e) => update({ notes: e.target.value })}
              placeholder="Long-term core portfolio. No restrictions."
              rows={3}
              style={{ resize: "vertical", minHeight: 60 }}
            />
          </FormRow>

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
                aria-label="Delete portfolio"
                title="Delete portfolio"
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
            {submitting ? "Saving…" : isEdit ? "Save changes" : "Create portfolio"}
          </button>
        </Modal.Footer>
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete portfolio?"
        message={`Permanently delete "${values.name}" and all of its holdings. This can't be undone.`}
        confirmLabel="Delete portfolio"
        busy={submitting}
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}

function FormRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
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
        }}
      >
        {label.toUpperCase()}
      </div>
      {children}
      {hint && <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 4 }}>{hint}</div>}
    </div>
  );
}
