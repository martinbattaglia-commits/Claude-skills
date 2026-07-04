"use client";

import { move } from "@dnd-kit/helpers";
import { DragDropProvider } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { ChatThreadList } from "@/components/ChatThreadList";
import { Icon } from "@/components/Icon";
import { SkeletonRows } from "@/components/ui/Skeleton";
import {
  useJournalView,
  useModelPortfoliosView,
  usePortfolioView,
  useSelectedModelId,
} from "@/lib/fetchers/legacy";
import { invalidate } from "@/lib/fetchers/swr";
import { computeHealth, summarizeHealth } from "@/lib/portfolio/health";
import type { Portfolio } from "@/lib/static/types";
import { useChatUi } from "@/lib/stores/chat-ui";
import { usePortfolioUi } from "@/lib/stores/portfolio-ui";
import { useOverlayScrollbar } from "@/lib/useOverlayScrollbar";

export type AppId = "chat" | "portfolios" | "plan" | "notes";

const CHAT_VIEW_STORAGE_KEY = "macrotide-chat-view";

/**
 * A panel scroll body with the desktop/tablet overlay scrollbar.
 *
 * OverlayScrollbars re-parents the host's children into a generated viewport,
 * so React must NOT reconcile dynamic children directly under the OS host — it
 * would try to remove/insert nodes the library has already moved and throw
 * `removeChild ... not a child of this node`. The single, stable
 * `.ra-panel-body-content` child is what OS moves; React only ever reconciles
 * inside it. This mirrors `.modal-body` / `.modal-body-content` in Modal.tsx.
 * The host keeps its padding (OS preserves host padding); the content wrapper
 * carries the column+gap layout (which OS would strip off the host).
 */
function PanelScrollBody({
  className,
  style,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const bodyRef = useOverlayScrollbar();
  return (
    <div ref={bodyRef} className={`ra-panel-body${className ? ` ${className}` : ""}`} style={style}>
      <div className="ra-panel-body-content">{children}</div>
    </div>
  );
}

// Shared "expand to full" toggle (issue #95). Carried by every panel head so the
// behavior is identical across Advisor, Portfolios, Plan, and Notes. The button
// is absent when `onToggleMax` is — e.g. on the tablet/mobile shells that don't
// wire it up — so a head without maximize support just renders nothing extra.
interface PanelMaxProps {
  maxed?: boolean;
  onToggleMax?: () => void;
}

function PanelMaxButton({ maxed, onToggleMax }: PanelMaxProps) {
  if (!onToggleMax) return null;
  return (
    <button
      type="button"
      className="icon-btn ra-panel-max-btn"
      onClick={onToggleMax}
      aria-label={maxed ? "Restore panel width" : "Maximize panel"}
      aria-pressed={maxed}
      title={maxed ? "Restore" : "Maximize"}
    >
      <Icon name={maxed ? "minimize-2" : "maximize-2"} size={14} />
    </button>
  );
}

interface PanelHeaderProps extends PanelMaxProps {
  title: string;
  showDot?: boolean;
  onClose: () => void;
}

function PanelHeader({ title, showDot, onClose, maxed, onToggleMax }: PanelHeaderProps) {
  return (
    <div className="ra-panel-head">
      <div className="ra-panel-title">
        {showDot && <span className="ra-dot"></span>} {title}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <PanelMaxButton maxed={maxed} onToggleMax={onToggleMax} />
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" size={14} />
        </button>
      </div>
    </div>
  );
}

export function ChatPanel({
  chatSlotRef,
  onClose,
  maxed,
  onToggleMax,
}: {
  /** Registers this panel's chat body as the mount-point for the single
      persistent ChatScreen (owned by App; see its chatHost note). The conversation
      lives in App and is re-parented here, so it survives the mobile↔wide swap. */
  chatSlotRef: (el: HTMLElement | null) => void;
  onClose: () => void;
  /** Panel "expand to full" state + toggle (issue #95); shared with the other panels. */
  maxed?: boolean;
  onToggleMax?: () => void;
}) {
  // In-panel view swap (Option B): the chat body and the thread list share one
  // panel. "All chats" swaps to the list; the back arrow returns to chat.
  // Persist the sub-view across reloads/resize (mirrors the theme pattern).
  const [view, setView] = useState<"chat" | "threads">(() => {
    if (typeof window === "undefined") return "chat";
    try {
      const stored = window.localStorage.getItem(CHAT_VIEW_STORAGE_KEY);
      if (stored === "chat" || stored === "threads") return stored;
    } catch {}
    return "chat";
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(CHAT_VIEW_STORAGE_KEY, view);
    } catch {}
  }, [view]);
  // ChatScreen owns threadId/loadThread/newChat and stays mounted across the
  // swap; we coordinate through the shared chat UI store so the list can
  // highlight the active thread and drive load/new — no window-event handshake.
  const { activeThreadId, requestLoadThread, requestNewChat } = useChatUi();

  const selectThread = (id: string) => {
    requestLoadThread(id);
    setView("chat");
  };
  const startNewChat = () => {
    requestNewChat();
    setView("chat");
  };

  return (
    <>
      {view === "chat" ? (
        <div className="ra-panel-head">
          <div className="ra-panel-title">
            <button
              type="button"
              className="icon-btn"
              onClick={() => setView("threads")}
              aria-label="All chats"
              title="All chats"
            >
              <Icon name="menu" size={15} />
            </button>
            <span className="ra-dot"></span> Advisor
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button
              type="button"
              className="chip-btn"
              onClick={startNewChat}
              title="Start a new conversation (⌘K)"
            >
              <Icon name="sparkle" size={12} /> New chat
            </button>
            <PanelMaxButton maxed={maxed} onToggleMax={onToggleMax} />
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <Icon name="close" size={14} />
            </button>
          </div>
        </div>
      ) : (
        <div className="ra-panel-head">
          <div className="ra-panel-title">
            <button
              type="button"
              className="icon-btn"
              onClick={() => setView("chat")}
              aria-label="Back to chat"
              title="Back to chat"
            >
              <Icon name="arrow-left" size={16} />
            </button>
            Chats
          </div>
          <button
            type="button"
            className="chip-btn"
            onClick={startNewChat}
            title="Start a new conversation (⌘K)"
          >
            <Icon name="sparkle" size={12} /> New
          </button>
        </div>
      )}
      {/* Mount-point for App's persistent ChatScreen (chatSlotRef). It stays
          mounted across the in-panel chat↔threads swap (hidden via display:none,
          not unmounted) AND across the mobile↔wide shell swap (re-parented, not
          remounted) — so in-flight turns and the active thread always survive. */}
      <div
        ref={chatSlotRef}
        className="ra-panel-body ra-chat-body"
        style={view === "chat" ? undefined : { display: "none" }}
      />
      {view === "threads" && (
        <ChatThreadList
          variant="panel"
          open
          onClose={() => setView("chat")}
          activeThreadId={activeThreadId}
          onSelect={selectThread}
          onNewChat={startNewChat}
        />
      )}
    </>
  );
}

const fmtBaht = (n: number) => `฿${Math.round(n).toLocaleString("en-US")}`;

// A single draggable portfolio row. The drag handle (leading edge) is the only
// drag affordance; the card click still activates and the trailing pencil still
// edits — mirroring ManageIndicatorsSheet's handle/affordance split.
function SortableBucketRow({
  p,
  index,
  active,
  onActivate,
  onEdit,
}: {
  p: Portfolio;
  index: number;
  active: boolean;
  onActivate: () => void;
  onEdit: () => void;
}) {
  const { ref, handleRef, isDragging } = useSortable({ id: p.id, index });
  return (
    <div
      ref={ref}
      className={`ra-bucket-row${isDragging ? " ra-bucket-row--dragging" : ""}`}
      data-active={active}
    >
      <button
        ref={handleRef}
        type="button"
        className="ra-bucket-drag-handle"
        aria-label={`Reorder ${p.name}`}
      >
        <Icon name="grip-vertical" size={14} />
      </button>
      <button
        type="button"
        className="ra-bucket-card ra-bucket-card-btn"
        onClick={onActivate}
        aria-label={`Open ${p.name}`}
        aria-current={active ? "true" : undefined}
      >
        <span className="ra-bucket-icon">
          <Icon name={p.icon || "wallet"} size={14} />
        </span>
        <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
          <div className="ra-bucket-name">{p.name}</div>
          <div className="ra-bucket-sub">{p.holdings.length} holdings</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="num" style={{ fontSize: 12.5 }}>
            {fmtBaht(p.totalValue)}
          </div>
          <div className={`delta num ${p.perfPct.ytd >= 0 ? "up" : "down"}`}>
            {p.perfPct.ytd >= 0 ? "+" : ""}
            {p.perfPct.ytd.toFixed(1)}% YTD
          </div>
        </div>
      </button>
      <button
        type="button"
        className="ra-bucket-edit"
        onClick={onEdit}
        aria-label={`Edit ${p.name}`}
        title={`Edit ${p.name}`}
      >
        <Icon name="pencil" size={12} />
      </button>
    </div>
  );
}

// The portfolios manager — list + drag-reorder + activate + edit + new — shared
// by the wide right-dock panel and the phone full-page screen. `onAfterSelect`
// lets the phone screen pop back to the portfolio view once a bucket is picked;
// the dock panel omits it (it stays open beside the screen).
export function PortfoliosList({ onAfterSelect }: { onAfterSelect?: () => void }) {
  const { portfolios, isLoading } = usePortfolioView();
  // Active id + edit/new intents flow through the shared store, so the list
  // highlight tracks whatever the PortfolioScreen shows — no event handshake.
  const { activeId, setActiveId, requestEdit, requestNew } = usePortfolioUi();

  // Local working order for optimistic drag-reorder. Re-seed from the fetched
  // portfolios whenever they change (load, create, delete) so we never render a
  // stale or partial list; between server round-trips the local order wins.
  const [order, setOrder] = useState<Portfolio[]>([]);
  useEffect(() => {
    if (portfolios) setOrder(portfolios);
  }, [portfolios]);

  const persistOrder = async (next: Portfolio[]) => {
    try {
      await fetch("/api/portfolios/reorder", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderedIds: next.map((p) => p.id) }),
      });
      // The list feeds off /api/buckets (via usePortfolioView); invalidate so
      // the persisted order reconciles with our optimistic local state.
      invalidate("/api/buckets");
    } catch (err) {
      console.error("Failed to persist portfolio order:", err);
    }
  };

  return (
    <>
      {isLoading || !portfolios ? (
        <SkeletonRows rows={3} height={56} padding={0} />
      ) : order.length === 0 ? (
        <div style={{ padding: 12, color: "var(--muted)", fontSize: 12.5 }}>No portfolios yet.</div>
      ) : (
        <DragDropProvider
          onDragEnd={(event) => {
            const next = move(order, event);
            setOrder(next);
            void persistOrder(next);
          }}
        >
          {order.map((p, i) => (
            <SortableBucketRow
              key={p.id}
              p={p}
              index={i}
              active={activeId === p.id}
              onActivate={() => {
                setActiveId(p.id);
                onAfterSelect?.();
              }}
              onEdit={() => requestEdit(p.id)}
            />
          ))}
        </DragDropProvider>
      )}
      <button
        className="btn ghost sm"
        style={{ width: "100%", marginTop: 10, display: "flex" }}
        onClick={() => requestNew()}
      >
        <Icon name="plus" size={12} /> New portfolio
      </button>
    </>
  );
}

export function PortfoliosPanel({
  onClose,
  maxed,
  onToggleMax,
}: { onClose: () => void } & PanelMaxProps) {
  return (
    <>
      <PanelHeader title="Portfolios" onClose={onClose} maxed={maxed} onToggleMax={onToggleMax} />
      <PanelScrollBody style={{ padding: "10px 14px 14px" }}>
        <PortfoliosList />
      </PanelScrollBody>
    </>
  );
}

const TONE_COLOR: Record<string, string> = {
  good: "var(--gain)",
  watch: "var(--amber)",
  action: "var(--loss)",
};

export function PlanPanel({
  onClose,
  maxed,
  onToggleMax,
}: { onClose: () => void } & PanelMaxProps) {
  // Real, computed health over the combined book vs the selected target model.
  const { aggregate } = usePortfolioView();
  const { models } = useModelPortfoliosView();
  const selectedModelId = useSelectedModelId();
  const targetModel = models?.find((m) => m.id === selectedModelId) ?? null;

  const health = aggregate
    ? computeHealth(
        aggregate.holdings,
        aggregate.totalValue,
        targetModel?.mix ?? null,
        targetModel?.ter ?? null,
      )
    : null;

  if (!health) {
    return (
      <>
        <PanelHeader
          title="Plan & Health"
          onClose={onClose}
          maxed={maxed}
          onToggleMax={onToggleMax}
        />
        <PanelScrollBody style={{ padding: 16 }}>
          <SkeletonRows rows={4} height={42} padding={0} />
        </PanelScrollBody>
      </>
    );
  }

  const headline = summarizeHealth(health, targetModel?.name ?? null);
  const metrics: { label: string; value: string }[] = [
    ...(targetModel
      ? [{ label: "Off target", value: `${health.trackingGapPp.toFixed(1)}pp` }]
      : []),
    { label: "Blended fee", value: `${health.blendedTer.toFixed(2)}%` },
    {
      label: "Top holding",
      value: health.concentration.top ? `${health.concentration.top.pct.toFixed(0)}%` : "—",
    },
    { label: "Cash", value: `${health.cashPct.toFixed(0)}%` },
  ];

  return (
    <>
      <PanelHeader
        title="Plan & Health"
        onClose={onClose}
        maxed={maxed}
        onToggleMax={onToggleMax}
      />
      <PanelScrollBody style={{ padding: "12px 14px" }}>
        <div
          className="card-soft"
          style={{ padding: "10px 12px", marginBottom: 12, borderRadius: 12 }}
        >
          <div
            style={{
              fontSize: 9.5,
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.06em",
              color: TONE_COLOR[headline.tone],
              marginBottom: 4,
            }}
          >
            ● TOP THING TO KNOW
          </div>
          <div
            style={{ fontSize: 13, fontWeight: 500, letterSpacing: "-0.01em", lineHeight: 1.35 }}
          >
            {headline.title}
          </div>
          <button
            type="button"
            className="btn ghost sm"
            style={{ marginTop: 8, gap: 4 }}
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("ai-prompt", {
                  detail: {
                    display: headline.prompt,
                    send: headline.prompt,
                    context: { screen: "portfolio", intent: "health_review" },
                  },
                }),
              )
            }
          >
            <Icon name="chat" size={12} /> Discuss
          </button>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${metrics.length}, 1fr)`,
            gap: 6,
          }}
        >
          {metrics.map((m) => (
            <div key={m.label} style={{ textAlign: "center" }}>
              <div className="num" style={{ fontSize: 15, fontWeight: 500 }}>
                {m.value}
              </div>
              <div
                style={{
                  fontSize: 8.5,
                  fontFamily: "var(--font-mono)",
                  color: "var(--muted)",
                  letterSpacing: "0.04em",
                  marginTop: 2,
                }}
              >
                {m.label.toUpperCase()}
              </div>
            </div>
          ))}
        </div>

        {!targetModel && (
          <div style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.5, marginTop: 12 }}>
            Pick a target model to unlock drift tracking and rebalance suggestions.
          </div>
        )}
      </PanelScrollBody>
    </>
  );
}

export function NotesPanel({
  onClose,
  maxed,
  onToggleMax,
}: { onClose: () => void } & PanelMaxProps) {
  const { journal } = useJournalView();
  const notes = journal?.notes ?? [];
  return (
    <>
      <PanelHeader title="Pinned notes" onClose={onClose} maxed={maxed} onToggleMax={onToggleMax} />
      <PanelScrollBody style={{ padding: "8px 12px 12px" }}>
        {notes.slice(0, 6).map((n) => (
          <div className="article-card" key={n.id}>
            <div className="meta-row">
              <span>{n.date}</span>
              {n.tags[0] && (
                <>
                  <span>·</span>
                  <span>{n.tags[0]}</span>
                </>
              )}
            </div>
            <div className="a-title">{n.title}</div>
            {n.body && <div className="a-blurb">{n.body}</div>}
          </div>
        ))}
        {notes.length === 0 && (
          <div
            style={{
              padding: 20,
              textAlign: "center",
              color: "var(--muted)",
              fontSize: 12.5,
            }}
          >
            No pinned notes yet.
          </div>
        )}
      </PanelScrollBody>
    </>
  );
}
