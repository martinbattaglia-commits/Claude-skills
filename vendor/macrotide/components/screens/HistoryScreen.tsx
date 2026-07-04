"use client";

// HistoryScreen — "The Ledger" (design A · §2). History is a first-class screen,
// never a dialog: a document header, then the whole-portfolio statement. Reached
// from the Portfolio glance; back is a chevron. The Add affordance opens the
// Record flow (the unified importer for now, until the from-zero Record sheet
// lands).

import { HistoryList } from "@/components/history/HistoryList";
import { Icon } from "@/components/Icon";

export interface HistoryScreenProps {
  onBack: () => void;
  onAdd: () => void;
  /** Optional callout above the statement — e.g. the funded-from-cash nudge (#232). */
  notice?: React.ReactNode;
}

export function HistoryScreen({ onBack, onAdd, notice }: HistoryScreenProps) {
  return (
    <div className="screen">
      {/* Topbar content shares the same column width as the body so the back
          chevron and the Add button line up with the content edges. Matches the
          desktop main container (.ra-main-inner) so the inline ledger editor has
          room for its number fields. */}
      <div className="topbar" style={{ paddingLeft: 0, paddingRight: 0 }}>
        <div
          style={{
            flex: "none",
            width: "100%",
            maxWidth: 880,
            margin: "0 auto",
            padding: "0 16px",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <button className="icon-btn" onClick={onBack} aria-label="Back to portfolio">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <div className="brand" style={{ flex: 1 }}>
            <span>History</span>
          </div>
          <button
            className="btn ghost sm"
            onClick={onAdd}
            style={{ gap: 4, borderColor: "var(--accent)", color: "var(--accent)" }}
          >
            <Icon name="plus" size={12} /> Add
          </button>
        </div>
      </div>

      <div style={{ padding: "4px 16px 40px", maxWidth: 880, margin: "0 auto" }}>
        {notice}
        <p style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5, margin: "4px 8px 14px" }}>
          Everything you’ve recorded, most recent first. Tap any line to edit it in place.
        </p>
        <HistoryList showRecap onAddEntry={onAdd} />
      </div>
    </div>
  );
}
