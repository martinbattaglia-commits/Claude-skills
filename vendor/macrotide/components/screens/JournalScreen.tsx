"use client";

import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ModelDonut } from "@/components/charts";
import { Icon } from "@/components/Icon";
import { MemoryNotes } from "@/components/MemoryNotes";
import { Modal } from "@/components/Modal";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { authClient } from "@/lib/auth/client";
import { useJournalView, useModelPortfoliosView, useSelectedModelId } from "@/lib/fetchers/legacy";
import { usePlan } from "@/lib/fetchers/portfolio";
import { invalidate } from "@/lib/fetchers/swr";
import { fmtRelativeDate } from "@/lib/format";
import {
  parseBullets,
  parseCommitments,
  parsePlan,
  parseQuestions,
} from "@/lib/portfolio/plan-parser";
import type { ModelPortfolio, Note, ReadingItem } from "@/lib/static/types";
import { onActivate } from "@/lib/ui-events";

export type JournalTab = "plan" | "notes" | "memory" | "models" | "reading";

export interface JournalScreenProps {
  onOpenChat: () => void;
  onOpenModels: () => void;
  onOpenSettings: () => void;
  /** Show the top-right kebab that opens the account menu (mobile only). */
  showMenu?: boolean;
  /** Deep-link the screen to a subtab (e.g. from the chat memory chip). */
  initialTab?: JournalTab | null;
  /** Called once `initialTab` has been applied so the parent can clear it. */
  onTabConsumed?: () => void;
}

export function JournalScreen({
  onOpenChat,
  onOpenModels,
  onOpenSettings,
  showMenu = true,
  initialTab,
  onTabConsumed,
}: JournalScreenProps) {
  const [tab, setTab] = useState<JournalTab>("plan");
  // Apply a deep-link (e.g. the chat "view in Memory" chevron) then clear it.
  useEffect(() => {
    if (initialTab) {
      setTab(initialTab);
      onTabConsumed?.();
    }
  }, [initialTab, onTabConsumed]);
  const { journal } = useJournalView();
  // No better-auth user ⇒ demo / AUTH_DISABLED session. Real accounts don't
  // get the "DEMO" chip.
  const isDemo = !authClient.useSession().data?.user;

  return (
    <div className="screen">
      <div className="topbar">
        <div className="brand" style={{ flex: 1 }}>
          <span>Journal</span>
          {isDemo && <span className="brand-chip">DEMO</span>}
        </div>
        {showMenu && (
          <button className="icon-btn" aria-label="More" onClick={onOpenSettings}>
            <Icon name="ellipsis-vertical" size={13} />
          </button>
        )}
      </div>

      <div className="sub-tabs">
        {(
          [
            { id: "plan", label: "Plan" },
            { id: "notes", label: "Notes" },
            { id: "memory", label: "Memory" },
            { id: "models", label: "Templates" },
            { id: "reading", label: "Reading" },
          ] as { id: JournalTab; label: string }[]
        ).map((t) => (
          <button key={t.id} data-active={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "plan" && <JournalPlan onOpenModels={onOpenModels} onOpenChat={onOpenChat} />}
      {tab === "notes" && <JournalNotes notes={journal?.notes ?? []} />}
      {tab === "memory" && <MemoryNotes />}
      {tab === "models" && (
        <JournalModels saved={journal?.savedModels ?? []} onOpenModels={onOpenModels} />
      )}
      {tab === "reading" && <JournalReading reading={journal?.reading ?? []} />}
    </div>
  );
}

function JournalPlan({
  onOpenModels,
  onOpenChat,
}: {
  onOpenModels: () => void;
  onOpenChat: () => void;
}) {
  const [editorOpen, setEditorOpen] = useState(false);
  const { data: plan, isLoading: planLoading } = usePlan();
  const { models } = useModelPortfoliosView();
  const planSelectedModelId = useSelectedModelId();

  const markdown = plan?.markdown ?? "";
  const parsed = useMemo(() => parsePlan(markdown), [markdown]);
  const targetModel = models?.find((m) => m.id === planSelectedModelId);

  // Returns success so the editor can stay open (draft intact) on failure.
  const savePlan = async (md: string): Promise<boolean> => {
    try {
      const res = await fetch("/api/plan", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown: md, selectedModelId: plan?.selectedModelId ?? null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      invalidate("/api/plan");
      setEditorOpen(false);
      return true;
    } catch (err) {
      console.error("Failed to save plan:", err);
      return false;
    }
  };

  if (planLoading) {
    return (
      <div className="section" style={{ marginTop: 0 }}>
        <SkeletonRows rows={3} height={64} padding="12px 0" />
      </div>
    );
  }

  const isEmpty = !markdown.trim();

  if (isEmpty) {
    return (
      <div>
        <div className="section" style={{ marginTop: 0 }}>
          <div className="card" style={{ padding: "32px 20px", textAlign: "center" }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>📋</div>
            <div
              style={{
                fontSize: 16,
                fontWeight: 500,
                letterSpacing: "-0.02em",
                marginBottom: 6,
              }}
            >
              Your plan is empty
            </div>
            <div
              style={{
                fontSize: 13,
                color: "var(--muted)",
                lineHeight: 1.5,
                marginBottom: 20,
                maxWidth: 280,
                margin: "0 auto 20px",
              }}
            >
              A short brief about what you care about, your target allocation, and rules you set for
              yourself. The advisor reads it before every conversation.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button className="btn primary" onClick={() => setEditorOpen(true)}>
                <Icon name="plus" size={13} /> Write your plan
              </button>
              <button className="btn ghost" onClick={onOpenChat}>
                <Icon name="chat" size={13} /> Build with advisor
              </button>
            </div>
          </div>
        </div>

        <PlanEditorSheet
          open={editorOpen}
          initial={markdown}
          onClose={() => setEditorOpen(false)}
          onSave={savePlan}
        />
      </div>
    );
  }

  return (
    <div>
      <div className="section" style={{ marginTop: 0 }}>
        <div className="row between" style={{ padding: "0 4px", marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 500, letterSpacing: "-0.02em" }}>Your plan</div>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--muted)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {plan?.updatedAt ? `Updated ${fmtRelativeDate(plan.updatedAt)}` : "Not saved yet"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn ghost sm" onClick={() => setEditorOpen(true)}>
              <Icon name="settings" size={12} /> Edit
            </button>
            <button className="btn ghost sm" onClick={onOpenChat}>
              <Icon name="chat" size={12} /> Ask AI
            </button>
          </div>
        </div>

        <PlanSpineCard
          label="TARGET"
          body={parsed.spine.target}
          model={targetModel}
          onAdd={() => setEditorOpen(true)}
          onBrowse={onOpenModels}
        />
        <PlanSpineCard
          label="PRINCIPLES"
          body={parsed.spine.principles}
          kind="bullets"
          onAdd={() => setEditorOpen(true)}
        />
        <PlanSpineCard
          label="RISK"
          body={parsed.spine.risk}
          kind="quote"
          onAdd={() => setEditorOpen(true)}
        />
        <PlanSpineCard
          label="COMMITMENTS"
          body={parsed.spine.commitments}
          kind="checklist"
          onAdd={() => setEditorOpen(true)}
        />

        {parsed.extras.map((ext, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: markdown-parsed sections — titles can repeat, list fully re-renders on edit
          <PlanExtraCard key={i} title={ext.title} body={ext.body} />
        ))}
      </div>

      <PlanEditorSheet
        open={editorOpen}
        initial={markdown}
        onClose={() => setEditorOpen(false)}
        onSave={savePlan}
      />
    </div>
  );
}

function PlanSpineCard({
  label,
  body,
  kind = "prose",
  model,
  onAdd,
  onBrowse,
}: {
  label: string;
  body: string | null;
  kind?: "prose" | "bullets" | "quote" | "checklist";
  model?: ModelPortfolio;
  onAdd: () => void;
  onBrowse?: () => void;
}) {
  if (!body?.trim()) {
    return (
      <div
        {...onActivate(onAdd)}
        style={{
          background: "transparent",
          border: "1.5px dashed var(--line)",
          borderRadius: 14,
          padding: 14,
          marginBottom: 8,
          cursor: "pointer",
          color: "var(--muted)",
        }}
      >
        <div
          style={{
            fontSize: 9.5,
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.04em",
            marginBottom: 6,
          }}
        >
          ○ {label}
        </div>
        <div
          style={{
            fontSize: 13,
            color: "var(--muted)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Icon name="plus" size={12} /> Add a {label.toLowerCase()} section
        </div>
      </div>
    );
  }

  if (kind === "checklist") {
    const items = parseCommitments(body);
    return (
      <SpineCardShell label={label}>
        <div className="stack-sm">
          {items.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: markdown-parsed lines — content can repeat, list fully re-renders on edit
            <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 4,
                  marginTop: 1,
                  flexShrink: 0,
                  border: "1.5px solid var(--amber)",
                  background: "color-mix(in oklab, var(--amber) 20%, transparent)",
                }}
              ></span>
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 13,
                  lineHeight: 1.4,
                  color: "var(--ink)",
                }}
              >
                {c.text}
              </div>
            </div>
          ))}
        </div>
      </SpineCardShell>
    );
  }

  if (kind === "bullets") {
    const items = parseBullets(body);
    if (items.length > 0) {
      return (
        <SpineCardShell label={label}>
          <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {items.map((b, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: markdown-parsed lines — content can repeat, list fully re-renders on edit
                key={i}
                style={{
                  fontSize: 13,
                  lineHeight: 1.5,
                  padding: "5px 0",
                  display: "grid",
                  gridTemplateColumns: "12px 1fr",
                  gap: 8,
                }}
              >
                <span style={{ color: "var(--accent)", paddingTop: 1 }}>·</span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </SpineCardShell>
      );
    }
  }

  if (kind === "quote") {
    return (
      <SpineCardShell label={label}>
        <div
          style={{
            fontSize: 14,
            lineHeight: 1.5,
            fontStyle: "italic",
            color: "var(--ink)",
            paddingLeft: 12,
            borderLeft: "3px solid var(--accent)",
            letterSpacing: "-0.005em",
          }}
        >
          {body}
        </div>
      </SpineCardShell>
    );
  }

  if (label === "TARGET" && model) {
    return (
      <SpineCardShell label={label}>
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            marginBottom: 10,
          }}
        >
          <ModelDonut mix={model.mix} size={48} thickness={7} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 500,
                letterSpacing: "-0.01em",
                marginBottom: 2,
              }}
            >
              {model.name}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.35 }}>
              {model.mix.map((m) => `${m.pct}% ${m.label}`).join(" · ")}
            </div>
          </div>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.5 }}>{body}</div>
        {onBrowse && (
          <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={onBrowse}>
            Browse other models →
          </button>
        )}
      </SpineCardShell>
    );
  }

  return (
    <SpineCardShell label={label}>
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.5,
          color: "var(--ink)",
          whiteSpace: "pre-wrap",
        }}
      >
        {body}
      </div>
    </SpineCardShell>
  );
}

function SpineCardShell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ marginBottom: 8, padding: 14 }}>
      <div
        style={{
          fontSize: 9.5,
          fontFamily: "var(--font-mono)",
          color: "var(--accent-ink)",
          letterSpacing: "0.04em",
          marginBottom: 8,
        }}
      >
        ● {label}
      </div>
      {children}
    </div>
  );
}

function PlanExtraCard({ title, body }: { title: string; body: string }) {
  const isQuestions = title.toLowerCase().includes("question");
  if (isQuestions) {
    const qs = parseQuestions(body);
    return (
      <div className="card" style={{ marginBottom: 8, padding: 14 }}>
        <div
          style={{
            fontSize: 9.5,
            fontFamily: "var(--font-mono)",
            color: "var(--muted)",
            letterSpacing: "0.04em",
            marginBottom: 8,
          }}
        >
          ○ {title.toUpperCase()}
        </div>
        <div className="stack-sm">
          {qs.map((q, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: markdown-parsed lines — content can repeat, list fully re-renders on edit
              key={i}
              {...onActivate(() =>
                window.dispatchEvent(new CustomEvent("ai-prompt", { detail: q })),
              )}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                borderRadius: 8,
                background: "var(--card-soft)",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              <span style={{ color: "var(--accent)", fontWeight: 500 }}>?</span>
              <span style={{ flex: 1 }}>{q}</span>
              <span
                style={{
                  fontSize: 10.5,
                  color: "var(--accent-ink)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                ASK AI →
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 8, padding: 14 }}>
      <div
        style={{
          fontSize: 9.5,
          fontFamily: "var(--font-mono)",
          color: "var(--muted)",
          letterSpacing: "0.04em",
          marginBottom: 8,
        }}
      >
        ○ {title.toUpperCase()}
      </div>
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.5,
          color: "var(--ink-soft)",
          whiteSpace: "pre-wrap",
        }}
      >
        {body}
      </div>
    </div>
  );
}

function PlanEditorSheet({
  open,
  initial,
  onClose,
  onSave,
}: {
  open: boolean;
  initial: string;
  onClose: () => void;
  onSave: (md: string) => Promise<boolean>;
}) {
  const [text, setText] = useState(initial || "");
  const [saveFailed, setSaveFailed] = useState(false);

  // Re-sync the draft when (re)opening so the editor reflects the latest plan.
  // Deliberately NOT keyed on `initial`: an SWR revalidation while the editor
  // is open must not clobber the user's unsaved draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on the open transition
  useEffect(() => {
    if (open) {
      setText(initial || "");
      setSaveFailed(false);
    }
  }, [open]);

  // A failed save keeps the editor open with the draft intact — closing it
  // would silently discard the user's edits.
  const handleSave = async () => {
    setSaveFailed(false);
    const ok = await onSave(text);
    if (!ok) setSaveFailed(true);
  };

  const placeholder = `## Target
Bogleheads 3-Fund: 50% US, 30% International, 20% Bonds.

## Principles
- Low fees
- Global diversification
- Boring works

## Risk
Comfortable with 20% drawdowns. Won't sell.

## Commitments
- Rebalance when drift > 7pp
- No active funds`;

  const insertSection = (heading: string) => {
    setText(`${text}\n\n## ${heading}\n`);
  };

  return (
    <Modal open={open} onClose={onClose} variant="form" labelledBy="plan-editor-title">
      <Modal.Header
        title="Edit your plan"
        subtitle={
          <>
            Free-form. Use <code>## Heading</code> for sections. The advisor reads this before every
            conversation.
          </>
        }
        id="plan-editor-title"
        action={
          <span
            style={{
              fontSize: 11,
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            MARKDOWN
          </span>
        }
      />
      <Modal.Body gap={10}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          className="sheet-input"
          style={{
            minHeight: 280,
            fontFamily: "var(--font-mono)",
            fontSize: 12.5,
            lineHeight: 1.5,
          }}
        />

        <div>
          <div
            style={{
              fontSize: 11,
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.04em",
            }}
          >
            SUGGESTED HEADINGS
          </div>
          <div className="filter-chips" style={{ padding: "6px 0 0" }}>
            {["Target", "Principles", "Risk", "Commitments", "Open questions", "Contributions"].map(
              (h) => (
                <button type="button" key={h} className="chip" onClick={() => insertSection(h)}>
                  + {h}
                </button>
              ),
            )}
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer
        start={
          saveFailed ? (
            <span style={{ fontSize: 12, color: "var(--loss)" }}>
              Couldn&apos;t save your plan. Try again.
            </span>
          ) : undefined
        }
      >
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={handleSave}>
          Save plan <Icon name="check" size={13} />
        </button>
      </Modal.Footer>
    </Modal>
  );
}

function EmptyTab({ title, body }: { title: string; body: string }) {
  return (
    <div className="section" style={{ marginTop: 0 }}>
      <div
        className="card"
        style={{
          padding: "28px 20px",
          textAlign: "center",
          color: "var(--muted)",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6, color: "var(--ink)" }}>
          {title}
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.5, maxWidth: 300, margin: "0 auto" }}>
          {body}
        </div>
      </div>
    </div>
  );
}

// Friendly labels for a note's provenance. A reply you bookmark from chat is
// stored source `user_tool` → "CHAT"; keep others readable rather than raw enum.
const NOTE_SOURCE_LABEL: Record<string, string> = {
  user_tool: "CHAT",
  advisor_tool: "ADVISOR",
  manual: "NOTE",
};
const noteSourceLabel = (s: string) => NOTE_SOURCE_LABEL[s] ?? s.toUpperCase();

function JournalNotes({ notes }: { notes: Note[] }) {
  // Deleting a note is permanent (no trash), so confirm via the shared dialog
  // (same one holdings use). `pendingDelete` holds the note awaiting confirm.
  const [pendingDelete, setPendingDelete] = useState<Note | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Notes carry a `j`-prefixed id (adapter); strip it for the numeric DELETE.
  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    try {
      const res = await fetch(`/api/journal/${pendingDelete.id.replace(/^j/, "")}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        window.alert(`Failed to delete note (${res.status})`);
        return;
      }
      invalidate("/api/journal");
      setPendingDelete(null);
    } finally {
      setDeleteBusy(false);
    }
  };

  if (notes.length === 0) {
    return (
      <EmptyTab
        title="No notes yet"
        body="Insights you save from chat or analysis appear here. The advisor reads them for context in future conversations."
      />
    );
  }
  return (
    <div>
      <div className="section" style={{ marginTop: 0 }}>
        <p
          style={{
            fontSize: 12.5,
            color: "var(--muted)",
            margin: "0 4px 14px",
            lineHeight: 1.5,
          }}
        >
          Insights you&apos;ve saved from chat and analysis. The advisor uses these as context when
          answering future questions.
        </p>
        {notes.map((n) => (
          <div key={n.id} className="card" style={{ marginBottom: 8 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                marginBottom: 6,
              }}
            >
              <div
                style={{
                  fontSize: 9.5,
                  fontFamily: "var(--font-mono)",
                  color: "var(--muted)",
                  letterSpacing: "0.04em",
                }}
              >
                {noteSourceLabel(n.source)} · {n.date.toUpperCase()}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {n.tags.map((t) => (
                  <span key={t} className="tag" style={{ fontSize: 9 }}>
                    {t}
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => setPendingDelete(n)}
                  aria-label="Delete note"
                  title="Delete note"
                  style={{
                    background: "transparent",
                    border: 0,
                    color: "var(--muted)",
                    cursor: "pointer",
                    padding: "2px 4px",
                    fontSize: 14,
                    lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
            <div
              style={{
                fontSize: 13.5,
                fontWeight: 500,
                letterSpacing: "-0.01em",
                marginBottom: 6,
              }}
            >
              {n.title}
            </div>
            <div
              style={{
                fontSize: 13,
                color: "var(--ink-soft)",
                lineHeight: 1.5,
              }}
            >
              {n.body}
            </div>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete note?"
        message="This note will be permanently deleted. This can't be undone."
        confirmLabel="Delete"
        busy={deleteBusy}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

function JournalModels({ saved, onOpenModels }: { saved: string[]; onOpenModels: () => void }) {
  const { models } = useModelPortfoliosView();
  const target = useSelectedModelId();
  const all = models ?? [];
  const list = saved
    .map((id) => all.find((m) => m.id === id))
    .filter((m): m is ModelPortfolio => Boolean(m));

  if (list.length === 0) {
    return (
      <div>
        <EmptyTab
          title="No saved templates"
          body="Pin index strategies from Templates to track them here. The advisor can suggest one when you ask 'what should I hold?'"
        />
        <div className="section" style={{ textAlign: "center" }}>
          <button className="btn ghost sm" onClick={onOpenModels}>
            Browse templates →
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="section">
        <p
          style={{
            fontSize: 12.5,
            color: "var(--muted)",
            margin: "0 4px 14px",
            lineHeight: 1.5,
          }}
        >
          Index strategies you&apos;ve explored.
        </p>
        {list.map((m) => (
          <div
            key={m.id}
            className="card"
            style={{ marginBottom: 8, cursor: "pointer", padding: 14 }}
            {...onActivate(onOpenModels)}
          >
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <ModelDonut mix={m.mix} size={48} thickness={7} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    marginBottom: 2,
                  }}
                >
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 500,
                      letterSpacing: "-0.01em",
                    }}
                  >
                    {m.name}
                  </div>
                  {target === m.id && (
                    <span className="tag green" style={{ fontSize: 9 }}>
                      ● TARGET
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--muted)",
                    lineHeight: 1.35,
                  }}
                >
                  {m.tagline}
                </div>
              </div>
              <Icon name="arrowRight" size={13} />
            </div>
          </div>
        ))}
        <button className="btn ghost full" onClick={onOpenModels} style={{ marginTop: 8 }}>
          Browse all {all.length} templates →
        </button>
      </div>
    </div>
  );
}

function JournalReading({ reading }: { reading: ReadingItem[] }) {
  if (reading.length === 0) {
    return (
      <EmptyTab
        title="No saved reading"
        body="Save articles from Markets › Learn, or ask the advisor to summarize a link — they land here for later."
      />
    );
  }
  return (
    <div>
      <div className="section" style={{ marginTop: 0 }}>
        <p
          style={{
            fontSize: 12.5,
            color: "var(--muted)",
            margin: "0 4px 14px",
            lineHeight: 1.5,
          }}
        >
          Articles saved from Markets &gt; Learn, or links you&apos;ve asked the advisor to read.
        </p>
        {reading.map((r) => (
          <div key={r.id} className="article-card">
            <div className="meta-row">
              <span>{r.source.toUpperCase()}</span>
              <span>· {r.readTime} MIN READ</span>
              <span style={{ marginLeft: "auto" }} className={`status-pip ${r.status}`}>
                {r.status === "read" ? "✓ READ" : r.status === "in_progress" ? "READING" : "UNREAD"}
              </span>
            </div>
            <div className="a-title">{r.title}</div>
            <div className="a-blurb">{r.summary}</div>
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--muted)" }}>
              Saved {r.savedDate}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
