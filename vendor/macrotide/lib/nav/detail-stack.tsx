"use client";

// A single navigation stack for detail overlays — the "modal as page" model.
// Tapping a fund/stock/ETF INSIDE a detail sheet pushes a new entry onto ONE
// stack rendered by <DetailSheetHost> in a single Modal, instead of stacking a
// modal on a modal (an antipattern per Apple HIG / NN/G / Material). A Back
// chevron pops one level; Close (✕) clears the whole stack.
//
// Browser/hardware Back is wired per level: each push registers one back-stack
// layer (lib/nav/back-stack), so Back pops exactly one detail — matching native
// push/pop — rather than dismissing everything at once.

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { Holding } from "@/lib/static/types";
import { pushBackLayer, releaseTopLayers } from "./back-stack";

/**
 * One level in the stack: a US stock/ETF (by symbol), a Thai fund (projId or class
 * ticker), or a portfolio holding (the Portfolio/Position "holding detail" view,
 * which carries edit/position actions).
 */
export type DetailEntry =
  | { kind: "us"; symbol: string }
  | { kind: "fund"; id: string }
  | { kind: "holding"; holding: Holding };

export interface DetailStackApi {
  stack: DetailEntry[];
  top: DetailEntry | null;
  depth: number;
  /** Push a new detail level (a cross-link tap inside a sheet). */
  push: (entry: DetailEntry) => void;
  /** Pop one level (the Back chevron). */
  pop: () => void;
  /** Close every level (the ✕ / overlay / Escape). */
  clear: () => void;
}

const Ctx = createContext<DetailStackApi | null>(null);

export function DetailStackProvider({ children }: { children: React.ReactNode }) {
  const [stack, setStack] = useState<DetailEntry[]>([]);
  // A release() per open level, parallel to `stack`, to reclaim history entries.
  const releases = useRef<Array<() => void>>([]);

  const push = useCallback((entry: DetailEntry) => {
    const release = pushBackLayer(() => {
      // Back-driven: the layer is already off the global stack — just drop the
      // matching release + shrink the UI stack by one.
      releases.current.pop();
      setStack((s) => s.slice(0, -1));
    });
    releases.current.push(release);
    setStack((s) => [...s, entry]);
  }, []);

  const pop = useCallback(() => {
    releases.current.pop()?.(); // programmatic: reclaim this level's history entry
    setStack((s) => s.slice(0, -1));
  }, []);

  const clear = useCallback(() => {
    // Reclaim all of this stack's history entries in ONE batched go(-n), rather
    // than n async history.back() calls that could interleave with a pushState from
    // a modal opened immediately after (e.g. the holding-detail edit/history flow).
    releaseTopLayers(releases.current.length);
    releases.current = [];
    setStack([]);
  }, []);

  // Dev-only invariant: the release() ref and the UI stack are mutated in lockstep,
  // and a Back-driven close() pops `releases` blind — so they must stay equal length.
  // A desync (a level pushed outside push(), or nested providers) would silently
  // corrupt Back; surface it in dev instead.
  if (process.env.NODE_ENV !== "production" && releases.current.length !== stack.length) {
    console.warn(
      `[detail-stack] release/stack desync: ${releases.current.length} releases vs ${stack.length} levels`,
    );
  }

  const value = useMemo<DetailStackApi>(
    () => ({ stack, top: stack[stack.length - 1] ?? null, depth: stack.length, push, pop, clear }),
    [stack, push, pop, clear],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The detail stack. Throws outside a provider (a programming error). */
export function useDetailStack(): DetailStackApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDetailStack must be used within <DetailStackProvider>");
  return ctx;
}

/** The detail stack, or null when no provider is mounted (safe in isolated trees). */
export function useOptionalDetailStack(): DetailStackApi | null {
  return useContext(Ctx);
}
