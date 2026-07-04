"use client";

// Modal — the app's standard dialog primitive. A compound component
// (Modal / Modal.Header / Modal.Body / Modal.Footer) that owns the overlay,
// focus management, scroll-lock, background `inert`, and the sticky-footer
// scroll cue so individual dialogs only describe their content.
//
// Three variants:
//   • confirm — 400px, centered (desktop + mobile), no ✕, stacks above sheets
//     (z 200) so it can be invoked from inside an open form modal.
//   • form    — 560px desktop / full-bleed bottom-sheet on mobile.
//   • detail  — 640px desktop / full-bleed mobile, ✕ on, no footer.
//
// The body is the ONLY scroll region: a flex column pins the header on top and
// the footer at the bottom while the body scrolls between them. On the wide /
// pointer shell the body uses OverlayScrollbars (shared `os-theme-macrotide`);
// mobile bottom-sheet bodies use native touch scroll. An invisible 1px sentinel
// at the bottom of the body, watched by an IntersectionObserver, toggles a soft
// upward shadow on the footer once content scrolls beneath it.

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "overlayscrollbars/overlayscrollbars.css";
import { useOverlayScrollbars } from "overlayscrollbars-react";
import { Icon } from "@/components/Icon";
import { useBackDismiss } from "@/lib/nav/back-stack";
import { useViewport } from "@/lib/useViewport";

export type ModalVariant = "confirm" | "form" | "detail";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

// ─── shared context ───────────────────────────────────────────────────────────

interface ModalContextValue {
  variant: ModalVariant;
  onClose: () => void;
  isWide: boolean;
  /** Set by Body's IntersectionObserver; read by Footer for the scroll shadow. */
  footerShadow: boolean;
  setFooterShadow: (v: boolean) => void;
}

const ModalContext = createContext<ModalContextValue | null>(null);

function useModalContext(): ModalContextValue {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error("Modal.Header/Body/Footer must be used inside <Modal>");
  return ctx;
}

// ─── scroll-lock (ref-counted so stacked modals don't fight) ──────────────────

let scrollLockCount = 0;
let savedBodyOverflow = "";

function lockBodyScroll() {
  if (scrollLockCount === 0) {
    savedBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLockCount += 1;
}

function unlockBodyScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) {
    document.body.style.overflow = savedBodyOverflow;
  }
}

// ─── root ─────────────────────────────────────────────────────────────────────

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  variant?: ModalVariant;
  /** id of the element labelling the dialog (typically Modal.Header's title id). */
  labelledBy?: string;
  /** Override the inferred role (`dialog`, or `alertdialog` for confirm). */
  role?: "dialog" | "alertdialog";
  /** Extra class on the panel (e.g. a width modifier like `modal--txnwide`). */
  className?: string;
  /**
   * Whether this Modal registers its own browser-Back layer (default true). Set
   * false when a host owns a multi-level back stack itself (DetailSheetHost) and
   * needs Back to pop one level at a time rather than close the whole modal.
   */
  manageBack?: boolean;
  children: React.ReactNode;
}

export function Modal({
  open,
  onClose,
  variant = "form",
  labelledBy,
  role,
  className,
  manageBack = true,
  children,
}: ModalProps) {
  const viewport = useViewport();
  const isWide = viewport !== "mobile";
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [footerShadow, setFooterShadow] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Hardware/gesture Back (and the desktop Back button) closes the dialog before
  // it pops the screen beneath — the native-app expectation. Stacked dialogs
  // (a confirm over a form) unwind one Back at a time, LIFO. A host that manages
  // its own multi-level stack opts out (manageBack=false) and owns the layers.
  useBackDismiss(manageBack && open, onClose);

  // Portals need a DOM target; defer until mounted on the client.
  useEffect(() => setMounted(true), []);

  // Focus management, scroll-lock, background inert, Escape/Tab trap.
  // Runs once per open cycle (keyed on `open`).
  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const overlay = overlayRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    lockBodyScroll();

    // Mark every other top-level node inert so focus + AT are trapped inside the
    // dialog. Excludes only THIS overlay — sibling modal overlays get inerted
    // too, which is exactly right when a confirm opens over a form modal.
    const inerted: HTMLElement[] = [];
    for (const child of Array.from(document.body.children)) {
      if (child === overlay) continue;
      const el = child as HTMLElement;
      if (el.inert) continue; // already inert (e.g. by a lower modal) — leave it
      el.inert = true;
      inerted.push(el);
    }

    // Move focus inside: an explicit [data-autofocus] target, else the panel.
    const autoTarget = panel?.querySelector<HTMLElement>("[data-autofocus]");
    (autoTarget ?? panel)?.focus();

    return () => {
      for (const el of inerted) el.inert = false;
      unlockBodyScroll();
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open || !mounted) return null;

  const resolvedRole = role ?? (variant === "confirm" ? "alertdialog" : "dialog");

  const onOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "Tab") {
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusables.length === 0) {
        // Nothing focusable — keep focus on the panel.
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return createPortal(
    <div
      ref={overlayRef}
      className={`modal-overlay modal-overlay--${variant}`}
      onClick={onOverlayClick}
    >
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is dialog|alertdialog (dynamic), both support aria-modal */}
      <div
        ref={panelRef}
        className={`modal modal--${variant}${className ? ` ${className}` : ""}`}
        role={resolvedRole}
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <ModalContext.Provider value={{ variant, onClose, isWide, footerShadow, setFooterShadow }}>
          {children}
        </ModalContext.Provider>
      </div>
    </div>,
    document.body,
  );
}

// ─── header ─────────────────────────────────────────────────────────────────

export interface ModalHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** id wired to the root's `labelledBy` so the title labels the dialog. */
  id?: string;
  /** Show the top-right ✕. Defaults ON for `detail`, off otherwise. */
  showClose?: boolean;
  /** Optional right-side action (e.g. an Edit button) rendered left of the ✕. */
  action?: React.ReactNode;
  /** When set, a leading Back chevron pops one navigation level (modal-as-page). */
  back?: () => void;
  children?: React.ReactNode;
}

function ModalHeader({ title, subtitle, id, showClose, action, back, children }: ModalHeaderProps) {
  const { variant, onClose } = useModalContext();
  const close = showClose ?? variant === "detail";

  return (
    <div className="modal-header">
      {back && (
        <button type="button" className="icon-btn modal-back" onClick={back} aria-label="Back">
          <Icon name="arrow-left" size={16} />
        </button>
      )}
      <div className="modal-header-text">
        <div className="modal-title" id={id}>
          {title}
        </div>
        {subtitle && <div className="modal-subtitle">{subtitle}</div>}
        {children}
      </div>
      {(action || close) && (
        <div className="modal-header-actions">
          {action}
          {close && (
            <button
              type="button"
              className="icon-btn modal-close"
              onClick={onClose}
              aria-label="Close"
            >
              <Icon name="close" size={16} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── body (the scroll region + footer-shadow sentinel) ────────────────────────

export interface ModalBodyProps {
  /** Vertical gap between direct children (px). */
  gap?: number;
  /**
   * Scroll the body back to the top whenever this value changes — for a host that
   * swaps the body content in place (modal-as-page navigation) without remounting,
   * so a deep-scrolled page doesn't carry its scroll into the next one.
   */
  scrollResetKey?: string | number | null;
  children: React.ReactNode;
}

function ModalBody({ gap, scrollResetKey, children }: ModalBodyProps) {
  const { isWide, setFooterShadow } = useModalContext();
  const bodyRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const [initOverlayScrollbars, getInstance] = useOverlayScrollbars({
    defer: true,
    options: {
      scrollbars: {
        autoHide: "leave",
        autoHideDelay: 600,
        theme: "os-theme-macrotide",
      },
    },
  });

  // OverlayScrollbars lifecycle. Desktop/tablet (`isWide`) gets OS-managed
  // scroll; mobile uses native touch scroll on the body. We init OS only while
  // wide and tear it down only when LEAVING wide — so a modal that's open while
  // the viewport crosses a breakpoint keeps a live, in-place scroller instead
  // of being destroyed+recreated (which lost scroll position / glitched). The
  // wide↔wide case (tablet↔desktop) never re-runs this — `isWide` is unchanged.
  useEffect(() => {
    const bodyEl = bodyRef.current;
    if (!bodyEl || !isWide) return;
    initOverlayScrollbars(bodyEl);
    return () => {
      getInstance()?.destroy();
    };
  }, [isWide, initOverlayScrollbars, getInstance]);

  // Reset scroll to the top when the content identity changes (a navigation
  // within one mounted body — modal-as-page). A remount already starts at top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: isWide/getInstance only pick the scroll element; the reset is keyed on scrollResetKey.
  useEffect(() => {
    if (scrollResetKey == null) return;
    const viewport = isWide
      ? (getInstance()?.elements().viewport ?? bodyRef.current)
      : bodyRef.current;
    viewport?.scrollTo({ top: 0 });
  }, [scrollResetKey]);

  // Footer-shadow IntersectionObserver. Re-binds when `isWide` flips because the
  // scroll root changes: the OS-generated viewport (wide) vs the body element
  // (mobile native scroll). Kept separate from the OS lifecycle so toggling the
  // shadow observer never tears down the scroller itself.
  useEffect(() => {
    const bodyEl = bodyRef.current;
    const sentinel = sentinelRef.current;
    if (!bodyEl || !sentinel) return;

    const viewportEl: HTMLElement = isWide
      ? (getInstance()?.elements().viewport ?? bodyEl)
      : bodyEl;

    const io = new IntersectionObserver(
      (entries) => {
        // Sentinel hidden ⇒ content extends below the fold ⇒ show footer shadow.
        setFooterShadow(!entries[0]?.isIntersecting);
      },
      { root: viewportEl, threshold: 0 },
    );
    io.observe(sentinel);

    return () => {
      io.disconnect();
    };
  }, [isWide, setFooterShadow, getInstance]);

  return (
    <div ref={bodyRef} className="modal-body">
      {/* Inner wrapper carries the flex/gap. OverlayScrollbars re-parents the
          scroller host's (.modal-body) children into a generated viewport, which
          would strip a flex-gap set on the host — so the gap lives here, where it
          survives the restructure (and matches mobile, where there's no OS). */}
      <div
        className="modal-body-content"
        style={gap !== undefined ? { display: "flex", flexDirection: "column", gap } : undefined}
      >
        {children}
        {/* Invisible scroll sentinel — see footer-shadow note above. */}
        <div ref={sentinelRef} className="modal-body-sentinel" aria-hidden />
      </div>
    </div>
  );
}

// ─── footer (auto right-aligned, optional left `start` slot) ──────────────────

export interface ModalFooterProps {
  /** Left-aligned slot for a destructive / tertiary action. */
  start?: React.ReactNode;
  children: React.ReactNode;
  /** Extra class on the footer (e.g. `modal-footer--stack` to stack on mobile). */
  className?: string;
}

function ModalFooter({ start, children, className }: ModalFooterProps) {
  const { footerShadow } = useModalContext();
  return (
    <div
      className={`modal-footer${footerShadow ? " modal-footer--scrolled" : ""}${className ? ` ${className}` : ""}`}
    >
      {start && <div className="modal-footer-start">{start}</div>}
      <div className="modal-footer-end">{children}</div>
    </div>
  );
}

Modal.Header = ModalHeader;
Modal.Body = ModalBody;
Modal.Footer = ModalFooter;
