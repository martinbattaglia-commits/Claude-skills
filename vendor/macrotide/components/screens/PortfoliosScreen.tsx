"use client";

// PortfoliosScreen — the phone full-page portfolios manager (the dock
// PortfoliosPanel has no home on the mobile shell, which has no right dock).
// Same list/reorder/edit/new as the panel via the shared PortfoliosList;
// picking a bucket activates it and pops back to the portfolio view.

import { PortfoliosList } from "@/components/AppPanels";

export interface PortfoliosScreenProps {
  onBack: () => void;
}

export function PortfoliosScreen({ onBack }: PortfoliosScreenProps) {
  return (
    <div className="screen">
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
            <span>Portfolios</span>
          </div>
        </div>
      </div>
      <div style={{ width: "100%", maxWidth: 880, margin: "0 auto", padding: "8px 16px 24px" }}>
        <PortfoliosList onAfterSelect={onBack} />
      </div>
    </div>
  );
}
