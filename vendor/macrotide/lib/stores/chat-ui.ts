"use client";

// Typed external store coordinating the Chat UI across two trees that aren't in
// a common provider subtree: the right-rail ChatPanel's in-panel thread list and
// the ChatScreen that owns threadId / loadThread / newChat. It replaces four
// untyped window CustomEvents (`chat-active-changed`, `chat-active-request`,
// `chat-load-thread`, `chat-new`) and their race-prone mount handshake with one
// module singleton read via React's built-in `useSyncExternalStore` — no
// context, no new dependency. (Mirrors lib/stores/portfolio-ui.ts.)
//
// State model:
//   - `activeThreadId`: the thread ChatScreen currently shows (null = a fresh,
//     unsaved chat). ChatScreen publishes it; the panel list reads it to
//     highlight the active row.
//   - load/new are CONSUMABLE intents from the panel, not durable state:
//       · `loadTarget`: thread id ChatScreen should load, cleared once handled.
//       · `newNonce`:   bumped per "new chat" request; ChatScreen reacts to the
//                       change and records the value it has handled.

import { useSyncExternalStore } from "react";

export interface ChatUiState {
  /** Thread ChatScreen currently shows; null is a fresh unsaved chat. */
  activeThreadId: string | null;
  /** Pending "load this thread" intent from the panel, or null when consumed. */
  loadTarget: string | null;
  /** Incrementing counter; a change signals a pending "start new chat" intent. */
  newNonce: number;
}

let state: ChatUiState = { activeThreadId: null, loadTarget: null, newNonce: 0 };

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function setState(patch: Partial<ChatUiState>) {
  state = { ...state, ...patch };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ChatUiState {
  return state;
}

// ── Actions (callable from anywhere, not just inside React) ──────────────────

/** ChatScreen publishes its current thread so the panel list highlights it. */
export function setActiveThreadId(id: string | null) {
  if (state.activeThreadId === id) return;
  setState({ activeThreadId: id });
}

/** Panel asks ChatScreen to load a thread. ChatScreen consumes + clears it once. */
export function requestLoadThread(id: string) {
  setState({ loadTarget: id });
}

/** ChatScreen calls this after handling a load so the intent fires exactly once. */
export function consumeLoadTarget() {
  if (state.loadTarget !== null) setState({ loadTarget: null });
}

/** Panel asks ChatScreen to start a new chat. */
export function requestNewChat() {
  setState({ newNonce: state.newNonce + 1 });
}

// ── React binding ────────────────────────────────────────────────────────────

/**
 * Subscribe to the chat UI store. Returns the current snapshot plus the action
 * functions. The snapshot is referentially stable between changes, so components
 * only re-render when state they read actually changes.
 */
export function useChatUi() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    ...snapshot,
    setActiveThreadId,
    requestLoadThread,
    consumeLoadTarget,
    requestNewChat,
  };
}
