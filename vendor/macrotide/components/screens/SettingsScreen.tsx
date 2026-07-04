"use client";

import { useState } from "react";
import { BrokerConnections } from "@/components/screens/BrokerConnections";
import { invalidate, useResource } from "@/lib/fetchers/swr";

export type Theme = "light" | "dark" | "system";

export interface SettingsScreenProps {
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  onBack: () => void;
  /** Open the standalone broker-connect wizard. */
  onConnectBroker: () => void;
}

export function SettingsScreen({
  theme,
  onThemeChange,
  onBack,
  onConnectBroker,
}: SettingsScreenProps) {
  // Source labels the user typed themselves (e.g. "My Bank"), with counts, so they
  // can be renamed in bulk (one rename rewrites every holding using it). Broker-
  // synced labels are excluded here (they live under Connections), so this list is
  // manual-only; the API still returns the managed flag so we can filter them out
  // and detect the all-synced empty state.
  const { data: sourceData } = useResource<{
    sources: { source: string; count: number; managed: boolean }[];
  }>("/api/holdings/source");
  const sources = sourceData?.sources ?? [];
  const [renamingFrom, setRenamingFrom] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);

  const submitRename = async (from: string) => {
    const to = renameTo.trim();
    if (!to || to === from) {
      setRenamingFrom(null);
      return;
    }
    setRenameBusy(true);
    try {
      const res = await fetch("/api/holdings/source", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from, to }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (body?.error === "managed_target") {
          throw new Error(
            `"${to}" is synced from a connection — you can't rename a source into it.`,
          );
        }
        if (body?.error === "managed_source") {
          throw new Error(`"${from}" is synced from a connection and can't be renamed here.`);
        }
        throw new Error(`Failed to rename source (${res.status}).`);
      }
      await invalidate(/^\/api\/holdings/);
      setRenamingFrom(null);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to rename source.");
    } finally {
      setRenameBusy(false);
    }
  };

  // Manual labels only — synced ones live under Connections. hasSynced lets the
  // empty state reassure an all-synced user their broker holdings are over there.
  const manualSources = sources.filter((s) => !s.managed);
  const hasSynced = sources.some((s) => s.managed);

  const renderSourceRow = (
    { source: src, count }: { source: string; count: number },
    i: number,
  ) => (
    <div
      key={src}
      className="row between"
      style={{
        padding: "10px 12px",
        gap: 8,
        borderTop: i === 0 ? undefined : "1px solid var(--line-soft)",
      }}
    >
      {renamingFrom === src ? (
        <>
          <input
            className="mt-select"
            value={renameTo}
            onChange={(e) => setRenameTo(e.target.value)}
            style={{ flex: 1 }}
          />
          <div className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => submitRename(src)}
              disabled={renameBusy}
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setRenamingFrom(null)}
              disabled={renameBusy}
              style={{
                background: "transparent",
                border: 0,
                color: "var(--muted)",
                cursor: "pointer",
                fontSize: 12.5,
                padding: "4px 6px",
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={{ minWidth: 0 }}>
            <div
              className="row"
              style={{ gap: 6, fontSize: 13.5, fontWeight: 500, letterSpacing: "-0.01em" }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {src}
              </span>
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
              {count} holding{count === 1 ? "" : "s"}
            </div>
          </div>
          <button
            className="btn ghost sm"
            onClick={() => {
              setRenamingFrom(src);
              setRenameTo(src);
            }}
          >
            Rename
          </button>
        </>
      )}
    </div>
  );

  const themeOpts = [
    {
      key: "light" as const,
      label: "Light",
      icon: (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ),
    },
    {
      key: "dark" as const,
      label: "Dark",
      icon: (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
        </svg>
      ),
    },
    {
      key: "system" as const,
      label: "System",
      icon: (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </svg>
      ),
    },
  ];

  return (
    <div className="screen">
      <div className="topbar">
        <button className="icon-btn" onClick={onBack} aria-label="Back" style={{ marginRight: 8 }}>
          <svg
            width="13"
            height="13"
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
          <span>Settings</span>
        </div>
      </div>

      <div className="section" style={{ marginTop: 6 }}>
        <div className="section-header">
          <h3>Appearance</h3>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          {themeOpts.map((opt) => (
            <button
              key={opt.key}
              onClick={() => onThemeChange(opt.key)}
              className="card"
              style={{
                padding: "16px 8px",
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                background: theme === opt.key ? "var(--accent-soft)" : "var(--paper)",
                borderColor: theme === opt.key ? "var(--accent)" : "var(--line-soft)",
                borderWidth: theme === opt.key ? 1.5 : 1,
                color: theme === opt.key ? "var(--accent-ink)" : "var(--ink)",
                fontFamily: "var(--font-sans)",
                transition: "all 0.18s",
              }}
            >
              {opt.icon}
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: 500,
                  letterSpacing: "-0.01em",
                }}
              >
                {opt.label}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="section">
        <div className="section-header">
          <h3>Connections</h3>
        </div>
        <BrokerConnections onConnect={onConnectBroker} />
        <div
          style={{
            fontSize: 11.5,
            color: "var(--muted)",
            padding: "10px 4px 0",
            lineHeight: 1.5,
          }}
        >
          Manage your investment plan in{" "}
          <strong style={{ fontWeight: 500, color: "var(--ink-soft)" }}>Journal → Plan</strong>.
        </div>
      </div>

      <div className="section">
        <div className="section-header">
          <h3>Sources</h3>
        </div>
        {manualSources.length === 0 ? (
          <div className="card" style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
            {hasSynced
              ? "Holdings synced from a broker are managed under Connections above. Labels you add yourself will show here."
              : "No manual sources yet. Add a holding and give it a source label to see it here."}
          </div>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            {manualSources.map(renderSourceRow)}
          </div>
        )}
        <div
          style={{
            fontSize: 11.5,
            color: "var(--muted)",
            padding: "10px 4px 0",
            lineHeight: 1.5,
          }}
        >
          Renaming updates the label on every holding that uses it. Synced holdings are managed
          under <strong style={{ fontWeight: 500, color: "var(--ink-soft)" }}>Connections</strong>.
        </div>
      </div>

      <div className="section">
        <div className="section-header">
          <h3>Memory</h3>
        </div>
        <div className="card" style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
          What Advisor remembers about you lives in{" "}
          <strong style={{ fontWeight: 500, color: "var(--ink-soft)" }}>Journal → Memory</strong> —
          review, forget, or ask Advisor to change a memory there.
        </div>
      </div>
    </div>
  );
}
