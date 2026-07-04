"use client";

import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Icon } from "@/components/Icon";
import { invalidate, useResource } from "@/lib/fetchers/swr";
import { useOverlayScrollbar } from "@/lib/useOverlayScrollbar";

interface ThreadRow {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

interface BucketedThread {
  bucket: "Today" | "Yesterday" | "Last 7 days" | "Last 30 days" | "Older";
  threads: ThreadRow[];
}

interface ThreadSearchHit {
  thread: ThreadRow;
  snippet: string | null;
  matchedOn: "message" | "title" | "both";
}

function bucketize(threads: ThreadRow[]): BucketedThread[] {
  const now = Date.now();
  const dayMs = 24 * 60 * 60_000;
  const today: ThreadRow[] = [];
  const yesterday: ThreadRow[] = [];
  const lastWeek: ThreadRow[] = [];
  const lastMonth: ThreadRow[] = [];
  const older: ThreadRow[] = [];
  for (const t of threads) {
    const age = now - Date.parse(t.updatedAt);
    if (age < dayMs) today.push(t);
    else if (age < 2 * dayMs) yesterday.push(t);
    else if (age < 7 * dayMs) lastWeek.push(t);
    else if (age < 30 * dayMs) lastMonth.push(t);
    else older.push(t);
  }
  const buckets: BucketedThread[] = [];
  if (today.length) buckets.push({ bucket: "Today", threads: today });
  if (yesterday.length) buckets.push({ bucket: "Yesterday", threads: yesterday });
  if (lastWeek.length) buckets.push({ bucket: "Last 7 days", threads: lastWeek });
  if (lastMonth.length) buckets.push({ bucket: "Last 30 days", threads: lastMonth });
  if (older.length) buckets.push({ bucket: "Older", threads: older });
  return buckets;
}

function titleFor(t: ThreadRow): string {
  if (t.title?.trim()) return t.title;
  return "Untitled chat";
}

function daysLeftUntilPurge(deletedAt: string | null | undefined, windowDays = 30): number {
  if (!deletedAt) return windowDays;
  const purgeAt = Date.parse(deletedAt) + windowDays * 24 * 60 * 60_000;
  return Math.max(0, Math.ceil((purgeAt - Date.now()) / (24 * 60 * 60_000)));
}

export interface ChatThreadListProps {
  open: boolean;
  onClose: () => void;
  activeThreadId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  /**
   * "drawer" (default) — full-viewport fixed left drawer with its own header +
   * backdrop. Used by ChatScreen on mobile.
   * "panel" — renders only the scrollable list body (no fixed positioning, no
   * backdrop, no header). Meant to be dropped into the chat right-rail panel,
   * which supplies its own panel header + back control.
   */
  variant?: "drawer" | "panel";
}

export function ChatThreadList({
  open,
  onClose,
  activeThreadId,
  onSelect,
  onNewChat,
  variant = "drawer",
}: ChatThreadListProps) {
  // Active threads load eagerly when the drawer opens; the trash group loads
  // only after the user expands it (gated on `showDeleted`) so the common
  // path stays one request.
  const { data, isLoading, error } = useResource<ThreadRow[]>(open ? "/api/chat/threads" : null);
  const [showDeleted, setShowDeleted] = useState(false);

  // Overlay scrollbar for the in-panel list scroller. Only the "panel" variant
  // renders `.ra-thread-panel`; in the drawer variant the callback ref is never
  // attached, so the instance never initializes.
  const threadPanelRef = useOverlayScrollbar(variant === "panel");

  // Sidebar full-text search. The raw input updates immediately for
  // responsiveness; `debouncedQuery` trails by 200ms so we don't fire a
  // request per keystroke. A blank query falls back to the bucketed list.
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 200);
    return () => clearTimeout(id);
  }, [searchQuery]);
  const searchActive = debouncedQuery.length > 0;
  const { data: searchData, isLoading: searchLoading } = useResource<ThreadSearchHit[]>(
    open && searchActive ? `/api/chat/search?q=${encodeURIComponent(debouncedQuery)}` : null,
  );
  const { data: deletedData, isLoading: deletedLoading } = useResource<ThreadRow[]>(
    open && showDeleted ? "/api/chat/threads?include=deleted" : null,
  );

  // Single open menu / inline-edit at a time. Both reset when the drawer
  // closes so they don't leak across opens.
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  // Thread pending permanent deletion (confirm dialog target).
  const [purgeTarget, setPurgeTarget] = useState<{ id: string; title: string } | null>(null);
  const [purging, setPurging] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (renamingId) {
          setRenamingId(null);
          return;
        }
        if (menuOpenId) {
          setMenuOpenId(null);
          return;
        }
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, menuOpenId, renamingId]);

  useEffect(() => {
    if (!open) {
      setMenuOpenId(null);
      setRenamingId(null);
      setShowDeleted(false);
      setSearchQuery("");
      setDebouncedQuery("");
    }
  }, [open]);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  if (!open) return null;

  const buckets = data ? bucketize(data) : [];

  const startRename = (t: ThreadRow) => {
    setMenuOpenId(null);
    setRenameDraft(t.title?.trim() ?? "");
    setRenamingId(t.id);
  };

  const commitRename = async (id: string) => {
    const next = renameDraft.trim();
    setRenamingId(null);
    if (!next) return;
    const res = await fetch(`/api/chat/threads/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: next }),
    });
    if (!res.ok) {
      window.alert(`Couldn't rename (${res.status})`);
      return;
    }
    await invalidate("/api/chat/threads");
  };

  const softDelete = async (id: string) => {
    // No confirm — that's the point of the 30-day trash.
    setMenuOpenId(null);
    const res = await fetch(`/api/chat/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      window.alert(`Couldn't delete (${res.status})`);
      return;
    }
    await invalidate(/^\/api\/chat\/threads/);
    if (id === activeThreadId) onNewChat();
  };

  const restore = async (id: string) => {
    const res = await fetch(`/api/chat/threads/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ restore: true }),
    });
    if (!res.ok) {
      window.alert(`Couldn't restore (${res.status})`);
      return;
    }
    await invalidate(/^\/api\/chat\/threads/);
  };

  // Confirm IS appropriate for this irreversible action — gated by ConfirmDialog.
  const confirmPurge = async () => {
    if (!purgeTarget) return;
    setPurging(true);
    const res = await fetch(`/api/chat/threads/${encodeURIComponent(purgeTarget.id)}?purge=true`, {
      method: "DELETE",
    });
    setPurging(false);
    if (!res.ok) {
      window.alert(`Couldn't delete forever (${res.status})`);
      return;
    }
    setPurgeTarget(null);
    await invalidate(/^\/api\/chat\/threads/);
  };

  const searchResults = (
    <>
      {searchLoading && (
        <div style={{ padding: "16px", fontSize: 13, color: "var(--muted)" }}>Searching…</div>
      )}
      {!searchLoading && searchData && searchData.length === 0 && (
        <div style={{ padding: "16px", fontSize: 13, color: "var(--muted)" }}>
          No chats match “{debouncedQuery}”.
        </div>
      )}
      {searchData?.map((hit) => {
        const t = hit.thread;
        const isActive = t.id === activeThreadId;
        const title = titleFor(t);
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              onSelect(t.id);
              onClose();
            }}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              background: isActive ? "var(--accent-soft)" : "transparent",
              border: 0,
              cursor: "pointer",
              padding: "8px 16px",
            }}
            title={title}
          >
            <div
              style={{
                fontSize: 13.5,
                fontWeight: isActive ? 600 : 400,
                color: isActive ? "var(--accent-ink)" : "var(--ink)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {title}
            </div>
            {hit.snippet && (
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--muted)",
                  marginTop: 2,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {hit.snippet}
              </div>
            )}
          </button>
        );
      })}
    </>
  );

  const normalList = (
    <>
      {isLoading && (
        <div style={{ padding: "16px", fontSize: 13, color: "var(--muted)" }}>Loading…</div>
      )}
      {error && (
        <div style={{ padding: "16px", fontSize: 13, color: "var(--danger, #c33)" }}>
          Couldn't load threads.
        </div>
      )}
      {!isLoading && !error && buckets.length === 0 && (
        <div style={{ padding: "16px", fontSize: 13, color: "var(--muted)" }}>
          No saved chats yet. Start a conversation and it'll appear here.
        </div>
      )}
      {buckets.map((b) => (
        <div key={b.bucket} style={{ marginBottom: 8 }}>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              letterSpacing: "0.08em",
              color: "var(--muted)",
              padding: "8px 16px 4px",
              textTransform: "uppercase",
            }}
          >
            {b.bucket}
          </div>
          {b.threads.map((t) => {
            const isActive = t.id === activeThreadId;
            const title = titleFor(t);
            const isRenaming = renamingId === t.id;
            const isMenuOpen = menuOpenId === t.id;
            return (
              <div
                key={t.id}
                className="chat-thread-row"
                style={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                  padding: "6px 8px 6px 16px",
                  background: isActive ? "var(--accent-soft)" : "transparent",
                }}
              >
                {/* Active-session indicator: subtle dot. */}
                <span
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    marginRight: 8,
                    background: isActive ? "var(--accent-ink)" : "transparent",
                    flexShrink: 0,
                  }}
                />
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => commitRename(t.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename(t.id);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setRenamingId(null);
                      }
                    }}
                    aria-label={`Rename ${title}`}
                    style={{
                      flex: 1,
                      background: "var(--bg)",
                      border: "1px solid var(--line)",
                      borderRadius: 4,
                      color: "var(--ink)",
                      fontSize: 13.5,
                      padding: "3px 6px",
                      outline: "none",
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(t.id);
                      onClose();
                    }}
                    style={{
                      flex: 1,
                      textAlign: "left",
                      background: "transparent",
                      border: 0,
                      color: isActive ? "var(--accent-ink)" : "var(--ink)",
                      fontSize: 13.5,
                      fontWeight: isActive ? 600 : 400,
                      lineHeight: 1.35,
                      padding: "4px 4px",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    title={title}
                  >
                    {title}
                  </button>
                )}
                {!isRenaming && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpenId(isMenuOpen ? null : t.id);
                    }}
                    aria-label={`Actions for ${title}`}
                    aria-haspopup="menu"
                    aria-expanded={isMenuOpen}
                    title="More"
                    className="chat-thread-kebab"
                    style={{
                      background: "transparent",
                      border: 0,
                      color: "var(--muted)",
                      cursor: "pointer",
                      padding: "4px 8px",
                      fontSize: 16,
                      lineHeight: 1,
                      opacity: isMenuOpen ? 1 : undefined,
                    }}
                  >
                    ⋯
                  </button>
                )}
                {isMenuOpen && (
                  <div
                    role="menu"
                    style={{
                      position: "absolute",
                      top: "100%",
                      right: 8,
                      marginTop: 2,
                      background: "var(--bg)",
                      border: "1px solid var(--line)",
                      borderRadius: 6,
                      boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
                      zIndex: 62,
                      minWidth: 140,
                      padding: "4px 0",
                    }}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => startRename(t)}
                      style={menuItemStyle}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => softDelete(t.id)}
                      style={{ ...menuItemStyle, color: "var(--danger, #c33)" }}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {/* Deleted chats (30-day restore). Collapsible, lazy-loaded. */}
      <div
        style={{
          marginTop: 12,
          borderTop: "1px solid var(--line)",
          paddingTop: 8,
        }}
      >
        <button
          type="button"
          onClick={() => setShowDeleted((s) => !s)}
          aria-expanded={showDeleted}
          style={{
            background: "transparent",
            border: 0,
            width: "100%",
            textAlign: "left",
            padding: "6px 16px",
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            letterSpacing: "0.08em",
            color: "var(--muted)",
            textTransform: "uppercase",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ width: 10, display: "inline-block" }}>{showDeleted ? "▾" : "▸"}</span>
          Deleted chats (30 days)
          {deletedData && deletedData.length > 0 && (
            <span style={{ marginLeft: "auto", fontFamily: "var(--font-sans)" }}>
              {deletedData.length}
            </span>
          )}
        </button>
        {showDeleted && (
          <div>
            {deletedLoading && (
              <div style={{ padding: "8px 16px", fontSize: 12, color: "var(--muted)" }}>
                Loading…
              </div>
            )}
            {!deletedLoading && deletedData && deletedData.length === 0 && (
              <div style={{ padding: "8px 16px", fontSize: 12, color: "var(--muted)" }}>
                No deleted chats.
              </div>
            )}
            {deletedData?.map((t) => {
              const title = titleFor(t);
              const daysLeft = daysLeftUntilPurge(t.deletedAt);
              return (
                <div
                  key={t.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "6px 8px 6px 16px",
                    gap: 4,
                  }}
                >
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12.5,
                      color: "var(--muted)",
                    }}
                  >
                    <div
                      style={{
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                      title={title}
                    >
                      {title}
                    </div>
                    <div style={{ fontSize: 10.5, opacity: 0.8 }}>
                      {daysLeft === 0 ? "Purges today" : `${daysLeft}d left`}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => restore(t.id)}
                    className="btn ghost sm"
                    title="Restore"
                    style={{ padding: "2px 6px", fontSize: 11 }}
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    onClick={() => setPurgeTarget({ id: t.id, title })}
                    aria-label={`Delete ${title} forever`}
                    title="Delete forever"
                    style={{
                      background: "transparent",
                      border: 0,
                      color: "var(--muted)",
                      cursor: "pointer",
                      padding: "4px 6px",
                      fontSize: 13,
                    }}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );

  const listBody = (
    <>
      <div style={{ padding: "8px 12px 4px" }}>
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search chats…"
          aria-label="Search chats"
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: "var(--card-soft, var(--bg))",
            border: "1px solid var(--line)",
            borderRadius: 6,
            color: "var(--ink)",
            fontSize: 13,
            padding: "6px 10px",
            outline: "none",
          }}
        />
      </div>
      {searchActive ? searchResults : normalList}
      <ConfirmDialog
        open={purgeTarget !== null}
        title="Delete chat forever?"
        message={
          purgeTarget
            ? `"${purgeTarget.title}" will be permanently deleted. This can't be undone.`
            : undefined
        }
        confirmLabel="Delete forever"
        busy={purging}
        onConfirm={confirmPurge}
        onCancel={() => setPurgeTarget(null)}
      />
    </>
  );

  const hoverStyles = (
    <style jsx>{`
      :global(.chat-thread-row) .chat-thread-kebab {
        opacity: 0;
        transition: opacity 80ms ease;
      }
      :global(.chat-thread-row):hover .chat-thread-kebab,
      :global(.chat-thread-row):focus-within .chat-thread-kebab {
        opacity: 0.85;
      }
    `}</style>
  );

  // In-panel variant: just the scrollable list body. The chat panel supplies
  // its own header + back control, so there's no fixed positioning or backdrop.
  if (variant === "panel") {
    // Single stable child: OverlayScrollbars re-parents the host's children into
    // a generated viewport, so React must not reconcile the dynamic list
    // directly under the OS host (it would throw `removeChild ... not a child`).
    // React only reconciles inside `.ra-thread-panel-content`. See PanelScrollBody.
    return (
      <div ref={threadPanelRef} className="ra-thread-panel">
        <div className="ra-thread-panel-content">
          {listBody}
          {hoverStyles}
        </div>
      </div>
    );
  }

  // Drawer variant (mobile): full-viewport fixed left drawer with backdrop.
  return (
    <>
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close thread list"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.32)",
          border: 0,
          padding: 0,
          zIndex: 60,
          cursor: "pointer",
        }}
      />
      {/* Drawer */}
      <aside
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          bottom: 0,
          width: "min(320px, 88vw)",
          background: "var(--bg)",
          borderRight: "1px solid var(--line)",
          zIndex: 61,
          display: "flex",
          flexDirection: "column",
          boxShadow: "8px 0 24px rgba(0,0,0,0.12)",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "14px 16px",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <div
            style={{
              flex: 1,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              letterSpacing: "0.08em",
              color: "var(--muted)",
            }}
          >
            CHATS
          </div>
          <button
            type="button"
            className="chip-btn"
            onClick={() => {
              onNewChat();
              onClose();
            }}
            title="Start a new conversation (⌘K)"
          >
            <Icon name="sparkle" size={12} /> New
          </button>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </header>
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>{listBody}</div>
      </aside>
      {hoverStyles}
    </>
  );
}

const menuItemStyle: CSSProperties = {
  background: "transparent",
  border: 0,
  width: "100%",
  textAlign: "left",
  padding: "6px 12px",
  cursor: "pointer",
  fontSize: 13,
  color: "var(--ink)",
};
