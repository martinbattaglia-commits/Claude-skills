"use client";

import { useState } from "react";
import { invalidate, useResource } from "@/lib/fetchers/swr";

// Mirrors `lib/db/queries/preferences.ts#Preference` for the slice of fields the
// UI needs. Importing the type directly would pull server code into the client
// bundle, so we restate it here.
interface PreferenceRow {
  id: number;
  category: "user" | "advisor";
  content: string;
  // The longer recall-only detail (never injected). When present, it's the rest
  // of the memory beyond the short `content` hook — shown under the memory here so
  // the whole thing is visible without leaving the page.
  detail?: string | null;
  source: "advisor_tool" | "extracted";
  validFrom: string;
  validUntil: string | null;
  updatedAt: string;
}

interface MemoryResponse {
  active: PreferenceRow[];
  recentlyForgotten: PreferenceRow[];
}

// Two-party taxonomy (docs/explanation/memory.md § Categories).
const CATEGORY_ORDER: PreferenceRow["category"][] = ["user", "advisor"];

const CATEGORY_LABEL: Record<PreferenceRow["category"], string> = {
  user: "About you",
  advisor: "About Advisor",
};

const MEMORY_KEY = "/api/memory/preferences";

// Render a UTC ISO timestamp in the viewer's local time as "YYYY-MM-DD HH:mm".
// Device-local by default (everything renders in the browser's timezone), so no
// region label. Falls back to the raw string on parse error.
function fmtForgottenAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: tz,
  })
    .format(d)
    .replace(",", "");
}

// Memories have no direct edit field by design — a change flows through Advisor
// so it stays concise, consistent, and provenance-tracked (ADR 0006). "Edit"
// opens a NEW chat (so it doesn't land in whatever conversation was open) whose
// first turn is the ADVISOR asking what to change — not a synthesized user
// message. That's deliberate: with no user "go-ahead" on turn 1, the Advisor
// can't edit before the user has actually said what to change; it only acts on
// the reply. The memory's content + recall-only body ride the hidden entry-
// context envelope (attached to that first reply), so the Advisor targets the
// right row via update_preference and sees the full memory — without leaking the
// internal id or the long body into any visible/persisted message.
function askAdvisorToEdit(row: PreferenceRow) {
  // The opener quotes the short `content` line (never the long body) and asks
  // what to change. It's a canned assistant message — deterministic, so it always
  // asks first regardless of model quality.
  const opener = `You'd like to update this saved memory: "${row.content}". What would you like to change?`;
  const context = {
    screen: "journal",
    intent: "edit_memory",
    // Distinctive substring update_preference matches on; the full content also
    // rides the opener above, so a cap here is just a hint.
    subject: row.content,
    // The recall-only detail (when present) — the Advisor sees the whole memory
    // without it ever appearing in a visible/persisted message.
    ...(row.detail?.trim() ? { detail: row.detail } : {}),
  };
  window.dispatchEvent(
    new CustomEvent("ai-prompt", { detail: { opener, context, newChat: true } }),
  );
}

// Browsable, reversible view of everything the Advisor has learned — the
// durable counterpart to the in-chat status line. Forget is reversible (moves
// to "Recently forgotten" for 30 days); edits route through Advisor.
export function MemoryNotes() {
  const { data, isLoading, error } = useResource<MemoryResponse>(MEMORY_KEY);
  const active = data?.active ?? [];
  const recentlyForgotten = data?.recentlyForgotten ?? [];

  const grouped = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    rows: active.filter((p) => p.category === cat),
  })).filter((g) => g.rows.length > 0);

  const handleForget = async (row: PreferenceRow) => {
    // No confirm: forget is reversible. The row moves to "Recently forgotten"
    // (30-day window) with a restore button — that's the undo.
    const res = await fetch(`${MEMORY_KEY}/${row.id}`, { method: "DELETE" });
    if (!res.ok) {
      window.alert(`Failed to forget memory (${res.status})`);
      return;
    }
    await invalidate(MEMORY_KEY);
  };

  const handleRestore = async (row: PreferenceRow) => {
    const res = await fetch(`${MEMORY_KEY}/${row.id}`, { method: "POST" });
    if (!res.ok) {
      window.alert(`Failed to restore memory (${res.status})`);
      return;
    }
    await invalidate(MEMORY_KEY);
  };

  return (
    <div className="section" style={{ marginTop: 0 }}>
      <p
        style={{
          fontSize: 12.5,
          color: "var(--muted)",
          margin: "0 4px 14px",
          lineHeight: 1.5,
        }}
      >
        What Advisor has learned about you, loaded into context at the start of each new chat. To
        change a memory, ask Advisor in chat — edits apply to your next chat, not the current one.
      </p>

      {isLoading && (
        <div className="card" style={{ fontSize: 12.5, color: "var(--muted)" }}>
          Loading saved memories…
        </div>
      )}

      {error && !isLoading && (
        <div className="card" style={{ fontSize: 12.5, color: "var(--loss, #c33)" }}>
          Couldn't load your saved memories. Try refreshing.
        </div>
      )}

      {!isLoading && !error && grouped.length === 0 && (
        <div className="card" style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.55 }}>
          No saved memories yet. Try saying{" "}
          <em style={{ color: "var(--ink-soft)" }}>"remember I prefer concise responses"</em> in
          chat.
        </div>
      )}

      {!isLoading && !error && grouped.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {grouped.map((g) => (
            <div key={g.category}>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  letterSpacing: "0.08em",
                  color: "var(--muted)",
                  textTransform: "uppercase",
                  padding: "0 4px 6px",
                }}
              >
                {CATEGORY_LABEL[g.category]}
              </div>
              <div className="card" style={{ padding: 0 }}>
                {g.rows.map((row, idx) => (
                  <div
                    key={row.id}
                    style={{
                      padding: "11px 14px",
                      borderTop: idx === 0 ? "none" : "1px solid var(--line-soft)",
                    }}
                  >
                    {/* Header row: the memory line + actions, vertically centered.
                        The body (if any) renders BELOW this row at full width, so
                        Edit/✕ stay put when "Show more" expands the body. */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: 13,
                          lineHeight: 1.45,
                          color: "var(--ink)",
                          wordBreak: "break-word",
                        }}
                      >
                        {row.content}
                      </div>
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => askAdvisorToEdit(row)}
                        style={{ flexShrink: 0 }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleForget(row)}
                        aria-label="Forget this memory"
                        title="Forget"
                        style={{
                          background: "transparent",
                          border: 0,
                          color: "var(--muted)",
                          cursor: "pointer",
                          padding: "2px 6px",
                          fontSize: 14,
                          lineHeight: 1,
                          flexShrink: 0,
                        }}
                      >
                        ✕
                      </button>
                    </div>
                    {row.detail && <MemoryBody detail={row.detail} />}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {!isLoading && !error && recentlyForgotten.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              letterSpacing: "0.08em",
              color: "var(--muted)",
              textTransform: "uppercase",
              padding: "0 4px 6px",
            }}
          >
            Recently forgotten · 30 days
          </div>
          <div className="card" style={{ padding: 0 }}>
            {recentlyForgotten.map((row, idx) => (
              <div
                key={row.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "11px 14px",
                  borderTop: idx === 0 ? "none" : "1px solid var(--line-soft)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      lineHeight: 1.45,
                      color: "var(--muted)",
                      wordBreak: "break-word",
                    }}
                  >
                    {row.content}
                  </div>
                  <div
                    style={{
                      marginTop: 4,
                      fontFamily: "var(--font-mono)",
                      fontSize: 10.5,
                      color: "var(--muted)",
                    }}
                  >
                    forgotten {row.validUntil ? fmtForgottenAt(row.validUntil) : "—"}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => handleRestore(row)}
                  style={{ flexShrink: 0 }}
                >
                  Restore
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// The longer recall-only detail, clamped to a few lines with a Show more/less
// toggle so a long memory doesn't dominate the list. Detail is capped at ~4k
// chars upstream (recall-only), so this stays in-list rather than a modal.
function MemoryBody({ detail }: { detail: string }) {
  const [open, setOpen] = useState(false);
  const isLong = detail.length > 180;
  return (
    <div style={{ marginTop: 4 }}>
      <div
        style={{
          fontSize: 12,
          lineHeight: 1.45,
          color: "var(--ink-soft)",
          wordBreak: "break-word",
          whiteSpace: "pre-wrap",
          ...(isLong && !open
            ? {
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical" as const,
                overflow: "hidden",
              }
            : {}),
        }}
      >
        {detail}
      </div>
      {isLong && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={{
            background: "transparent",
            border: 0,
            padding: "2px 0",
            color: "var(--accent)",
            fontSize: 11.5,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
