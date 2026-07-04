"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { ChatThreadList } from "@/components/ChatThreadList";
import { Icon } from "@/components/Icon";
import { MarkdownMessage } from "@/components/MarkdownMessage";
import { SaveNoteButton } from "@/components/SaveNoteButton";
import type { EntryContext } from "@/lib/advisor/entry-context";
import { MAX_CHAT_ATTACHMENTS, withImageMarker } from "@/lib/advisor/image-turn";
import type { MemoryEventData as MemoryEvent, TurnPart } from "@/lib/advisor/turn-persist";
import {
  useModelPortfoliosView,
  usePortfolioView,
  useSelectedModelId,
} from "@/lib/fetchers/legacy";
import { invalidate, useResource } from "@/lib/fetchers/swr";
import { readExifCapture } from "@/lib/image-exif";
import { normalizeImage } from "@/lib/image-normalize";
import { type AdvisorScreenContext, buildChatSuggestions } from "@/lib/portfolio/chat-suggestions";
import { computeHealth } from "@/lib/portfolio/health";
import type { ExtractedTxnRow } from "@/lib/portfolio/ocr";
import { AI_PERSONALITIES } from "@/lib/static/personalities";
import { loadChatThreadCards, saveChatCard } from "@/lib/stores/chat-cards";
import { type ChatImage, loadChatThreadImages, saveChatImages } from "@/lib/stores/chat-images";
import { consumeLoadTarget, setActiveThreadId, useChatUi } from "@/lib/stores/chat-ui";
import {
  type ImportSeedRow,
  requestImportWithRows,
  requestTxnImportWithRows,
} from "@/lib/stores/import-seed";
import { useOverlayScrollbar } from "@/lib/useOverlayScrollbar";
import { usePointer } from "@/lib/usePointer";

// Per-message attachment cap — the single source of truth lives in
// lib/advisor/image-turn (the chat route enforces the same number as a backstop).
// Images are normalized client-side (the shared 2048px / JPEG-0.8 — see
// lib/image-normalize) before send, so chat and the importer feed the SAME vision
// model the SAME image.
const MAX_ATTACHMENTS = MAX_CHAT_ATTACHMENTS;

// Normalize an image File for chat: the shared 2048/0.8 JPEG (sent to the model,
// shown as a thumbnail, persisted), keeping the original for the full-res lightbox.
// The capture time is read from the ORIGINAL file's EXIF first (DateTimeOriginal
// + offset, in GMT+7) — read before normalization, which re-encodes through a
// canvas and strips EXIF — falling back to the file's mtime labeled "saved".
async function downscaleImage(file: File): Promise<ChatImage> {
  const [n, exif] = await Promise.all([normalizeImage(file), readExifCapture(file)]);
  const captured = exif
    ? { capturedAt: exif.capturedAt, capturedAtSource: exif.source }
    : file.lastModified
      ? { capturedAt: new Date(file.lastModified).toISOString(), capturedAtSource: "file" as const }
      : { capturedAt: undefined, capturedAtSource: undefined };
  return {
    id: makeId(),
    dataUrl: n.dataUrl,
    fullDataUrl: n.fullDataUrl,
    mime: n.mime,
    name: file.name,
    ...captured,
  };
}

// Fold a prior image turn's reading into its text for the model, so a later turn
// references the image as cheap, cache-stable text without re-sending the bytes.
// The reading is the examine_image observation captured when the image was first
// read (see askLive); plain text when none was captured. De-duped because all of
// a turn's images share the one combined reading.
function imageText(m: Message): string {
  const ts = [...new Set((m.images ?? []).map((i) => i.transcript?.trim()).filter(Boolean))];
  if (ts.length === 0) return m.text;
  return `${m.text}\n\n[Earlier image, as the Advisor read it:]\n${ts.join("\n--- next image ---\n")}`;
}

const ACTIVE_THREAD_KEY = "macrotide_chat_active_thread";
// Per-device timestamp (ms) of the last interaction with the active thread, and
// the window within which reopening the app reopens that chat. After a longer
// idle gap the Advisor starts fresh instead (the old chat stays in history). All
// localStorage-scoped, so each device keeps its own last chat and its own timer.
const ACTIVE_THREAD_AT_KEY = "macrotide_chat_active_at";
const RESTORE_MAX_IDLE_MS = 4 * 60 * 60 * 1000; // 4 hours

// Stamp the active-thread pointer + "now", so a reopen within the window restores
// it. Called on every turn and on open, so active use keeps the timer fresh.
function rememberActiveThread(id: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ACTIVE_THREAD_KEY, id);
  window.localStorage.setItem(ACTIVE_THREAD_AT_KEY, String(Date.now()));
}
// Drop the pointer — on New Chat, or a stale/failed restore.
function forgetActiveThread() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(ACTIVE_THREAD_KEY);
  window.localStorage.removeItem(ACTIVE_THREAD_AT_KEY);
}
// The stored active-thread id, but only if it was touched within the idle window;
// otherwise null so the caller starts a fresh chat. A missing/old timestamp (e.g.
// a pointer written before this timer existed) counts as stale.
function freshActiveThreadId(): string | null {
  if (typeof window === "undefined") return null;
  const id = window.localStorage.getItem(ACTIVE_THREAD_KEY);
  if (!id) return null;
  const at = Number(window.localStorage.getItem(ACTIVE_THREAD_AT_KEY));
  if (!Number.isFinite(at) || Date.now() - at > RESTORE_MAX_IDLE_MS) return null;
  return id;
}

// Remove the trailing "[N image(s) attached]" marker the server stores in a
// user message (images aren't persisted server-side). Used on reload when we
// have the thumbnails to show, so the marker doesn't duplicate the preview.
function stripImageMarker(text: string): string {
  return text.replace(/\s*\[\d+ image(?:s)? attached\]\s*$/, "").trimEnd();
}

// Count attachments from a persisted message's JSON `attachments` column, so a
// device without the browser-cached thumbnails can still show a "[N images
// attached]" marker. Returns 0 for text turns / legacy rows / malformed JSON.
function attachmentCount(json: string | null | undefined): number {
  if (!json) return 0;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

// Parse the assistant row's `cards` column — the propose_* tool payloads persisted
// server-side so the in-chat tables / proposals survive reload and follow the user
// across devices (previously browser-only; see lib/stores/chat-cards.ts). Returns
// null for non-card turns / legacy rows / malformed JSON.
function parseCards(json: string | null | undefined): {
  holdingsImport?: HoldingsImport;
  transactionsImport?: TransactionsImport;
  holdings?: HoldingProposal[];
  proposal?: PlanProposal;
  // The authoritative ordered body for new rows.
  parts?: TurnPart[];
  // Legacy: pre-parts rows persisted memory events unordered. Synthesized into
  // parts on hydrate (text, then the chips) when `parts` is absent.
  memoryEvents?: MemoryEvent[];
} | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json);
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

// Rebuild an assistant turn's ordered parts when none were persisted (a legacy
// row written before `parts`): the prose as one text part, then any unordered
// memory chips after it — the most order recoverable. Returns undefined when
// there's nothing to render as parts. Accepts the loosely-typed cached memory
// events (browser `ChatCard`) and narrows their `kind`.
function synthesizeParts(
  text: string,
  legacy?: { kind: string; id: number; oldId?: number; category: string; content?: string }[],
): TurnPart[] | undefined {
  const parts: TurnPart[] = [];
  if (text.trim()) parts.push({ type: "text", text });
  for (const e of legacy ?? []) {
    parts.push({ type: "memory", event: { ...e, kind: e.kind as MemoryEvent["kind"] } });
  }
  return parts.length > 0 ? parts : undefined;
}

interface PlanProposal {
  section: string;
  rationale: string;
  add: string | null;
  rm: string | null;
}

// A holding the advisor proposed via the propose_holding tool. Mirrors the
// payload POST /api/holdings/propose accepts; rendered as a HoldingProposalCard.
interface HoldingProposal {
  ticker: string;
  englishName: string;
  thaiName: string | null;
  units: number;
  avgCost: number | null;
  ter: number | null;
  assetClass: string | null;
  region: string | null;
  quoteSource: string;
  bucketId: string | null;
  source: string | null;
  rationale: string;
}

// The advisor's propose_holdings_import tool output: a batch of extracted rows
// rendered as a compact in-chat table that opens the full importer pre-seeded.
interface HoldingsImport {
  rows: ImportSeedRow[];
  source: string | null;
  note: string | null;
}

// The advisor's propose_transactions_import tool output: a batch of dated trade
// rows (a buy/sell/dividend history) → a compact table that opens the importer.
interface TransactionsImport {
  rows: ExtractedTxnRow[];
  source: string | null;
  note: string | null;
}

// `MemoryEvent` is the shared `MemoryEventData` (imported above): a memory write
// the Advisor made this turn (save/update/forget/confirm), surfaced as a muted
// status line. It rides an ordered `memory` TurnPart so its position relative to
// the prose is preserved — no above/below guessing. The durable record lives in
// Journal → Memory; the audit surface ADR 0006 calls for.

interface Message {
  role: "user" | "ai";
  text: string;
  ts: number;
  // Stable identity for streaming updates. `ts` is for display only — two
  // messages can share a ms if they're queued in the same event-loop tick.
  id: string;
  // Images the user attached to this turn (downscaled). Shown as thumbnails;
  // kept in the browser only (localStorage), never persisted server-side.
  images?: ChatImage[];
  proposal?: PlanProposal;
  applied?: boolean;
  rejected?: boolean;
  // A batch holdings-import table (one per turn) from propose_holdings_import.
  holdingsImport?: HoldingsImport;
  // A batch transaction-import table from propose_transactions_import.
  transactionsImport?: TransactionsImport;
  // A turn can yield MANY holding proposals (one per extracted statement row),
  // so unlike `proposal` these are a keyed list with per-card accept/reject
  // state tracked by index.
  holdings?: HoldingProposal[];
  holdingStatus?: Record<number, "applied" | "rejected">;
  // The assistant turn's body as ordered parts — runs of prose interleaved with
  // memory-write indicators, in the order they happened. The render walks these;
  // `text` stays the flat prose join (copy / save / legacy). Persisted via
  // `cards.parts` so the ordering survives reload and crosses devices.
  parts?: TurnPart[];
  // Set on a failed/empty assistant turn so the UI can offer a "Try again"
  // button that re-sends the preceding user message.
  canRetry?: boolean;
  /** The model id that served this assistant message (null/undefined = unknown). */
  model?: string | null;
}

function makeId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Tidy a raw OpenRouter model id for the owner-only badge: drop the provider
// prefix and any trailing date stamp OpenRouter appends — e.g.
// "openai/gpt-5.5-20260423" → "gpt-5.5", "z-ai/glm-4.6" → "glm-4.6".
function prettyModel(id: string): string {
  return (id.split("/").pop() ?? id).replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "");
}

// A seed message can be a plain string (shown verbatim as the user turn) or a
// split { display, send } pair: `display` is the short visible bubble, `send`
// is the larger payload actually sent to the model. The OCR handoff uses the
// split form so the raw transcription stays out of the visible message body.
// The split form may also carry a structured `context` envelope (the screen +
// intent + a few pre-computed facts) so the server can answer without a tool
// round-trip — never shown in the bubble. See lib/advisor/entry-context.ts.
export type SeedPrompt =
  | string
  // `newChat` opens a fresh thread before sending — used for in-chat hand-offs so
  // a seeded request doesn't land in the conversation you're in.
  | { display: string; send: string; context?: EntryContext; newChat?: boolean }
  // The Journal → Memory "Edit" hand-off: open a fresh thread whose first turn is
  // a canned ADVISOR message (`opener`) asking what to change — no synthesized
  // user turn, no model call. The memory's content + body ride `context` and are
  // attached to the user's FIRST reply (see `editContext`), so the Advisor only
  // acts once the user has actually said what to change.
  | { opener: string; context?: EntryContext; newChat: true };

export interface ChatScreenProps {
  persona?: string;
  seedPrompt?: SeedPrompt | null;
  onPromptConsumed?: () => void;
  /** Opens the account menu from the topbar (mobile only; hidden in the dock). */
  onOpenMenu?: () => void;
  /**
   * The screen the composer is being shown against, so its starter suggestions
   * can reflect where the user is. Optional — omitted (or `null`) just drops the
   * screen-flavored chips and falls back to portfolio + evergreen prompts. This
   * is the existing app-shell `screen` state threaded down by callers, NOT a new
   * context abstraction (a sibling effort owns the formal Advisor context model;
   * see NOTES-22.md).
   */
  activeScreen?: AdvisorScreenContext | null;
}

function PlanProposalCard({
  proposal,
  applied,
  onApply,
  onReject,
}: {
  proposal: PlanProposal;
  applied?: boolean;
  onApply: () => void;
  onReject: () => void;
}) {
  if (applied === true) {
    return (
      <div
        className="plan-proposal"
        style={{ background: "var(--accent-soft)", borderColor: "transparent" }}
      >
        <div className="label">
          <span>✓ APPLIED TO YOUR PLAN · {proposal.section.toUpperCase()}</span>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--accent-ink)" }}>
          Saved to <strong style={{ fontWeight: 500 }}>{proposal.section}</strong>. View in Journal
          → Plan.
        </div>
      </div>
    );
  }
  if (applied === false) {
    return (
      <div
        className="plan-proposal"
        style={{ background: "var(--card-soft)", borderColor: "var(--line)" }}
      >
        <div
          style={{
            fontSize: 12,
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.04em",
          }}
        >
          ○ DISMISSED
        </div>
      </div>
    );
  }
  return (
    <div className="plan-proposal">
      <div className="label">
        <Icon name="sparkle" size={12} />
        <span>PLAN CHANGE · {proposal.section.toUpperCase()}</span>
      </div>
      <div className="diff">
        {proposal.rm && <span className="rm">{proposal.rm}</span>}
        {proposal.rm && proposal.add && "\n"}
        {proposal.add && <span className="add">{proposal.add}</span>}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.45 }}>
        {proposal.rationale}
      </div>
      <div className="actions">
        <button className="btn ghost sm" onClick={onReject}>
          Not now
        </button>
        <button className="btn primary sm" onClick={onApply} style={{ flex: 1 }}>
          <Icon name="check" size={12} /> Apply to plan
        </button>
      </div>
    </div>
  );
}

function HoldingProposalCard({
  holding,
  status,
  onApply,
  onReject,
}: {
  holding: HoldingProposal;
  status?: "applied" | "rejected";
  onApply: () => void;
  onReject: () => void;
}) {
  if (status === "applied") {
    return (
      <div
        className="plan-proposal"
        style={{ background: "var(--accent-soft)", borderColor: "transparent" }}
      >
        <div className="label">
          <span>✓ ADDED · {holding.ticker}</span>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--accent-ink)" }}>
          Saved to your portfolio. View it in your holdings.
        </div>
      </div>
    );
  }
  if (status === "rejected") {
    return (
      <div
        className="plan-proposal"
        style={{ background: "var(--card-soft)", borderColor: "var(--line)" }}
      >
        <div
          style={{
            fontSize: 12,
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.04em",
          }}
        >
          ○ SKIPPED · {holding.ticker}
        </div>
      </div>
    );
  }
  const facts = [
    `${holding.units} units`,
    holding.avgCost != null ? `@ ฿${holding.avgCost.toLocaleString()}` : null,
    holding.assetClass,
    holding.region,
  ].filter(Boolean);
  return (
    <div className="plan-proposal">
      <div className="label">
        <Icon name="sparkle" size={12} />
        <span>ADD HOLDING · {holding.ticker}</span>
      </div>
      <div className="diff">
        <span className="add">
          {holding.englishName}
          {facts.length > 0 ? `\n${facts.join(" · ")}` : ""}
        </span>
      </div>
      {holding.rationale && (
        <div style={{ fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.45 }}>
          {holding.rationale}
        </div>
      )}
      <div className="actions">
        <button className="btn ghost sm" onClick={onReject}>
          Skip
        </button>
        <button className="btn primary sm" onClick={onApply} style={{ flex: 1 }}>
          <Icon name="check" size={12} /> Add to portfolio
        </button>
      </div>
    </div>
  );
}

// Compact, read-only summary of a batch of extracted holdings (from the
// propose_holdings_import tool), with a button that opens the full importer
// pre-seeded with these rows for review/edit/bulk-save (see lib/stores/import-seed).
function HoldingsImportCard({ data, onOpen }: { data: HoldingsImport; onOpen: () => void }) {
  const fmt = (n: number | undefined) =>
    n === undefined || !Number.isFinite(n) ? "—" : String(Math.round(n * 1e4) / 1e4);
  return (
    <div className="plan-proposal">
      <div className="label">
        <Icon name="sparkle" size={12} />
        <span>
          REVIEW HOLDINGS · {data.rows.length} ROW{data.rows.length === 1 ? "" : "S"}
        </span>
      </div>
      {data.note && (
        <div style={{ fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.45 }}>
          {data.note}
        </div>
      )}
      <table className="chat-import-table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th style={{ textAlign: "right" }}>Units</th>
            <th style={{ textAlign: "right" }}>Avg cost</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: import-preview rows can share a ticker and never reorder
            <tr key={`${r.ticker}-${i}`}>
              <td data-label="Symbol">
                <span className="t">{r.ticker}</span>
              </td>
              <td data-label="Units" style={{ textAlign: "right" }}>
                {r.needsUnits ? (
                  <span className="flag">needs units</span>
                ) : (
                  <>
                    {fmt(r.units)}
                    {r.estimated && <span className="flag est">estimated</span>}
                  </>
                )}
              </td>
              <td data-label="Avg cost" style={{ textAlign: "right" }}>
                {fmt(r.avgCost)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        <button className="btn primary sm" onClick={onOpen} style={{ flex: 1 }}>
          <Icon name="arrowRight" size={12} /> Review &amp; import
        </button>
      </div>
    </div>
  );
}

// Compact in-chat table for a batch of dated TRANSACTIONS (propose_transactions_import),
// with a button that opens the importer pre-seeded with these trades.
function TransactionsImportCard({
  data,
  onOpen,
}: {
  data: TransactionsImport;
  onOpen: () => void;
}) {
  const fmt = (n: number | undefined) =>
    n === undefined || !Number.isFinite(n) ? "—" : String(Math.round(n * 1e4) / 1e4);
  return (
    <div className="plan-proposal">
      <div className="label">
        <Icon name="sparkle" size={12} />
        <span>
          REVIEW TRANSACTIONS · {data.rows.length} ROW{data.rows.length === 1 ? "" : "S"}
        </span>
      </div>
      {data.note && (
        <div style={{ fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.45 }}>
          {data.note}
        </div>
      )}
      <table className="chat-import-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Symbol</th>
            <th>Type</th>
            <th style={{ textAlign: "right" }}>Units</th>
            <th style={{ textAlign: "right" }}>Price</th>
            <th style={{ textAlign: "right" }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: import-preview rows can share ticker+date and never reorder
            <tr key={`${r.ticker}-${r.tradeDate ?? ""}-${i}`}>
              <td data-label="Date">{r.tradeDate ?? "—"}</td>
              <td data-label="Symbol">
                <span className="t">{r.ticker}</span>
              </td>
              <td data-label="Type">{r.kind ?? "—"}</td>
              <td data-label="Units" style={{ textAlign: "right" }}>
                {fmt(r.units)}
              </td>
              <td data-label="Price" style={{ textAlign: "right" }}>
                {fmt(r.pricePerUnit)}
              </td>
              <td data-label="Total" style={{ textAlign: "right" }}>
                {fmt(r.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        <button className="btn primary sm" onClick={onOpen} style={{ flex: 1 }}>
          <Icon name="arrowRight" size={12} /> Review &amp; import
        </button>
      </div>
    </div>
  );
}

// A quiet grey status line under a turn — "Memory updated" etc. Deliberately
// minimal: no chip, no border, no leading icon. Clicking it expands
// to reveal what changed, with a "View in Memory" link to the durable record in
// Journal → Memory. The visible audit surface ADR 0006 calls for, kept minimal.
const MEMORY_VERB: Record<MemoryEvent["kind"], string> = {
  save: "saved",
  update: "updated",
  forget: "removed",
  confirm: "confirmed",
};

function MemoryEventLine({ event }: { event: MemoryEvent }) {
  const [open, setOpen] = useState(false);
  const label = `Memory ${MEMORY_VERB[event.kind]}`;
  return (
    <div className="memory-event" data-open={open || undefined}>
      <button
        type="button"
        className="me-line"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span>{label}</span>
        <Icon name="chevron-right" size={13} className="me-caret" />
      </button>
      {open && (
        <div className="me-detail">
          {event.content && <div className="me-content">{event.content}</div>}
          <button
            type="button"
            className="me-manage"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("open-journal", { detail: "memory" }))
            }
          >
            View in Memory →
          </button>
        </div>
      )}
    </div>
  );
}

// The Advisor's opening line is UI chrome — a centered welcome shown on an empty
// thread (ChatGPT/Claude style), NOT a seeded assistant message. Keeping it out of
// `messages` means it's never sent to the model and never lingers once the chat
// starts. EMPTY_THREAD is the canonical "no messages" value AND the stable-reference
// sentinel the deferred new-chat / edit-opener effects compare against
// (`messages === EMPTY_THREAD`) — so it must stay a single shared reference and is
// only ever replaced, never mutated in place (every messages update returns a new array).
const INTRO_GREETING =
  "Hi, I'm your index-investing advisor. Ask me about your portfolio, your plan, or how index investing works. If you don't have a plan yet, say \"help me write my plan\" and I'll walk you through it.";
const EMPTY_THREAD: Message[] = [];

export function ChatScreen({
  persona = "advisor",
  seedPrompt,
  onPromptConsumed,
  onOpenMenu,
  activeScreen,
}: ChatScreenProps) {
  void persona; // single advisor persona for MVP

  // The thread starts empty — the opening greeting is UI chrome (the centered
  // welcome, see INTRO_GREETING / isIntro below), not a seeded assistant message.
  const [messages, setMessages] = useState<Message[]>(EMPTY_THREAD);
  // Gate the welcome until we know whether a previously-open thread will hydrate,
  // so reloading into an existing conversation doesn't flash the welcome first.
  // Reading localStorage at init is safe: the whole App is loaded ssr:false
  // (components/ClientApp.tsx), so ChatScreen never server-renders. A fresh start
  // (no stored thread, or a "new chat" hand-off) is settled immediately; a pending
  // restore is settled once the mount effect's load attempt resolves.
  const [restoreSettled, setRestoreSettled] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    if (seedPrompt && typeof seedPrompt === "object" && seedPrompt.newChat) return true;
    // Only gate the welcome when there's a recent chat to restore; an idle-past-the-
    // window (or absent) pointer means a fresh start, settled immediately.
    return freshActiveThreadId() === null;
  });
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  // A new-chat seed (Journal → Memory "Edit") queued until newChat() resets the
  // history, so it sends into the fresh thread rather than the one we left.
  const [pendingNewChatSeed, setPendingNewChatSeed] = useState<{
    display: string;
    send: string;
    context?: EntryContext;
  } | null>(null);
  // The Journal → Memory "Edit" hand-off (canned Advisor opener), queued until
  // newChat() resets the history — then it replaces the greeting with the opener
  // and stashes `context` as `editContext` for the user's first reply.
  const [pendingEditOpener, setPendingEditOpener] = useState<{
    opener: string;
    context?: EntryContext;
  } | null>(null);
  // Entry context that must ride the user's NEXT turn (not the current messages):
  // the edited memory's content + body, set when the edit opener lands and
  // consumed by the first composer send so the Advisor knows which memory to
  // change and its full current detail.
  const [editContext, setEditContext] = useState<EntryContext | null>(null);
  // The centered welcome (INTRO_GREETING) shows only before the conversation
  // starts. The pending-seed/opener guards keep it from flashing during a
  // Journal → Memory hand-off, where newChat() empties `messages` for one render
  // before the queued seed or canned opener lands.
  const isIntro =
    restoreSettled && messages.length === 0 && !pendingNewChatSeed && !pendingEditOpener;
  // Pending image attachments for the next turn (downscaled), plus a click-to-
  // enlarge lightbox. Whether the attach affordance shows at all is gated by the
  // server-computed capability below (vision on + demo allows it).
  const [attachments, setAttachments] = useState<ChatImage[]>([]);
  const [lightbox, setLightbox] = useState<string | null>(null);
  // Transient note when a multi-file pick is truncated to the cap, so the
  // dropped images aren't silently discarded. Cleared on the next clean add /
  // removal / send.
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: caps } = useResource<{ imageUpload: boolean }>("/api/chat/capabilities");
  const imageUploadEnabled = caps?.imageUpload === true;
  // Operator-only: the served-model badge on each assistant message is a
  // diagnostic (which model answered, while A/B-ing), hidden from regular users
  // so the raw model slug never breaks the "Advisor" persona. Shown to the owner
  // (same source the App shell uses to gate the Admin entry; the GET is deduped),
  // and always in local dev — where AUTH_DISABLED has no owner session but the
  // developer is effectively the operator. NODE_ENV is inlined at build, so this
  // can never expose the badge in a production bundle.
  const { data: adminStatus } = useResource<{ isOwner: boolean }>("/api/admin/status");
  const showModelBadge = (adminStatus?.isOwner ?? false) || process.env.NODE_ENV === "development";
  // "Saved to notes" is DERIVED from the durable journal notes — a bookmark
  // stores the reply text as a note body — so the bookmark reflects reality and
  // survives tab switches, reloads, and other devices (no ephemeral per-session
  // flag to reset). Keyed by body text → the note id (for the un-save toggle).
  const { data: journalNotes } =
    useResource<{ id: number; kind: string; body: string }[]>("/api/journal");
  const savedNoteIdByBody = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of journalNotes ?? []) {
      if (n.kind === "note" && n.body) map.set(n.body, n.id);
    }
    return map;
  }, [journalNotes]);
  const [showThreads, setShowThreads] = useState(false);
  // Set when the server signals it crossed ~80% of the model context budget
  // (header `x-context-summarized`). Earlier turns are summarized in the
  // model's input view; we surface a banner suggesting a fresh chat rather
  // than condensing silently. See docs/explanation/memory.md § mid-chat.
  const [contextNotice, setContextNotice] = useState(false);
  // Set when the server rejects a turn because the user hit their daily token
  // budget (header `x-daily-limit`). Resets at UTC midnight
  // server-side; the banner just nudges the user to come back.
  const [limitNotice, setLimitNotice] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  // Replace the chat stream's native scrollbar with the app-standard overlay
  // scrollbar (os-theme-macrotide), same as the side panels and main column.
  // Desktop/tablet only (the hook no-ops on mobile/touch, which keeps native).
  // OverlayScrollbars re-parents the stream's children into a generated viewport,
  // so the children live under one stable `.chat-stream-content` wrapper (below)
  // and auto-scroll targets that viewport (see the scroll effect).
  const streamOsRef = useOverlayScrollbar();
  // The composer textarea can't host OverlayScrollbars (it re-parents child DOM;
  // a textarea has none), so it gets a thin overlay-style scrollbar on a fine
  // pointer and the native one on touch — gated by the same signal the rest of
  // the app uses, so behavior matches.
  const customScroll = usePointer();
  const setStreamRef = useCallback(
    (node: HTMLDivElement | null) => {
      streamRef.current = node;
      streamOsRef(node);
    },
    [streamOsRef],
  );
  // Tracks which thread ids we've already tried to title in this session, so
  // a slow title-endpoint response doesn't get re-fired while the user keeps
  // chatting. The server is idempotent regardless, but this saves the round
  // trip + the SWR invalidate churn.
  const titledRef = useRef<Set<string>>(new Set());
  // Mirror of threadId for callbacks that must not re-bind on every switch
  // (e.g. newChat reads it without taking threadId as a dep).
  const threadIdRef = useRef<string | null>(null);
  useEffect(() => {
    threadIdRef.current = threadId;
  }, [threadId]);
  // True once the user has sent a message into the current thread that hasn't
  // been closed yet. Gates the close beacon so we never spend an extraction
  // model call on a session with no NEW activity — a refresh, or reopening a
  // thread just to read it. Token-efficiency: extract only when there's
  // something new to extract, and only once per session.
  const dirtyRef = useRef(false);

  // Real-time session close for the OUTGOING thread — on New Chat, thread
  // switch, or the page going away (pagehide). The server extracts durable
  // facts + marks the thread idle (lib/memory/session-close.ts), once per
  // session. Fire-and-forget: idempotent + best-effort server-side, so we
  // ignore the response. Prefers `sendBeacon` (survives unload) with a
  // keepalive `fetch` fallback. No-ops unless the session is dirty.
  const closeOutgoing = useCallback((id: string | null) => {
    if (!id || !dirtyRef.current || typeof navigator === "undefined") return;
    dirtyRef.current = false;
    const url = `/api/chat/threads/${encodeURIComponent(id)}/close`;
    if (typeof navigator.sendBeacon === "function" && navigator.sendBeacon(url)) return;
    void fetch(url, { method: "POST", keepalive: true }).catch(() => {});
  }, []);

  // Close the active session when the page goes away (tab/window close,
  // navigation, bfcache). `pagehide` is the reliable unload signal;
  // `beforeunload` is not. This is what catches "user closed the window
  // without clicking New Chat".
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onHide = () => closeOutgoing(threadIdRef.current);
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [closeOutgoing]);

  const loadThread = useCallback(
    async (id: string): Promise<boolean> => {
      // Close the thread we're leaving (no-op on first load / same thread).
      if (id !== threadIdRef.current) closeOutgoing(threadIdRef.current);
      try {
        const res = await fetch(`/api/chat/threads/${encodeURIComponent(id)}`);
        if (!res.ok) return false;
        const { messages: rows } = (await res.json()) as {
          messages: Array<{
            id: number;
            role: string;
            content: string;
            createdAt: string;
            model?: string | null;
            // JSON-encoded ChatAttachmentMeta[] for an image turn; NULL otherwise.
            attachments?: string | null;
            // JSON-encoded propose_* card payloads for an assistant turn; NULL otherwise.
            cards?: string | null;
          }>;
        };
        setThreadId(id);
        rememberActiveThread(id);
        // Re-attach any browser-cached images to their turns. Keyed by the
        // 0-based index of the user message within the thread (deterministic and
        // append-only), so the send path and this reload path agree without a
        // server-side image id. See lib/stores/chat-images.ts.
        const storedImages = loadChatThreadImages(id);
        // Re-attach any browser-cached import cards to their assistant reply,
        // keyed by the same user-turn index the send path used.
        const storedCards = loadChatThreadCards(id);
        let userSeq = -1;
        setMessages(
          rows.length === 0
            ? EMPTY_THREAD
            : rows.map((r) => {
                const isUser = r.role !== "assistant";
                if (isUser) userSeq += 1;
                const imgs = isUser ? storedImages.get(userSeq) : undefined;
                // Prefer the server-persisted cards; fall back to the browser
                // cache for threads written before the `cards` column existed.
                const dbCards = isUser ? null : parseCards(r.cards);
                const card = isUser ? undefined : storedCards.get(userSeq);
                // Images aren't persisted server-side, so a device without the
                // browser-cached thumbnails needs a "[N images attached]" marker
                // to show something was attached. New rows store raw text plus a
                // structured attachment count, so we synthesize the marker from
                // that count here. When we DO have the thumbnails, show them and
                // drop the marker (legacy rows baked it into `content`). Legacy
                // rows with no metadata keep whatever marker is in `content`.
                const count = isUser ? attachmentCount(r.attachments) : 0;
                const text = imgs?.length
                  ? stripImageMarker(r.content)
                  : count > 0
                    ? withImageMarker(stripImageMarker(r.content), count)
                    : r.content;
                return {
                  role: r.role === "assistant" ? "ai" : "user",
                  text,
                  ts: Date.parse(r.createdAt) || Date.now(),
                  id: `db-${r.id}`,
                  model: r.model ?? null,
                  images: imgs,
                  holdingsImport: dbCards?.holdingsImport ?? card?.holdingsImport,
                  transactionsImport: dbCards?.transactionsImport ?? card?.transactionsImport,
                  holdings: dbCards?.holdings,
                  proposal: dbCards?.proposal,
                  // Prefer the server-persisted ordered parts (cross-device), then
                  // the browser cache; for legacy rows with neither, synthesize
                  // parts from the prose + unordered memory events (text, then the
                  // chips — the most order we can recover).
                  parts: isUser
                    ? undefined
                    : (dbCards?.parts ??
                      card?.parts ??
                      synthesizeParts(text, dbCards?.memoryEvents ?? card?.memoryEvents)),
                } as Message;
              }),
        );
        setContextNotice(false);
        return true;
      } catch {
        return false;
      }
    },
    [closeOutgoing],
  );

  // Hydrate the most recently active thread on mount. If the server doesn't
  // know about the stored id (e.g. demo session restarted, DB wiped), we silently
  // discard the stale id and start fresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only restore; reading seedPrompt at mount is intentional and must not retrigger
  useEffect(() => {
    if (typeof window === "undefined") return;
    // A pending "edit in a new chat" seed (Journal → Memory) must win over thread
    // restoration — don't load the last thread, or it would clobber the fresh chat.
    // Fresh-start paths (new-chat hand-off, no stored thread) are already settled
    // by the restoreSettled initializer, so the welcome shows without delay.
    if (seedPrompt && typeof seedPrompt === "object" && seedPrompt.newChat) return;
    // Only reopen the last chat if it was active within the idle window; after a
    // longer gap (or with no pointer) start fresh — the old chat stays in history.
    const stored = freshActiveThreadId();
    if (!stored) {
      forgetActiveThread();
      setRestoreSettled(true);
      return;
    }
    let cancelled = false;
    (async () => {
      const ok = await loadThread(stored);
      if (cancelled) return;
      if (!ok) forgetActiveThread();
      // Restore resolved — reveal the welcome if the thread was stale (no rows).
      setRestoreSettled(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadThread]);

  const newChat = useCallback(() => {
    // Close the session we're leaving before clearing it (real-time extraction).
    closeOutgoing(threadIdRef.current);
    forgetActiveThread();
    setThreadId(null);
    setMessages(EMPTY_THREAD);
    setContextNotice(false);
    setAttachments([]);
    setAttachNotice(null);
    setEditContext(null);
  }, [closeOutgoing]);

  // ── Image attachments ────────────────────────────────────────────────────
  // Downscale + stage image files (from the picker, drag-drop, or paste),
  // capped at MAX_ATTACHMENTS. Non-image files are ignored.
  const addFiles = useCallback(
    async (files: File[]) => {
      if (!imageUploadEnabled || loading) return;
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return;
      const room = MAX_ATTACHMENTS - attachments.length;
      if (room <= 0) {
        setAttachNotice(`Advisor reads up to ${MAX_ATTACHMENTS} images per message.`);
        return;
      }
      const skipped = images.length - room;
      setAttachNotice(
        skipped > 0
          ? `Added ${room} — Advisor reads up to ${MAX_ATTACHMENTS} images per message, so ${skipped} ${skipped === 1 ? "was" : "were"} skipped. For a larger batch, use Add to portfolio → Images.`
          : null,
      );
      const processed = await Promise.all(images.slice(0, room).map(downscaleImage));
      setAttachments((prev) => [...prev, ...processed].slice(0, MAX_ATTACHMENTS));
    },
    [imageUploadEnabled, loading, attachments.length],
  );

  const removeAttachment = (idx: number) => {
    setAttachNotice(null);
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  // Keyboard shortcut: ⌘/Ctrl+K opens a new chat. We swallow the event so the
  // browser's "search bar" default (Firefox) doesn't also fire. Disabled
  // while a turn is in flight — same constraint as the topbar's "New chat"
  // button.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod || e.key.toLowerCase() !== "k") return;
      if (loading) return;
      e.preventDefault();
      newChat();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [newChat, loading]);

  // Cross-component coordination with the in-panel thread list (desktop/tablet
  // right rail). The list lives in ChatPanel, which can't reach this component's
  // threadId/loadThread/newChat directly — so we go through the shared chat UI
  // store (lib/stores/chat-ui.ts) instead of window events. Mobile keeps driving
  // the drawer through props and ignores this.
  const { loadTarget, newNonce } = useChatUi();

  // Publish the active thread so the panel list highlights the right row.
  useEffect(() => {
    setActiveThreadId(threadId);
  }, [threadId]);

  // Consume the panel's "load this thread" intent (fires once, then clears).
  useEffect(() => {
    if (loadTarget && loadTarget !== threadIdRef.current) void loadThread(loadTarget);
    consumeLoadTarget();
  }, [loadTarget, loadThread]);

  // Consume the panel's "new chat" intent. nonce 0 is the initial state, not a
  // request, so only act once it increments.
  const handledNewNonce = useRef(0);
  useEffect(() => {
    if (newNonce !== handledNewNonce.current) {
      handledNewNonce.current = newNonce;
      if (newNonce > 0) newChat();
    }
  }, [newNonce, newChat]);

  /**
   * Fire-and-forget auto-title trigger. Called after the first turn pair
   * completes on a brand-new thread. The server is idempotent so a duplicate
   * POST is harmless; `titledRef` just avoids the redundant round trip.
   */
  const maybeAutoTitle = useCallback(async (id: string) => {
    if (titledRef.current.has(id)) return;
    titledRef.current.add(id);
    try {
      const res = await fetch(`/api/chat/threads/${encodeURIComponent(id)}/title`, {
        method: "POST",
      });
      if (!res.ok) {
        // Allow a retry on the next turn-pair completion — the server probably
        // just didn't have the assistant message persisted yet.
        titledRef.current.delete(id);
        return;
      }
      // Refresh the sidebar so the new title surfaces next time the drawer
      // opens. Matches the existing SWR pattern in this file.
      void invalidate("/api/chat/threads");
    } catch {
      titledRef.current.delete(id);
    }
  }, []);

  // Auto-scroll to the bottom whenever messages grow or the streaming text
  // changes. We track the last message's text length so streamed deltas tick
  // the effect without re-rendering it on every keystroke in the composer.
  const lastText = messages[messages.length - 1]?.text ?? "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: both deps are intentional re-run triggers (new message / streamed delta); the effect only touches the DOM
  useEffect(() => {
    const host = streamRef.current;
    if (!host) return;
    // On desktop the overlay scrollbar moves the content into a generated
    // viewport child, so the host itself no longer scrolls — scroll that. On
    // mobile/native there's no viewport and the host scrolls directly.
    const scroller = host.querySelector<HTMLElement>("[data-overlayscrollbars-viewport]") ?? host;
    scroller.scrollTop = scroller.scrollHeight;
  }, [messages.length, lastText]);

  const askLive = async (
    prompt: string,
    history: Message[],
    context?: EntryContext,
    attached: ChatImage[] = [],
  ) => {
    setLoading(true);
    // New user turn → this session now has content worth extracting when it
    // closes (gates the close beacon; see closeOutgoing).
    dirtyRef.current = true;
    const hasImages = attached.length > 0;
    // Index of this user turn within the thread (for the image localStorage key).
    const userSeq = history.filter((m) => m.role === "user").length;

    // Prior image turns carry their READING as text (imageText) — the vision
    // model's observation captured when the image was first read — never the
    // bytes, so a follow-up references the image without re-running the vision
    // path or busting the prompt cache. Only THIS turn's freshly-attached images
    // go as `file` parts; the server strips them from the chat driver and reads
    // them via the examine_image tool. Text-only turns keep the compact
    // `{role, content}` shape so the prefix cache stays warm.
    // The model-facing attachment note (file name + EXIF/saved capture time) is
    // composed SERVER-SIDE from the structured `attachments` metadata below, so
    // it never leaks into the displayed bubble or the persisted message. Here
    // `turnText` is just the user's raw prompt.
    const turnText = prompt;
    const stringPayload = [
      // The `proposal` field is UI-only metadata and is never forwarded (we only
      // pass role + text), but the assistant prose that accompanied a proposal IS
      // part of the conversation, so keep these turns.
      ...history.map((m) => ({
        role: m.role === "ai" ? "assistant" : "user",
        content: imageText(m),
      })),
      { role: "user" as const, content: turnText },
    ];
    const uiPayload = [
      ...history.map((m) => ({
        role: m.role === "ai" ? "assistant" : "user",
        parts: [{ type: "text", text: imageText(m) }],
      })),
      {
        role: "user" as const,
        parts: [
          ...(turnText ? [{ type: "text", text: turnText }] : []),
          ...attached.map((a) => ({ type: "file", mediaType: a.mime, url: a.dataUrl })),
        ],
      },
    ];
    const payload = hasImages ? uiPayload : stringPayload;

    // Reserve the placeholder assistant message we'll stream into.
    const placeholderId = makeId();
    setMessages((m) => [...m, { role: "ai", text: "", ts: Date.now(), id: placeholderId }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: payload,
          threadId: threadId ?? undefined,
          // Structured entry context (screen/intent/signals) from an Ask-Advisor
          // button, when present — lets the server skip a tool round-trip. Omitted
          // for ordinary typed turns, so the body is byte-identical to before.
          entryContext: context,
          // Per-image metadata (filename + capture time/source) for an image
          // turn — the server validates it, composes the model-facing note, and
          // persists it. Omitted for text turns so their body is unchanged.
          attachments: hasImages
            ? attached.map((a) => ({
                name: a.name,
                mime: a.mime,
                capturedAt: a.capturedAt,
                capturedAtSource: a.capturedAtSource,
              }))
            : undefined,
        }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`chat failed (${res.status})`);
      }
      const ctxHeader = res.headers.get("x-context-summarized");
      if (ctxHeader === "1" || ctxHeader === "over") setContextNotice(true);
      // Daily token budget hit — the server streams a plain-text explanation
      // (rendered as the assistant turn) and flags it here so we also show a
      // dismissible banner above the composer.
      if (res.headers.get("x-daily-limit") === "reached") setLimitNotice(true);
      const returnedThread = res.headers.get("x-thread-id");
      if (returnedThread && returnedThread !== threadId) {
        setThreadId(returnedThread);
      }
      // Refresh the active-thread pointer + idle timer on every turn, so an
      // actively-used chat stays restorable and only goes stale after a quiet gap.
      const activeThread = returnedThread ?? threadId;
      if (activeThread) rememberActiveThread(activeThread);
      // Cache this turn's images in the browser (never server-side) so they
      // survive a reload, keyed by the user-message index in this thread.
      const tidForImages = returnedThread ?? threadId;
      if (hasImages && tidForImages) saveChatImages(tidForImages, userSeq, attached);
      // Refresh the sidebar so the new/updated thread surfaces next time
      // the drawer opens.
      void invalidate("/api/chat/threads");

      // The route returns a UI message stream — each line is `data: <json>`.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";
      // Tool confirmations collected from the stream. A model can run a tool
      // (e.g. save_preference) and end its turn without emitting any prose —
      // some cheaper models do this routinely. We surface the tool's own
      // message so the turn is never blank when work actually happened.
      const toolMessages: string[] = [];
      // examine_image observations — the vision model's reading of this turn's
      // image(s). Captured here and folded onto the turn's images after the
      // stream (see below) so later turns can reference them as text.
      const visionObservations: string[] = [];
      // propose_holding can fire multiple times in one turn (one per extracted
      // statement row). Accumulate them here and attach the growing list to the
      // streaming assistant message so each card appears as it arrives.
      const holdingProposals: HoldingProposal[] = [];
      // The turn's body as ordered parts: prose runs interleaved with memory
      // indicators, in arrival order. The trailing text part grows with each
      // delta; a memory event closes it so the next prose starts a fresh part —
      // so order is positional, no above/below flag. Persisted via cards.parts.
      const parts: TurnPart[] = [];

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const event = JSON.parse(payload);
            // UIMessage stream emits various event types; collect text from
            // any text-delta or text shape so we work regardless of which
            // event variant the model emits.
            const delta: string | undefined =
              event.delta ?? event.text ?? event.textDelta ?? undefined;
            if (delta && (event.type?.startsWith("text") || !event.type)) {
              accumulated += delta;
              // Grow the trailing text part (or open one) so prose stays one
              // block until a memory event splits it.
              const last = parts[parts.length - 1];
              if (last?.type === "text") {
                parts[parts.length - 1] = { type: "text", text: last.text + delta };
              } else {
                parts.push({ type: "text", text: delta });
              }
              const snapshot = [...parts];
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === placeholderId ? { ...m, text: accumulated, parts: snapshot } : m,
                ),
              );
            }
            // Served model id (transient part from the route) — attach it to the
            // live message so the owner's badge shows without a reload. Rendering
            // is gated to the owner below; non-owners just ignore the value.
            if (event.type === "data-model" && typeof event.data === "string") {
              const servedModel = event.data;
              setMessages((prev) =>
                prev.map((m) => (m.id === placeholderId ? { ...m, model: servedModel } : m)),
              );
            }
            // Tool result, regardless of the exact event variant: our memory
            // tools return `{ message: string }`. Pull it from common shapes.
            const toolOut: unknown = event.output ?? event.result ?? undefined;
            if (toolOut && typeof toolOut === "object" && "message" in toolOut) {
              const msg = (toolOut as { message?: unknown }).message;
              if (typeof msg === "string" && msg.trim()) toolMessages.push(msg.trim());
            }
            // Memory write (save/update/forget/confirm) — the tool returns a
            // structured `memoryEvent` we turn into a muted status line + Undo.
            if (toolOut && typeof toolOut === "object" && "memoryEvent" in toolOut) {
              const ev = (toolOut as { memoryEvent?: unknown }).memoryEvent;
              if (ev && typeof ev === "object" && "kind" in ev && "id" in ev) {
                const raw = ev as Partial<MemoryEvent>;
                const memEvent: MemoryEvent = {
                  kind: raw.kind ?? "save",
                  id: Number(raw.id),
                  oldId: raw.oldId,
                  category: String(raw.category ?? "fact"),
                  content: typeof raw.content === "string" ? raw.content : undefined,
                };
                // Close the open text part: this memory write lands here, in order.
                parts.push({ type: "memory", event: memEvent });
                const snapshot = [...parts];
                setMessages((prev) =>
                  prev.map((m) => (m.id === placeholderId ? { ...m, parts: snapshot } : m)),
                );
                // Browser fallback to the server-side `cards.parts` so the
                // interleaved render survives reload.
                if (tidForImages) {
                  saveChatCard(tidForImages, userSeq, { parts: snapshot });
                }
              }
            }
            // propose_plan_edit emits a `proposal` in its tool output (the
            // PlanProposal shape the card expects). Attach it to the streaming
            // assistant message so PlanProposalCard renders with Accept/Not now.
            if (toolOut && typeof toolOut === "object" && "proposal" in toolOut) {
              const p = (toolOut as { proposal?: unknown }).proposal;
              if (p && typeof p === "object" && "section" in p && "add" in p) {
                const raw = p as Partial<PlanProposal>;
                const proposal: PlanProposal = {
                  section: String(raw.section ?? "Plan"),
                  rationale: String(raw.rationale ?? ""),
                  add: raw.add ?? null,
                  rm: raw.rm ?? null,
                };
                setMessages((prev) =>
                  prev.map((m) => (m.id === placeholderId ? { ...m, proposal } : m)),
                );
              }
            }
            // propose_holding emits a `holding` in its tool output. Collect each
            // one and re-attach the full list so the cards render incrementally.
            if (toolOut && typeof toolOut === "object" && "holding" in toolOut) {
              const h = (toolOut as { holding?: unknown }).holding;
              if (h && typeof h === "object" && "ticker" in h && "units" in h) {
                const raw = h as Partial<HoldingProposal>;
                holdingProposals.push({
                  ticker: String(raw.ticker ?? ""),
                  englishName: String(raw.englishName ?? raw.ticker ?? ""),
                  thaiName: raw.thaiName ?? null,
                  units: Number(raw.units ?? 0),
                  avgCost: raw.avgCost ?? null,
                  ter: raw.ter ?? null,
                  assetClass: raw.assetClass ?? null,
                  region: raw.region ?? null,
                  quoteSource: String(raw.quoteSource ?? "market"),
                  bucketId: raw.bucketId ?? null,
                  source: raw.source ?? null,
                  rationale: String(raw.rationale ?? ""),
                });
                const snapshot = [...holdingProposals];
                setMessages((prev) =>
                  prev.map((m) => (m.id === placeholderId ? { ...m, holdings: snapshot } : m)),
                );
              }
            }
            // propose_holdings_import emits a `holdingsImport` batch — attach it
            // so HoldingsImportCard renders the compact table + open-importer CTA.
            if (toolOut && typeof toolOut === "object" && "holdingsImport" in toolOut) {
              const hi = (toolOut as { holdingsImport?: unknown }).holdingsImport;
              if (hi && typeof hi === "object" && Array.isArray((hi as { rows?: unknown }).rows)) {
                const raw = hi as { rows: ImportSeedRow[]; source?: unknown; note?: unknown };
                const holdingsImport: HoldingsImport = {
                  rows: raw.rows,
                  source: typeof raw.source === "string" ? raw.source : null,
                  note: typeof raw.note === "string" ? raw.note : null,
                };
                setMessages((prev) =>
                  prev.map((m) => (m.id === placeholderId ? { ...m, holdingsImport } : m)),
                );
                // Persist the card (browser-only, like images) so it survives a
                // reload — the server stores only the assistant's text.
                if (tidForImages) saveChatCard(tidForImages, userSeq, { holdingsImport });
              }
            }
            // propose_transactions_import emits a `transactionsImport` batch —
            // attach it so TransactionsImportCard renders the dated-trade table.
            if (toolOut && typeof toolOut === "object" && "transactionsImport" in toolOut) {
              const ti = (toolOut as { transactionsImport?: unknown }).transactionsImport;
              if (ti && typeof ti === "object" && Array.isArray((ti as { rows?: unknown }).rows)) {
                const raw = ti as { rows: ExtractedTxnRow[]; source?: unknown; note?: unknown };
                const transactionsImport: TransactionsImport = {
                  rows: raw.rows,
                  source: typeof raw.source === "string" ? raw.source : null,
                  note: typeof raw.note === "string" ? raw.note : null,
                };
                setMessages((prev) =>
                  prev.map((m) => (m.id === placeholderId ? { ...m, transactionsImport } : m)),
                );
                if (tidForImages) saveChatCard(tidForImages, userSeq, { transactionsImport });
              }
            }
            // examine_image returns `{ observation }`: the vision model's reading
            // of an attached image. Collect it as this turn's image reading.
            if (toolOut && typeof toolOut === "object" && "observation" in toolOut) {
              const obs = (toolOut as { observation?: unknown }).observation;
              if (typeof obs === "string" && obs.trim()) visionObservations.push(obs.trim());
            }
          } catch {
            // Some events are not JSON (heartbeats, [DONE]); ignore.
          }
        }
      }

      // Fold the vision model's reading onto this turn's image(s) as a transcript
      // — persisted (browser-only) and re-sent as text on later turns (imageText)
      // so the Advisor can reference the image without re-uploading the bytes.
      if (hasImages && visionObservations.length && tidForImages && attached.length) {
        const transcript = visionObservations.join("\n\n");
        const withTranscript = attached.map((a) => ({ ...a, transcript }));
        saveChatImages(tidForImages, userSeq, withTranscript);
        const firstId = attached[0]?.id;
        setMessages((prev) =>
          prev.map((m) =>
            m.role === "user" && m.images?.some((i) => i.id === firstId)
              ? { ...m, images: withTranscript }
              : m,
          ),
        );
      }

      // Fail-safe: if the model emitted no prose, fall back to the tool
      // confirmation(s); if there were none either, show a calm note rather
      // than a scary "check server logs" message. The dashboard is unaffected
      // regardless of what the LLM did.
      if (!accumulated) {
        const hadTool = toolMessages.length > 0;
        // Image turns that come back empty are usually a vision-model hiccup
        // (provider error / a model that can't read the image) — say so and
        // invite a retry, rather than the generic "no reply" line.
        const fallback = hadTool
          ? toolMessages.join("\n\n")
          : hasImages
            ? "I couldn't read that image just now — please try again in a moment. Your dashboard and notes are unaffected."
            : "I didn't have a reply for that — your dashboard and notes are unaffected.";
        setMessages((prev) =>
          prev.map((m) =>
            // Offer retry only on a genuinely empty turn (no tool ran). When a
            // tool ran, the work succeeded — no point retrying.
            m.id === placeholderId ? { ...m, text: fallback, canRetry: !hadTool } : m,
          ),
        );
        // A tool ran even though no prose came back — refresh memory views and
        // still attempt the auto-title so the thread doesn't stay "Untitled".
        if (toolMessages.length) {
          void invalidate("/api/memory/preferences");
          const tid = returnedThread ?? threadId;
          if (tid) void maybeAutoTitle(tid);
        }
      } else {
        // First turn pair just completed on a thread we haven't titled yet —
        // ask the server to auto-title it. Idempotent server-side; the ref
        // dedup is just to avoid the round trip on subsequent turns.
        const tid = returnedThread ?? threadId;
        if (tid) void maybeAutoTitle(tid);
      }
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === placeholderId
            ? {
                ...m,
                text: `Chat error: ${err instanceof Error ? err.message : "unknown"}. The dashboard still works; this just means AI hasn't been configured (or the demo turn cap was hit).`,
                canRetry: true,
              }
            : m,
        ),
      );
    } finally {
      setLoading(false);
    }
  };

  // `display` is the visible user bubble; `send` is what's actually sent to the
  // model. They differ only for the OCR handoff, where the raw transcription
  // rides along in `send` but stays out of the visible body. Default: identical.
  // `attached` carries any image attachments for this turn (shown as thumbnails
  // on the user bubble; forwarded to the vision model).
  const ask = (
    display: string,
    send: string = display,
    context?: EntryContext,
    attached: ChatImage[] = [],
  ) => {
    // Allow an image-only turn (empty text) when attachments are present.
    if ((!display.trim() && attached.length === 0) || loading) return;
    const newUserMsg: Message = {
      role: "user",
      text: display,
      ts: Date.now(),
      id: makeId(),
      images: attached.length ? attached : undefined,
    };
    const nextHistory = [...messages, newUserMsg];
    setMessages(nextHistory);
    setInput("");

    // Plan edits flow through propose_plan_edit, holding extraction through
    // propose_holding / propose_holdings_import: the model emits proposals in the
    // chat stream, which askLive picks up and renders as cards/tables. `context`,
    // when an Ask-Advisor button supplied it, rides along to the server (never
    // into the visible bubble).
    void askLive(send, messages, context, attached);
  };

  // The composer is an auto-growing textarea: reset to one line, then grow to fit
  // the content. CSS caps the height and adds a scrollbar past the cap, and the
  // composer is bottom-aligned so the send/attach buttons stay put as it grows.
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fitComposer = useCallback(() => {
    const el = composerRef.current;
    // A detached/hidden textarea measures scrollHeight as 0, which would lock the
    // height to 0px and clip the placeholder behind a scrollbar — skip until it
    // has layout (the ResizeObserver below re-fits once it does).
    if (!el || el.scrollHeight === 0) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `input` is the trigger — re-fit whenever the text changes (incl. programmatic clears on send / seed); fitComposer reads the value off the ref
  useEffect(() => {
    fitComposer();
  }, [input, fitComposer]);
  // The single ChatScreen is re-parented between the mobile screen and the desktop
  // dock (see App's chatHost note), so it can mount — and the effect above can run
  // — while detached, measuring a 0 height. And once mounted it spans both shells'
  // widths, so the same text wraps differently after a viewport swap. Re-fit when
  // the composer's WIDTH changes: that fires when it first gains layout (detached
  // → attached) and on every shell/panel resize. Guarding on width (not height,
  // which we set ourselves) avoids a feedback loop.
  useEffect(() => {
    const el = composerRef.current;
    const box = el?.parentElement;
    if (!box || typeof ResizeObserver === "undefined") return;
    let lastWidth = box.clientWidth;
    const ro = new ResizeObserver(() => {
      if (box.clientWidth === lastWidth) return;
      lastWidth = box.clientWidth;
      fitComposer();
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, [fitComposer]);

  // Send the composer's current text + staged attachments, then clear them.
  const sendComposer = () => {
    if (loading) return;
    const imgs = attachments;
    if (!input.trim() && imgs.length === 0) return;
    // After an Edit hand-off, the first reply carries the memory's content + body
    // (editContext) so the Advisor targets the right row; consume it once.
    ask(input, input, editContext ?? undefined, imgs);
    if (editContext) setEditContext(null);
    setAttachments([]);
    setAttachNotice(null);
  };

  // Re-send the user message that produced a failed/empty assistant turn.
  // Drops the failed placeholder, then replays the preceding user turn with
  // the same prior history (askLive re-appends the prompt itself).
  const retry = (failedId: string) => {
    if (loading) return;
    const withoutFailed = messages.filter((m) => m.id !== failedId);
    const last = withoutFailed[withoutFailed.length - 1];
    if (last?.role !== "user") return;
    setMessages(withoutFailed);
    void askLive(last.text, withoutFailed.slice(0, -1));
  };

  // Index of the most recent assistant turn — Regenerate is offered on it alone.
  const lastAiIndex = useMemo(() => {
    for (let k = messages.length - 1; k >= 0; k--) if (messages[k].role === "ai") return k;
    return -1;
  }, [messages]);

  // Regenerate the latest reply: drop the persisted reply server-side FIRST
  // (await, so the re-ask's fresh reply isn't the one we delete), then re-ask
  // the preceding user turn via the same path as retry. Reload-safe and linear.
  const regenerate = async (aiId: string) => {
    if (loading) return;
    const tid = threadIdRef.current;
    if (tid) {
      try {
        await fetch(`/api/chat/threads/${encodeURIComponent(tid)}/latest-reply`, {
          method: "DELETE",
        });
        void invalidate("/api/chat/threads");
      } catch {
        // Best-effort; the re-ask still proceeds (a stray old reply self-resolves
        // on the next regenerate or is harmless until then).
      }
    }
    retry(aiId);
  };

  // Save (or un-save) a reply's prose as a user Note in Journal → Notes. The
  // saved state is derived from the journal fetch (savedNoteIdByBody), so this
  // just toggles and lets the derived state self-correct on refetch.
  const saveNote = (body: string) => {
    void (async () => {
      try {
        const existingId = savedNoteIdByBody.get(body);
        if (existingId != null) {
          // Toggle off: a 404 (already deleted in Journal) is fine.
          const res = await fetch(`/api/journal/${existingId}`, { method: "DELETE" });
          if (res.ok || res.status === 404) void invalidate("/api/journal");
          return;
        }
        const res = await fetch("/api/journal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "note", body, source: "user_tool" }),
        });
        if (res.ok) void invalidate("/api/journal");
      } catch {
        // best-effort; the derived state self-corrects on refetch
      }
    })();
  };

  // Copy a finished reply's prose to the clipboard, with a brief confirmation.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTurn = (id: string, text: string) => {
    if (!navigator.clipboard) return;
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedId(id);
        window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
      })
      .catch(() => {
        // Clipboard denied (permissions / insecure context) — no-op.
      });
  };

  // Context the UI already has, fed to the thin suggestion layer. These are the
  // SAME fetchers + health computation the Plan panel already uses (AppPanels'
  // PlanPanel) — we're consuming existing context, not building a new data path.
  // The `aggregate` book + selected target model drive portfolio-specific chips;
  // `activeScreen` biases the screen-flavored ones. When a sibling effort lands a
  // formal Advisor context model, swap these inputs for it without touching copy.
  const { aggregate } = usePortfolioView();
  const { models } = useModelPortfoliosView();
  const selectedModelId = useSelectedModelId();
  const targetModel = useMemo(
    () => models?.find((m) => m.id === selectedModelId) ?? null,
    [models, selectedModelId],
  );
  const suggestions = useMemo(() => {
    const health =
      aggregate && aggregate.holdings.length > 0
        ? computeHealth(
            aggregate.holdings,
            aggregate.totalValue,
            targetModel?.mix ?? null,
            targetModel?.ter ?? null,
          )
        : null;
    return buildChatSuggestions({
      screen: activeScreen,
      health,
      targetName: targetModel?.name ?? null,
      hasHoldings: !!aggregate && aggregate.holdings.length > 0,
    });
  }, [aggregate, targetModel, activeScreen]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: fire once per seed — `ask`/`onPromptConsumed` are intentionally unmemoized and must not retrigger the effect
  useEffect(() => {
    if (!seedPrompt) return;
    if (typeof seedPrompt === "string") {
      ask(seedPrompt);
    } else if ("opener" in seedPrompt) {
      // Canned Advisor opener (Journal → Memory "Edit"): open a fresh thread,
      // then drop the opener in once newChat() has reset the history (deferred
      // effect below). No turn is sent — we wait for the user's first reply.
      newChat();
      setPendingEditOpener({ opener: seedPrompt.opener, context: seedPrompt.context });
    } else if (seedPrompt.newChat) {
      // Open a fresh thread first, then send once newChat() has reset the
      // history (see the deferred effect below) — so the seeded request doesn't
      // append to whatever conversation was open.
      newChat();
      setPendingNewChatSeed({
        display: seedPrompt.display,
        send: seedPrompt.send,
        context: seedPrompt.context,
      });
    } else {
      ask(seedPrompt.display, seedPrompt.send, seedPrompt.context);
    }
    onPromptConsumed?.();
  }, [seedPrompt]);

  // Fire a queued new-chat seed once newChat() has reset `messages` to the empty
  // thread (reference equality holds — newChat does setMessages(EMPTY_THREAD)).
  // Deferring to this render guarantees `ask` closes over the empty history, not
  // the old chat.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `ask` is unmemoized; fire only when the reset has landed
  useEffect(() => {
    if (pendingNewChatSeed && messages === EMPTY_THREAD) {
      ask(pendingNewChatSeed.display, pendingNewChatSeed.send, pendingNewChatSeed.context);
      setPendingNewChatSeed(null);
    }
  }, [pendingNewChatSeed, messages]);

  // Drop the canned Advisor opener in once newChat() has reset the history, and
  // stash its context for the user's first reply. Nothing is sent — the Advisor
  // asks, the user answers, and only that reply (carrying `editContext`) goes to
  // the server.
  useEffect(() => {
    if (pendingEditOpener && messages === EMPTY_THREAD) {
      setMessages([{ role: "ai", text: pendingEditOpener.opener, ts: Date.now(), id: makeId() }]);
      setEditContext(pendingEditOpener.context ?? null);
      setPendingEditOpener(null);
    }
  }, [pendingEditOpener, messages]);

  const applyProposal = async (idx: number, proposal: PlanProposal) => {
    // Optimistic: mark applied immediately, roll back on failure.
    setMessages((prev) => prev.map((x, i) => (i === idx ? { ...x, applied: true } : x)));
    try {
      // Single server round trip — the route reads the current plan, applies
      // the additive edit (applyPlanEdit), and upserts it, all per-user scoped.
      const res = await fetch("/api/plan/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: proposal.section,
          add: proposal.add,
          rm: proposal.rm,
        }),
      });
      if (!res.ok) throw new Error(`plan edit ${res.status}`);
      invalidate("/api/plan");
    } catch (err) {
      // Roll back the optimistic apply and surface the error inline.
      setMessages((prev) =>
        prev.map((x, i) =>
          i === idx
            ? {
                ...x,
                applied: undefined,
                text: `${x.text}\n\n(Couldn't save: ${err instanceof Error ? err.message : "unknown error"}. Try again?)`,
              }
            : x,
        ),
      );
    }
  };

  // Accept a single holding proposal: optimistically mark it applied, POST to
  // the per-user-scoped accept route, then invalidate the holdings SWR cache so
  // the portfolio refreshes. Rolls back on failure. `msgIdx` is the message in
  // the stream; `holdingIdx` is which card within that message's list.
  const applyHolding = async (msgIdx: number, holdingIdx: number, holding: HoldingProposal) => {
    setMessages((prev) =>
      prev.map((x, i) =>
        i === msgIdx ? { ...x, holdingStatus: { ...x.holdingStatus, [holdingIdx]: "applied" } } : x,
      ),
    );
    try {
      const res = await fetch("/api/holdings/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bucketId: holding.bucketId,
          ticker: holding.ticker,
          englishName: holding.englishName,
          thaiName: holding.thaiName,
          assetClass: holding.assetClass,
          region: holding.region,
          units: holding.units,
          avgCost: holding.avgCost,
          ter: holding.ter,
          quoteSource: holding.quoteSource,
          source: holding.source,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
          broker?: string;
        } | null;
        if (body?.error === "synced_duplicate") {
          throw new Error(
            `${holding.ticker} is already synced from ${body.broker ?? "a connected broker"} in this portfolio`,
          );
        }
        throw new Error(`holding save ${res.status}`);
      }
      invalidate(/^\/api\/holdings/);
    } catch (err) {
      // Roll back the optimistic apply and surface the error inline.
      setMessages((prev) =>
        prev.map((x, i) => {
          if (i !== msgIdx) return x;
          const next = { ...x.holdingStatus };
          delete next[holdingIdx];
          return {
            ...x,
            holdingStatus: next,
            text: `${x.text}\n\n(Couldn't save ${holding.ticker}: ${
              err instanceof Error ? err.message : "unknown error"
            }. Try again?)`,
          };
        }),
      );
    }
  };

  const rejectHolding = (msgIdx: number, holdingIdx: number) => {
    setMessages((prev) =>
      prev.map((x, i) =>
        i === msgIdx
          ? { ...x, holdingStatus: { ...x.holdingStatus, [holdingIdx]: "rejected" } }
          : x,
      ),
    );
  };

  return (
    <div
      // .chat-shell sets the screen's height as a CSS rule rather than inline
      // so the wide-screen panel override (.ra-chat-body .screen { height: 100% })
      // can win on specificity — inline `height` would block it.
      className="screen chat-shell"
    >
      <div className="topbar">
        <button
          type="button"
          className="icon-btn"
          onClick={() => setShowThreads(true)}
          disabled={loading}
          aria-label="Open chat list"
          title="All chats"
        >
          <Icon name="menu" size={15} />
        </button>
        <div className="brand" style={{ flex: 1 }}>
          <span>{AI_PERSONALITIES.advisor.label}</span>
        </div>
        <button
          type="button"
          className="chip-btn"
          onClick={newChat}
          disabled={loading}
          title="Start a new conversation"
        >
          <Icon name="sparkle" size={12} /> New chat
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={onOpenMenu}
          aria-label="More"
          title="More"
        >
          <Icon name="ellipsis-vertical" size={15} />
        </button>
      </div>

      <ChatThreadList
        open={showThreads}
        onClose={() => setShowThreads(false)}
        activeThreadId={threadId}
        onSelect={(id) => {
          if (id !== threadId) {
            void loadThread(id);
          }
        }}
        onNewChat={newChat}
      />

      <div
        className="chat-stream"
        ref={setStreamRef}
        // `min-height: 0` lets flex:1 shrink below content size so overflow-y
        // actually kicks in (otherwise long messages push the composer off-screen).
        style={{ flex: 1, paddingBottom: 8, minHeight: 0, overflowY: "auto" }}
        onDragOver={imageUploadEnabled ? (e) => e.preventDefault() : undefined}
        onDrop={
          imageUploadEnabled
            ? (e) => {
                const files = Array.from(e.dataTransfer.files).filter((f) =>
                  f.type.startsWith("image/"),
                );
                if (files.length > 0) {
                  e.preventDefault();
                  void addFiles(files);
                }
              }
            : undefined
        }
      >
        {/* Single stable child: OverlayScrollbars re-parents the host's children
            into a generated viewport, so React must reconcile the dynamic
            messages INSIDE this wrapper, not directly under the OS host (else
            `removeChild` throws). Carries the column+gap layout the OS host
            would otherwise strip. Mirrors `.ra-panel-body-content`. */}
        <div className="chat-stream-content">
          {isIntro && (
            <div className="chat-intro">
              <BrandMark size={32} className="chat-intro-mark" />
              <p className="chat-intro-text">{INTRO_GREETING}</p>
            </div>
          )}
          {messages.map((m, i) => {
            const proposal = m.proposal;
            const holdingsImport = m.holdingsImport;
            const transactionsImport = m.transactionsImport;
            // The actively-streaming assistant message is the last one while
            // loading — don't offer per-turn actions until it's finished writing.
            const isStreaming = loading && i === messages.length - 1;
            // Per-turn actions appear at the foot of a finished assistant reply.
            const showActions = m.role === "ai" && i > 0 && !!m.text && !isStreaming;
            // Save-to-Notes is meaningless on a card-bearing reply (the value is
            // in the card, not the prose), so gate it to plain text replies.
            const canSaveNote =
              showActions &&
              !m.proposal &&
              !m.holdings?.length &&
              !m.holdingsImport &&
              !m.transactionsImport;
            // Regenerate only the latest reply, and not mid-stream.
            const canRegenerate = showActions && i === lastAiIndex && !loading;
            // The Advisor turn's body as ordered parts (prose ↔ memory chips). Fall
            // back to a single text part for the live placeholder / any row that
            // predates parts but carries text.
            const renderParts: TurnPart[] | undefined =
              m.role === "ai"
                ? (m.parts ?? (m.text ? [{ type: "text", text: m.text }] : []))
                : undefined;
            // The AI bubble renders only when it has visible content; an empty
            // streaming placeholder shows nothing here — the single thinking
            // indicator at the bottom of the stream conveys "working", so a
            // memory chip or streamed text appears ABOVE it, never under empty dots.
            const aiHasContent =
              !!renderParts?.length ||
              !!proposal ||
              !!m.holdings?.length ||
              !!holdingsImport ||
              !!transactionsImport ||
              !!m.canRetry ||
              !!m.images?.length;
            return (
              <Fragment key={m.id}>
                {(m.role !== "ai" || aiHasContent) && (
                  <div className={`msg ${m.role}`}>
                    {m.role === "ai" && (
                      <div className="meta">
                        Advisor ·{" "}
                        {new Date(m.ts).toLocaleTimeString("en-US", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        {showModelBadge && m.model && <> · {prettyModel(m.model)}</>}
                      </div>
                    )}
                    {m.role === "ai"
                      ? // Walk the turn's ordered parts: prose runs (Markdown, styled)
                        // interleaved with memory-write indicators, in the order they
                        // happened, under the single meta header above.
                        renderParts?.map((part, pIdx) =>
                          part.type === "text" ? (
                            <MarkdownMessage
                              // biome-ignore lint/suspicious/noArrayIndexKey: parts are append-only within a turn
                              key={`${m.id}-part-${pIdx}`}
                              text={part.text}
                            />
                          ) : (
                            <MemoryEventLine
                              // biome-ignore lint/suspicious/noArrayIndexKey: parts are append-only within a turn
                              key={`${m.id}-part-${pIdx}`}
                              event={part.event}
                            />
                          ),
                        )
                      : // User bubbles stay plain text so nothing typed is reinterpreted as markup.
                        m.text && <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>}
                    {m.images && m.images.length > 0 && (
                      <div className="chat-attachments">
                        {m.images.map((img) => (
                          <button
                            type="button"
                            key={img.id}
                            className="thumb"
                            onClick={() => setLightbox(img.fullDataUrl ?? img.dataUrl)}
                            title={img.name}
                            aria-label={`View ${img.name}`}
                          >
                            {/* biome-ignore lint/performance/noImgElement: data-URL thumbnail, not a remote asset */}
                            <img src={img.dataUrl} alt={img.name} />
                          </button>
                        ))}
                      </div>
                    )}
                    {m.canRetry && (
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => retry(m.id)}
                        disabled={loading}
                        style={{ marginTop: 6 }}
                      >
                        Try again
                      </button>
                    )}
                    {proposal && (
                      <PlanProposalCard
                        proposal={proposal}
                        applied={m.applied}
                        onApply={() => applyProposal(i, proposal)}
                        onReject={() => {
                          setMessages((prev) =>
                            prev.map((x, idx) =>
                              idx === i ? { ...x, applied: false, rejected: true } : x,
                            ),
                          );
                        }}
                      />
                    )}
                    {m.holdings?.map((h, hIdx) => (
                      <HoldingProposalCard
                        // biome-ignore lint/suspicious/noArrayIndexKey: proposals are append-only within a message; hIdx also indexes holdingStatus
                        key={`${m.id}-holding-${hIdx}`}
                        holding={h}
                        status={m.holdingStatus?.[hIdx]}
                        onApply={() => applyHolding(i, hIdx, h)}
                        onReject={() => rejectHolding(i, hIdx)}
                      />
                    ))}
                    {holdingsImport && (
                      <HoldingsImportCard
                        data={holdingsImport}
                        onOpen={() => requestImportWithRows(holdingsImport.rows)}
                      />
                    )}
                    {transactionsImport && (
                      <TransactionsImportCard
                        data={transactionsImport}
                        onOpen={() => requestTxnImportWithRows(transactionsImport.rows)}
                      />
                    )}
                    {/* Per-turn actions, foot of the reply (Claude/ChatGPT style):
                        Copy · Save · Retry (latest only). Hover tooltips via title. */}
                    {showActions && (
                      <div className="msg-actions">
                        <button
                          type="button"
                          className="msg-action"
                          onClick={() => copyTurn(m.id, m.text)}
                          aria-label={copiedId === m.id ? "Copied" : "Copy"}
                          title={copiedId === m.id ? "Copied" : "Copy"}
                        >
                          <Icon name={copiedId === m.id ? "check" : "copy"} size={14} />
                        </button>
                        {canSaveNote && (
                          <SaveNoteButton
                            saved={savedNoteIdByBody.has(m.text)}
                            onSave={() => saveNote(m.text)}
                          />
                        )}
                        {canRegenerate && (
                          <button
                            type="button"
                            className="msg-action"
                            onClick={() => void regenerate(m.id)}
                            disabled={loading}
                            aria-label="Retry"
                            title="Retry"
                          >
                            <Icon name="rotate-cw" size={14} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </Fragment>
            );
          })}
          {/* One "thinking" indicator pinned at the bottom of the stream while
            the Advisor works (no bubble) — memory chips and streamed text appear
            ABOVE it. Hidden the moment the assistant message starts streaming text. */}
          {loading &&
            !(
              messages[messages.length - 1]?.role === "ai" && !!messages[messages.length - 1]?.text
            ) && (
              <div className="msg ai">
                <div className="typing">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            )}
        </div>
      </div>

      {contextNotice && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            margin: "0 8px 6px",
            padding: "8px 10px",
            fontSize: 12,
            lineHeight: 1.4,
            color: "var(--ink-soft)",
            background: "var(--card-soft)",
            border: "1px solid var(--line)",
            borderRadius: 8,
          }}
        >
          <Icon name="sparkle" size={12} />
          <span style={{ flex: 1 }}>
            This chat is getting long — earlier turns are summarized to keep replies fast. Start a
            new chat for a clean slate.
          </span>
          <button
            type="button"
            className="btn ghost sm"
            onClick={newChat}
            disabled={loading}
            style={{ flexShrink: 0 }}
          >
            New chat
          </button>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setContextNotice(false)}
            aria-label="Dismiss"
            style={{ flexShrink: 0, padding: "4px 8px" }}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      {limitNotice && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            margin: "0 8px 6px",
            padding: "8px 10px",
            fontSize: 12,
            lineHeight: 1.4,
            color: "var(--ink-soft)",
            background: "var(--card-soft)",
            border: "1px solid var(--line)",
            borderRadius: 8,
          }}
        >
          <Icon name="sparkle" size={12} />
          <span style={{ flex: 1 }}>
            You've reached today's chat usage limit. It resets at midnight UTC — your dashboard and
            saved notes are unaffected.
          </span>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setLimitNotice(false)}
            aria-label="Dismiss"
            style={{ flexShrink: 0, padding: "4px 8px" }}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      {attachments.length === 0 && (
        <div className="suggested-chips">
          {suggestions.map((s) => (
            <button key={s} className="chip" onClick={() => ask(s)} disabled={loading}>
              {s}
            </button>
          ))}
        </div>
      )}

      {imageUploadEnabled && attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((a, idx) => (
            <div className="thumb" key={a.id}>
              {/* biome-ignore lint/performance/noImgElement: data-URL preview, not a remote asset */}
              <img src={a.dataUrl} alt={a.name} />
              <button
                type="button"
                onClick={() => removeAttachment(idx)}
                aria-label={`Remove ${a.name}`}
                title="Remove"
              >
                <Icon name="close" size={11} />
              </button>
            </div>
          ))}
          <span className="note">
            Images stay in your browser and are sent to Advisor to answer — they are not stored on
            our servers.
          </span>
          {attachNotice && (
            <span className="note" style={{ color: "var(--amber)" }}>
              {attachNotice}
            </span>
          )}
        </div>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          sendComposer();
        }}
      >
        {imageUploadEnabled && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading || attachments.length >= MAX_ATTACHMENTS}
              aria-label="Attach image"
              title={
                attachments.length >= MAX_ATTACHMENTS
                  ? `Up to ${MAX_ATTACHMENTS} images`
                  : "Attach image"
              }
            >
              <Icon name="paperclip" size={16} />
            </button>
          </>
        )}
        <textarea
          ref={composerRef}
          rows={1}
          className={customScroll ? "composer-scroll" : undefined}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline. Skip while an IME is
            // composing (e.g. Thai input) so Enter commits the candidate instead.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              sendComposer();
            }
          }}
          onPaste={(e) => {
            if (!imageUploadEnabled) return;
            const files = Array.from(e.clipboardData.files).filter((f) =>
              f.type.startsWith("image/"),
            );
            if (files.length > 0) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          placeholder="Ask about your portfolio…"
          disabled={loading}
        />
        <button type="submit" disabled={(!input.trim() && attachments.length === 0) || loading}>
          <Icon name="send" size={14} />
        </button>
      </form>

      {/*
        Persistent AI disclaimer. Verbatim project-wide string — see
        AGENTS.md § Product copy & vocabulary. Plain muted text, not
        dismissible, not a banner.
      */}
      <div
        role="note"
        style={{
          textAlign: "center",
          fontSize: 11,
          color: "var(--muted)",
          padding: "6px 12px 8px",
          lineHeight: 1.4,
        }}
      >
        Advisor is AI and can make mistakes.
      </div>

      {lightbox && (
        <button
          type="button"
          className="chat-lightbox"
          onClick={() => setLightbox(null)}
          aria-label="Close image"
        >
          {/* biome-ignore lint/performance/noImgElement: data-URL preview, not a remote asset */}
          <img src={lightbox} alt="Attached" />
        </button>
      )}
    </div>
  );
}
