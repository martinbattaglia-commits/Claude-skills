"use client";

// Browser-only cache of the Advisor's in-chat import CARDS (the holdings /
// transactions review tables from propose_holdings_import /
// propose_transactions_import). Mirrors lib/stores/chat-images: the chat route
// persists only the assistant's TEXT, not tool output, so without this a card
// vanishes on reload. We keep its payload in localStorage keyed by
// `${threadId}:${seq}` — `seq` being the 0-based index of the user turn that
// produced it (computed identically on the send and reload paths) — so it
// re-attaches to that turn's reply. Bounded with oldest-first eviction.

import type { TurnPart } from "@/lib/advisor/turn-persist";
import type { ExtractedTxnRow } from "@/lib/portfolio/ocr";
import type { ImportSeedRow } from "@/lib/stores/import-seed";

export interface ChatCard {
  holdingsImport?: { rows: ImportSeedRow[]; source: string | null; note: string | null };
  transactionsImport?: { rows: ExtractedTxnRow[]; source: string | null; note: string | null };
  // The assistant turn's ordered body (prose + memory indicators) — a browser
  // fallback so the interleaved render survives a reload before / without the
  // server-persisted `cards.parts`. The durable record is server-side.
  parts?: TurnPart[];
  // Legacy: pre-parts caches held memory events unordered. Read on hydrate and
  // synthesized into parts when `parts` is absent; never written anymore.
  memoryEvents?: {
    kind: string;
    id: number;
    oldId?: number;
    category: string;
    status?: string;
    content?: string;
  }[];
}

const KEY = "macrotide_chat_cards_v1";
// Cards are small JSON (a few dozen rows of numbers/strings); a modest budget
// holds a long backlog well under the localStorage quota.
const BUDGET_BYTES = 1_500_000;

interface Entry {
  ts: number;
  card: ChatCard;
}
type Store = Record<string, Entry>;

function readStore(): Store {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  if (typeof window === "undefined") return;
  let serialized = JSON.stringify(store);
  if (serialized.length > BUDGET_BYTES) {
    const byAge = Object.entries(store).sort((a, b) => a[1].ts - b[1].ts);
    while (serialized.length > BUDGET_BYTES && byAge.length > 0) {
      const [oldestKey] = byAge.shift() as [string, Entry];
      delete store[oldestKey];
      serialized = JSON.stringify(store);
    }
  }
  try {
    window.localStorage.setItem(KEY, serialized);
  } catch {
    // Quota or privacy mode — drop silently; the card is a best-effort nicety.
  }
}

const composeKey = (threadId: string, seq: number) => `${threadId}:${seq}`;

/** Persist the card(s) produced by one user turn. No-op when empty. Merges with
 *  any existing entry so a turn can carry both an import table and memory events. */
export function saveChatCard(threadId: string, seq: number, card: ChatCard): void {
  if (
    !threadId ||
    (!card.holdingsImport &&
      !card.transactionsImport &&
      !card.parts?.length &&
      !card.memoryEvents?.length)
  ) {
    return;
  }
  const store = readStore();
  const key = composeKey(threadId, seq);
  store[key] = { ts: Date.now(), card: { ...store[key]?.card, ...card } };
  writeStore(store);
}

/**
 * Load every stored card for a thread, keyed by the user-turn `seq`. Used on
 * thread reload to re-attach the table to the right assistant reply.
 */
export function loadChatThreadCards(threadId: string): Map<number, ChatCard> {
  const out = new Map<number, ChatCard>();
  if (!threadId) return out;
  const store = readStore();
  const prefix = `${threadId}:`;
  for (const [key, entry] of Object.entries(store)) {
    if (!key.startsWith(prefix)) continue;
    const seq = Number(key.slice(prefix.length));
    if (Number.isInteger(seq)) out.set(seq, entry.card);
  }
  return out;
}
