"use client";

import "overlayscrollbars/overlayscrollbars.css";
import { useOverlayScrollbars } from "overlayscrollbars-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type AppId,
  ChatPanel,
  NotesPanel,
  PlanPanel,
  PortfoliosPanel,
} from "@/components/AppPanels";
import { CashNudgeCard } from "@/components/CashNudgeCard";
import { FundSelectScreen } from "@/components/FundSelect";
import { Icon } from "@/components/Icon";
import { type PortfolioFormValues, PortfolioSheet } from "@/components/PortfolioSheet";
import { RecordSheet } from "@/components/RecordSheet";
import { AccountScreen } from "@/components/screens/AccountScreen";
import { AdminScreen } from "@/components/screens/AdminScreen";
import { ChatScreen, type SeedPrompt } from "@/components/screens/ChatScreen";
import { ConnectBrokerScreen } from "@/components/screens/ConnectBrokerScreen";
import { HistoryScreen } from "@/components/screens/HistoryScreen";
import { JournalScreen, type JournalTab } from "@/components/screens/JournalScreen";
import { MarketsScreen } from "@/components/screens/MarketsScreen";
import { ModelPortfoliosScreen } from "@/components/screens/ModelPortfoliosScreen";
import { PortfolioScreen } from "@/components/screens/PortfolioScreen";
import { PortfoliosScreen } from "@/components/screens/PortfoliosScreen";
import { PositionScreen } from "@/components/screens/PositionScreen";
import { SettingsScreen, type Theme } from "@/components/screens/SettingsScreen";
import { clearDemoSession } from "@/lib/auth/clear-demo";
import { authClient } from "@/lib/auth/client";
import { usePortfolioView, useSelectedModelId } from "@/lib/fetchers/legacy";
import { usePlan } from "@/lib/fetchers/portfolio";
import { invalidate, useResource } from "@/lib/fetchers/swr";
import { clearBackLayers, pushBackLayer } from "@/lib/nav/back-stack";
import type { AdvisorScreenContext } from "@/lib/portfolio/chat-suggestions";
import type { ExtractedTxnRow } from "@/lib/portfolio/ocr";
import type { CashNudge } from "@/lib/portfolio/settlement-cash";
import { getScrollRoot, saveScreenScroll } from "@/lib/screenScroll";
import type { Portfolio } from "@/lib/static/types";
import { type ImportSeedRow, useImportSeed } from "@/lib/stores/import-seed";
import { setActiveId, usePortfolioUi } from "@/lib/stores/portfolio-ui";
import { syncThemeColor } from "@/lib/theme-color";
import { usePointer } from "@/lib/usePointer";
import { useScrollHide } from "@/lib/useScrollHide";
import { useViewport, type Viewport } from "@/lib/useViewport";

function portfolioToFormValues(p: Portfolio): PortfolioFormValues {
  return {
    id: p.id,
    name: p.name,
    icon: p.icon || "wallet",
    color: p.color || "var(--accent)",
    notes: p.notes || "",
  };
}

// Which entry the unified Add (RecordSheet) opens in: a holdings snapshot
// (Balance rows) or buy/sell activity. (Formerly from the retired AddToPortfolioSheet.)
type AddMode = "snapshot" | "activity";

type Screen =
  | "portfolio"
  | "portfolios"
  | "activity"
  | "position"
  | "markets"
  | "funds"
  | "chat"
  | "journal"
  | "models"
  | "settings"
  | "account"
  | "admin"
  | "connect";

// Map the app shell's `screen` onto the small vocabulary the Advisor suggestion
// layer understands, so dock chat chips reflect the screen behind them. Screens
// the suggestion layer has nothing tailored for (settings/account/admin) map to
// null — it falls back to portfolio + evergreen prompts. "funds" is the Explore
// catalog; "chat" maps to itself (mobile, where chat is the screen).
function toAdvisorScreen(screen: Screen): AdvisorScreenContext | null {
  switch (screen) {
    case "portfolio":
      return "portfolio";
    case "markets":
      return "markets";
    case "funds":
      return "explore";
    case "journal":
      return "journal";
    case "models":
      return "models";
    case "chat":
      return "chat";
    default:
      return null;
  }
}

// Screen ids stay stable ("funds"/"chat") — only the visible labels changed:
// Funds → Explore (it's the catalog discovery tool, not a holdings list),
// Chat → Advisor (it's the AI investment advisor, not a generic chat).
const MOBILE_NAV: { id: Screen; icon: string; label: string }[] = [
  { id: "portfolio", icon: "home", label: "Portfolio" },
  { id: "markets", icon: "pulse", label: "Markets" },
  { id: "funds", icon: "search", label: "Explore" },
  { id: "chat", icon: "chat", label: "Advisor" },
  { id: "journal", icon: "book", label: "Journal" },
];

// The bottom-tab roots: switching between them is lateral, not a drill-in, so a
// tab tap abandons any open drill-in rather than stacking onto Back history.
const ROOT_SCREENS = new Set<Screen>(["portfolio", "markets", "funds", "chat", "journal"]);

// The heavy root tabs are KEPT MOUNTED once visited (hidden, not unmounted) so all
// their state — filters, scroll, open sheets, sub-tabs — survives leaving and
// returning, like a browser tab. Chat is excluded: it already persists via its own
// re-parented host. Transient sub-screens (position, settings, …) still unmount.
const KEEPALIVE_ROOTS: Screen[] = ["portfolio", "markets", "funds", "journal"];

// Wide shell drops "chat" from the rail — chat lives in the right dock instead.
const WIDE_NAV: { id: Screen; icon: string; label: string }[] = [
  { id: "portfolio", icon: "home", label: "Portfolio" },
  { id: "markets", icon: "pulse", label: "Markets" },
  { id: "funds", icon: "search", label: "Explore" },
  { id: "journal", icon: "book", label: "Journal" },
];

const APPS_RAIL: { id: AppId; icon: string; label: string }[] = [
  { id: "chat", icon: "chat", label: "Advisor" },
  { id: "portfolios", icon: "chart", label: "Portfolios" },
  { id: "plan", icon: "insight", label: "Plan" },
  { id: "notes", icon: "book", label: "Notes" },
];

const THEME_STORAGE_KEY = "macrotide-theme";
const ACTIVE_APP_STORAGE_KEY = "macrotide-active-app";
const PANEL_WIDTH_STORAGE_KEY = "macrotide-panel-width";
const PANEL_MAX_STORAGE_KEY = "macrotide-panel-max";

// Resizable Advisor panel (issue #95). The panel is a grid column on desktop
// (widening it eats into main, so main keeps a floor) and a fixed overlay on
// tablet (no main to squeeze — it grows until its left edge meets the nav rail).
// The two modes treat the drag endpoint differently:
//   - Desktop: drag stops at a comfort cap; Maximize is a separate full takeover.
//   - Overlay: drag runs all the way to the nav rail, and that endpoint IS the
//     maximized state — drag-to-full and Maximize are one and the same.
const PANEL_MIN_WIDTH = 380; // matches the historical fixed width
const PANEL_MAX_WIDTH = 720; // desktop-only comfort cap (Maximize ignores it)
// Overlay drag-to-maximize snap zone, sized as a fraction of the available
// travel (max − min) rather than a fixed pixel: a fixed value snaps too eagerly
// where there's little room and feels absent where there's a lot. Floored so it
// stays a deliberate gesture on small tablets.
const PANEL_SNAP_FRAC = 0.15;
const PANEL_SNAP_MIN_PX = 40;
const MAIN_MIN_WIDTH = 440; // desktop main floor (also the CSS `minmax` bound)
const APPS_RAIL_WIDTH = 76; // right apps-icon rail on desktop
const TABLET_APPS_RAIL = 72; // right apps-icon rail on tablet (overlay anchor)
const LEFT_RAIL_WIDE = 180; // labeled left rail at ≥1200px
const LEFT_RAIL_NARROW = 88; // compact left rail at 1000–1199px and tablet

// How wide the panel may grow. On the tablet overlay that's the nav rail (no
// comfort cap — the rail IS the maximized endpoint). On desktop it's where main
// would hit its floor, capped by the comfort max so a wide monitor can't make
// the panel unwieldy (Maximize is the separate full takeover there).
function panelMaxWidth(innerWidth: number, viewport: Viewport): number {
  if (viewport === "tablet") {
    return Math.max(PANEL_MIN_WIDTH, innerWidth - TABLET_APPS_RAIL - LEFT_RAIL_NARROW);
  }
  const leftRail = innerWidth >= 1200 ? LEFT_RAIL_WIDE : LEFT_RAIL_NARROW;
  const structural = innerWidth - leftRail - APPS_RAIL_WIDTH - MAIN_MIN_WIDTH;
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, structural));
}

function clampPanelWidth(width: number, innerWidth: number, viewport: Viewport): number {
  return Math.round(
    Math.min(panelMaxWidth(innerWidth, viewport), Math.max(PANEL_MIN_WIDTH, width)),
  );
}

// Approximate the viewport from width alone (thresholds mirror useViewport) so
// the module-level read can clamp before the hook is available. The on-mount
// re-clamp effect corrects it against the live viewport anyway.
function widthToViewport(w: number): Viewport {
  if (w < 700) return "mobile";
  if (w < 1000) return "tablet";
  return "desktop";
}

// Mirrors readStoredActiveApp: a missing/garbage value falls back to the default.
function readStoredPanelWidth(): number {
  if (typeof window === "undefined") return PANEL_MIN_WIDTH;
  try {
    const stored = Number(window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY));
    if (Number.isFinite(stored) && stored > 0) {
      return clampPanelWidth(stored, window.innerWidth, widthToViewport(window.innerWidth));
    }
  } catch {}
  return PANEL_MIN_WIDTH;
}

const APP_IDS: AppId[] = ["chat", "portfolios", "plan", "notes"];

// Persisted dock state. We encode `null` (closed) as the literal string
// "null" so a closed panel is a remembered choice, not an absent key — that
// distinction is how we tell "user closed it" (restore closed) apart from
// "very first visit" (default-open chat on desktop).
function readStoredActiveApp(): AppId | null | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const stored = window.localStorage.getItem(ACTIVE_APP_STORAGE_KEY);
    if (stored === null) return undefined;
    if (stored === "null") return null;
    if (APP_IDS.includes(stored as AppId)) return stored as AppId;
  } catch {}
  return undefined;
}

export function App({ isDemo }: { isDemo: boolean }) {
  const viewport = useViewport();
  const isWide = viewport !== "mobile";
  const isDesktop = viewport === "desktop";
  // Custom scrollbars are gated by POINTER, not width: a mouse/trackpad (fine
  // pointer) gets the OverlayScrollbars overlay everywhere — including a narrow
  // desktop window in the mobile shell, where the native bar would show as a
  // chunky lane; a touch device (coarse pointer) keeps native scroll, whose OS
  // bar auto-hides and whose momentum/safe-area behavior must stay untouched.
  const customScroll = usePointer();
  useScrollHide();

  // OverlayScrollbars on the content column. Two targets, never coexisting (the
  // shells are mutually exclusive on `isWide`): the wide shell's
  // <main className="ra-main">, and the mobile shell's <div className="app-scroll">
  // (only rendered when `customScroll`). We init against the EXISTING element
  // (no wrapper DOM); OverlayScrollbars generates its own scroll viewport child,
  // replacing the native scrollbar with a thin overlay thumb that carves no
  // layout space, so the sticky tab bars stay flush. Each target gets its own
  // hook instance for an unambiguous getInstance()/destroy() on a pointer flip.
  const osOptions = {
    scrollbars: {
      // Mimic the prior macOS-overlay feel: invisible at rest, dim thumb that
      // appears on hover and while scrolling, fading out once the pointer
      // leaves the content column.
      autoHide: "leave",
      autoHideDelay: 600,
      theme: "os-theme-macrotide",
    },
  } as const;
  const raMainRef = useRef<HTMLElement | null>(null);
  const [initRaMainScrollbars, getRaMainScrollbars] = useOverlayScrollbars({
    defer: true,
    options: osOptions,
  });
  const appScrollRef = useRef<HTMLDivElement | null>(null);
  const [initAppScrollbars, getAppScrollbars] = useOverlayScrollbars({
    defer: true,
    options: osOptions,
  });
  useEffect(() => {
    if (isWide && customScroll && raMainRef.current) {
      initRaMainScrollbars(raMainRef.current);
    } else {
      // A pointer flip to native (or a swap to the mobile shell) needs an
      // explicit destroy — the hook only auto-cleans on unmount — so `.ra-main`
      // reverts to its CSS `overflow-y: auto` native scrolling.
      getRaMainScrollbars()?.destroy();
    }
  }, [isWide, customScroll, initRaMainScrollbars, getRaMainScrollbars]);
  useEffect(() => {
    if (!isWide && customScroll && appScrollRef.current) {
      initAppScrollbars(appScrollRef.current);
    } else {
      getAppScrollbars()?.destroy();
    }
  }, [isWide, customScroll, initAppScrollbars, getAppScrollbars]);

  // Rail identity. A signed-in owner shows their real name/email. With no
  // better-auth user we distinguish the two no-user modes: a real demo session
  // (isDemo) shows "Demo user"; AUTH_DISABLED single-owner shows "Macrotide".
  const accountUser = authClient.useSession().data?.user;
  // Owner gate for the Admin entry point. The /api/admin/status endpoint is the
  // single source of truth (mirrors the server-side OWNER_EMAIL check); the UI
  // only uses it to decide whether to SHOW the menu item — every admin action
  // is independently authorized server-side.
  const { data: adminStatus } = useResource<{ isOwner: boolean }>("/api/admin/status");
  const isOwner = adminStatus?.isOwner ?? false;
  const accountName = accountUser?.name?.trim() || (isDemo ? "Demo user" : "Macrotide");
  const accountInitials =
    accountName
      .split(/\s+/)
      .map((w) => w[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase() || "DU";

  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return "system";
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === "light" || stored === "dark" || stored === "system") return stored;
    } catch {}
    return "system";
  });
  const [screen, setScreen] = useState<Screen>("portfolio");
  // Always-current screen, read by navigate() in event handlers without making
  // effects re-subscribe.
  const screenRef = useRef(screen);
  screenRef.current = screen;
  // Single entry point for every screen change, kept in sync with browser
  // history so hardware/gesture Back behaves natively: bottom tabs are roots
  // (switching abandons any open drill-in), while a drill-in screen pushes one
  // history entry that Back pops to return to the screen it opened from.
  // Stable (reads the live screen via screenRef, not a captured value) so it can
  // sit in effect dep lists without re-subscribing every render.
  const navigate = useCallback((target: Screen) => {
    const from = screenRef.current;
    if (target === from) return;
    if (ROOT_SCREENS.has(target)) clearBackLayers();
    else pushBackLayer(() => setScreen(from));
    setScreen(target);
  }, []);
  // The on-screen Back affordances route through Back so a tapped back-arrow and
  // a hardware Back share one path and history depth stays aligned.
  const goBack = () => {
    if (typeof window !== "undefined") window.history.back();
  };
  // The broker-connect wizard is a drill-in; navigate() captures the screen it
  // was opened from so Back returns there.
  const openConnect = () => navigate("connect");
  const [pendingPrompt, setPendingPrompt] = useState<SeedPrompt | null>(null);
  // Deep-link target for the Journal screen's subtab (e.g. the chat memory
  // chip's "view in Memory" chevron). Cleared once JournalScreen applies it.
  const [journalTab, setJournalTab] = useState<JournalTab | null>(null);
  // One "Add to portfolio" sheet with a Holdings (snapshot) / Activity (ledger)
  // toggle — both write to the same ledger (ADR 0004). `addMode` picks the entry
  // form; the seeds carry rows handed in by the Advisor importer or the
  // scope-guard so the user needn't re-enter them.
  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<AddMode>("snapshot");
  // Which family the Add modal opens in (#149 split button): "investment" (default)
  // or "cash" (the "+ Add ▾ → Add cash" path).
  const [addEntryMode, setAddEntryMode] = useState<"investment" | "cash">("investment");
  // Rows the Advisor's in-chat holdings table hands to the importer (via the
  // import-seed store), copied into local state so the sheet keeps them after
  // the consumable store intent is cleared.
  const [importSeed, setImportSeed] = useState<ImportSeedRow[] | null>(null);
  // `txnSeed` carries rows handed off from the holdings importer's scope-guard
  // into the Add sheet's Activity mode. The all-activity ledger is now its own
  // screen (setScreen("activity")), not a modal.
  const [txnSeed, setTxnSeed] = useState<ExtractedTxnRow[] | null>(null);
  // Funded-from-cash nudges from the last save (#232) — dismissible cards on the
  // History screen the save lands on. Session-only; replaced by the next save.
  const [cashNudges, setCashNudges] = useState<{ bucketId: string; nudges: CashNudge[] } | null>(
    null,
  );
  // Ticker for the per-position drill-in screen (One Truth: a holding opens its
  // own record — summary above the history that produced it).
  const [positionTicker, setPositionTicker] = useState<string | null>(null);
  const {
    seedRows: seedRequest,
    openNonce: seedNonce,
    consumeImportSeed,
    txnRows: txnRequest,
    txnNonce,
    consumeTxnImportSeed,
  } = useImportSeed();
  const handledSeedNonce = useRef(0);
  useEffect(() => {
    if (seedNonce > 0 && seedNonce !== handledSeedNonce.current && seedRequest) {
      handledSeedNonce.current = seedNonce;
      setTxnSeed(null);
      setImportSeed(seedRequest);
      setAddMode("snapshot");
      setAddOpen(true);
      consumeImportSeed();
    }
  }, [seedNonce, seedRequest, consumeImportSeed]);
  // Parallel handoff for the Advisor's transaction-history import card: seed the
  // Add modal with trade rows (→ buy/sell/dividend), not Starting balances.
  const handledTxnNonce = useRef(0);
  useEffect(() => {
    if (txnNonce > 0 && txnNonce !== handledTxnNonce.current && txnRequest) {
      handledTxnNonce.current = txnNonce;
      setImportSeed(null);
      setTxnSeed(txnRequest);
      setAddMode("snapshot");
      setAddOpen(true);
      consumeTxnImportSeed();
    }
  }, [txnNonce, txnRequest, consumeTxnImportSeed]);
  const [, setSavedReading] = useState<unknown[]>([]);
  const planSelectedModelId = useSelectedModelId();
  const { data: plan } = usePlan();
  const [selectedModelOverride, setSelectedModelOverride] = useState<string | null>(null);
  const selectedModelId = selectedModelOverride ?? planSelectedModelId ?? "bogle3";
  // Which app panel is open on the right.
  // Default behavior depends on viewport (thresholds mirror useViewport):
  //   - Desktop (≥1000): chat opens by default — side-by-side fits.
  //   - Tablet (700–999):  closed by default — panel is an overlay.
  //   - Mobile (<700):     no panel rail at all; chat lives as its own screen.
  const [activeApp, setActiveApp] = useState<AppId | null>(() => {
    if (typeof window === "undefined") return "chat";
    // Restore the last persisted dock state on reload/rotate/resize. Only on a
    // user's very first visit (nothing stored) do we fall back to the
    // viewport default: desktop (≥1000) opens chat, narrower stays closed.
    const stored = readStoredActiveApp();
    if (stored !== undefined) return stored;
    return window.innerWidth >= 1000 ? "chat" : null;
  });
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);

  // Resizable Advisor panel (issue #95). `panelWidth` drives the desktop grid
  // column (via a `--ra-panel-width` CSS var on the shell); `panelMaxed` is the
  // Notion-style "expand to full" state that hides main and lets the panel span.
  // Both persist; the width is re-clamped on read and on viewport resize so a
  // value saved on a wide screen can't strand main on a narrower one.
  const [panelWidth, setPanelWidth] = useState<number>(readStoredPanelWidth);
  const [panelMaxed, setPanelMaxed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(PANEL_MAX_STORAGE_KEY) === "1";
    } catch {}
    return false;
  });

  // The mobile and wide shells are entirely different JSX/DOM trees. If we
  // rendered renderScreen() inside each shell's branch, crossing a viewport
  // breakpoint (e.g. phone rotate 390↔844 crossing 700) would unmount one
  // shell and mount the other, REMOUNTING the screen subtree and wiping all of
  // its transient state — open modals/sheets, search queries, active tab, etc.
  //
  // Fix: own a SINGLE persistent host <div> (created once, never unmounted) and
  // portal the single renderScreen() subtree into it. Each shell renders an
  // empty mount-point; a layout effect physically re-parents the persistent
  // host into whichever mount-point is live. Because the host DOM node and the
  // portal both keep a stable React-tree position across the shell swap, the
  // screen — and any modal it owns — is reconciled (state preserved), never
  // remounted. PortfolioSheet/RecordSheet (sharedModals) are lifted for
  // the same reason; this generalizes that protection to the whole screen.
  const screenHostRef = useRef<HTMLDivElement | null>(null);
  if (screenHostRef.current === null && typeof document !== "undefined") {
    screenHostRef.current = document.createElement("div");
    screenHostRef.current.className = "screen-host";
  }
  // The shell's mount-point; the persistent host is appended here. State (not a
  // ref) so the re-parent effect re-runs when the active shell swaps the slot.
  const [screenSlot, setScreenSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const host = screenHostRef.current;
    if (host && screenSlot && host.parentNode !== screenSlot) {
      screenSlot.appendChild(host);
    }
  }, [screenSlot]);

  // The Advisor chat is the same conversation in two shells: a full screen on
  // mobile (renderScreen) and the right dock on wide (ChatPanel). Rendering a
  // <ChatScreen> in each meant crossing the 700px breakpoint UNMOUNTED one and
  // MOUNTED the other, wiping the in-memory conversation (restore-on-mount only
  // reloaded persisted turns, and not reliably — a reload was needed). Fix (#225):
  // one persistent ChatScreen lives in a host <div> created once; whichever shell
  // shows chat renders an empty mount-point and a layout effect re-parents the
  // host into it. The host keeps its stable React-tree position (portaled from the
  // single return below), so the conversation is reconciled, never remounted —
  // exactly the screenHost pattern, applied to chat. When neither shell shows chat
  // the host is simply detached (the ChatScreen stays mounted, hidden), so the
  // conversation survives until chat is opened again.
  const chatHostRef = useRef<HTMLDivElement | null>(null);
  if (chatHostRef.current === null && typeof document !== "undefined") {
    chatHostRef.current = document.createElement("div");
    chatHostRef.current.className = "chat-host";
  }
  const [chatSlot, setChatSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const host = chatHostRef.current;
    if (host && chatSlot && host.parentNode !== chatSlot) {
      chatSlot.appendChild(host);
    }
  }, [chatSlot]);

  // PortfolioSheet lives at the App level so it survives the mobile↔wide
  // layout swap (which remounts everything below App). Without this lift,
  // an open edit dialog disappears the moment the viewport crosses 700px.
  const [portfolioSheet, setPortfolioSheet] = useState<
    { mode: "create" } | { mode: "edit"; portfolio: Portfolio } | null
  >(null);
  const { portfolios } = usePortfolioView();
  // Create/edit intents from PortfolioScreen + PortfoliosPanel flow through the
  // shared store. App owns the sheet so it survives the mobile↔wide swap.
  const { activeId, editTarget, newNonce, consumeEditTarget } = usePortfolioUi();

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    syncThemeColor(theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {}
    // In "system" mode the resolved status-bar color depends on the OS
    // preference, so re-sync when the OS flips while the app is open.
    if (theme !== "system" || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => syncThemeColor("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);
  useEffect(() => {
    document.documentElement.setAttribute("data-viewport", viewport);
  }, [viewport]);

  // Remember the dock state (open + which sub-panel, or closed) across reloads
  // and rotate/resize. `null` is persisted as "null" so a closed panel is a
  // remembered choice rather than an absent key. Mirrors the theme pattern.
  useEffect(() => {
    try {
      window.localStorage.setItem(ACTIVE_APP_STORAGE_KEY, activeApp ?? "null");
    } catch {}
  }, [activeApp]);

  // Persist the resizable-panel choices (issue #95), mirroring the dock pattern.
  useEffect(() => {
    try {
      window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(panelWidth));
    } catch {}
  }, [panelWidth]);
  useEffect(() => {
    try {
      window.localStorage.setItem(PANEL_MAX_STORAGE_KEY, panelMaxed ? "1" : "0");
    } catch {}
  }, [panelMaxed]);

  // Re-clamp the panel width when the viewport changes (resize/rotate). A width
  // saved on a wide window must shrink as the window narrows — on desktop so
  // main keeps its floor, on the tablet overlay so it can't overrun the nav rail.
  useEffect(() => {
    if (viewport === "mobile") return;
    const reclamp = () => setPanelWidth((w) => clampPanelWidth(w, window.innerWidth, viewport));
    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [viewport]);

  // The Chat and Portfolios screens are mobile-only — on wide they live in the
  // right dock, not as a full screen. If we resize mobile → wide while on one of
  // them, the screen would otherwise persist in `main` alongside its dock panel
  // (two of the same thing). Exit to the portfolio home (their parent tab). We
  // do NOT force the dock open — that would clobber a user who explicitly closed
  // it; the persisted `activeApp` already holds their choice.
  useEffect(() => {
    if (isWide && (screen === "chat" || screen === "portfolios")) {
      navigate("portfolio");
    }
  }, [isWide, screen, navigate]);

  // Screens are swapped in place inside one persistent scroll container, which
  // keeps its scrollTop across a swap. We turn that into per-screen scroll
  // memory: on entering a screen, restore where the user last left it (top for a
  // screen not yet visited this session — which is what stops Templates, opened
  // from Portfolio, inheriting the Portfolio offset). The map is in-memory, so a
  // full reload resets every screen to the top.
  const scrollMemory = useRef<Map<string, number>>(new Map());

  // Track the position LIVE rather than reading it once when a screen tears
  // down. A cleanup-time read is the original desktop bug: when the new (often
  // shorter) screen's content commits, the OverlayScrollbars viewport CLAMPS its
  // scrollTop before the cleanup could read it, so we saved a wrong/0 offset for
  // the screen being left and returning landed at the top. The capture-phase
  // scroll listener below writes the current screen's scrollTop into the map
  // continuously, BEFORE any swap — so the saved value is never the post-swap
  // clamped one. (Mobile scrolls the window, which isn't clamped this way, which
  // is why the old code happened to work there.) Mirrors useScrollHide's setup:
  // scroll events don't bubble, so we listen capture-phase on `document` to
  // catch both the window and the viewport; rAF-throttled to one read a frame.
  const currentScreenRef = useRef(screen);
  currentScreenRef.current = screen;
  useEffect(() => {
    let rafId = 0;
    const update = () => {
      rafId = 0;
      saveScreenScroll(scrollMemory.current, currentScreenRef.current);
    };
    const onScroll = () => {
      if (rafId !== 0) return;
      rafId = window.requestAnimationFrame(update);
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      if (rafId !== 0) window.cancelAnimationFrame(rafId);
      document.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, []);

  // On entering a screen, restore its remembered position. Layout effect so the
  // restore lands before paint — no flash of the scrolled position.
  //
  // A screen's content can settle its height a few frames AFTER it mounts —
  // returning to Portfolio, the value chart (recharts measures async) and the
  // holdings list grow over the next frames. A one-shot restore against that
  // momentarily-short page CLAMPS to the top. So we capture the target once and
  // re-apply it each frame until it STICKS (content tall enough to reach it) or a
  // budget elapses. Reading the target up front — not via the memory map — is
  // deliberate: the capture-phase scroll listener above would otherwise overwrite
  // the saved offset with the clamped value mid-catch-up.
  useLayoutEffect(() => {
    const target = scrollMemory.current.get(screen) ?? 0;
    const apply = (): boolean => {
      const root = getScrollRoot();
      if (!root) return true;
      root.set(target);
      return target === 0 || Math.abs(root.get() - target) < 1;
    };
    if (apply()) return; // already stuck (e.g. top, or content already tall)
    let rafId = 0;
    let frames = 0;
    const tick = () => {
      frames += 1;
      // ~30 frames (~0.5s) is ample for chart/list layout to settle; the cap stops
      // us from fighting the user if the saved offset is no longer reachable.
      if (apply() || frames >= 30) return;
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [screen]);

  // Portfolio sheet intents come from the shared store (PortfolioScreen and
  // PortfoliosPanel both request through it). Open the create sheet whenever the
  // "new" nonce bumps; the initial mount value (0) is ignored via the ref below.
  const lastNewNonce = useRef(newNonce);
  useEffect(() => {
    if (newNonce === lastNewNonce.current) return;
    lastNewNonce.current = newNonce;
    setPortfolioSheet({ mode: "create" });
  }, [newNonce]);

  // Open the edit sheet for a requested id, then consume the intent so it fires
  // once. Waits for `portfolios` to resolve before clearing.
  useEffect(() => {
    if (editTarget === null) return;
    const found = portfolios?.find((p) => p.id === editTarget);
    if (!found) return;
    setPortfolioSheet({ mode: "edit", portfolio: found });
    consumeEditTarget();
  }, [editTarget, portfolios, consumeEditTarget]);

  async function savePortfolio(values: PortfolioFormValues) {
    const isEdit = portfolioSheet?.mode === "edit";
    if (isEdit) {
      const res = await fetch(`/api/buckets/${encodeURIComponent(values.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: values.name,
          icon: values.icon,
          color: values.color,
          notes: values.notes,
        }),
      });
      if (!res.ok) throw new Error(`Update failed (${res.status})`);
    } else {
      const res = await fetch("/api/buckets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!res.ok) throw new Error(`Create failed (${res.status})`);
    }
    invalidate("/api/buckets");
  }

  async function deletePortfolio(id: string) {
    const res = await fetch(`/api/buckets/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`Delete failed (${res.status})`);
    invalidate("/api/buckets");
    invalidate(/^\/api\/holdings/);
    // Reset the active selection if it was viewing the deleted portfolio.
    setActiveId("all");
  }

  // Cross-screen events
  useEffect(() => {
    const navHandler = (e: Event) => {
      const target = (e as CustomEvent<Screen>).detail;
      if (isWide && target === "chat") setActiveApp("chat");
      else navigate(target);
    };
    const promptHandler = (e: Event) => {
      // detail is either a plain string (shown verbatim) or a { display, send }
      // split — the OCR handoff uses the latter to keep the raw transcription
      // out of the visible user bubble.
      setPendingPrompt((e as CustomEvent<SeedPrompt>).detail);
      if (isWide) setActiveApp("chat");
      else navigate("chat");
    };
    const saveReadingHandler = (e: Event) => {
      const article = (e as CustomEvent<unknown>).detail;
      setSavedReading((prev) => [...prev, article]);
    };
    // Open the Journal screen on a specific subtab (chat memory chip → Memory).
    const openJournalHandler = (e: Event) => {
      setJournalTab((e as CustomEvent<JournalTab>).detail);
      navigate("journal");
    };
    window.addEventListener("nav", navHandler);
    window.addEventListener("ai-prompt", promptHandler);
    window.addEventListener("save-reading", saveReadingHandler);
    window.addEventListener("open-journal", openJournalHandler);
    return () => {
      window.removeEventListener("nav", navHandler);
      window.removeEventListener("ai-prompt", promptHandler);
      window.removeEventListener("save-reading", saveReadingHandler);
      window.removeEventListener("open-journal", openJournalHandler);
    };
  }, [isWide, navigate]);

  // Helper: opening chat goes to dock on wide, screen on mobile.
  const openChat = () => {
    if (isWide) setActiveApp("chat");
    else navigate("chat");
  };

  // Mobile screens carry a top-right kebab that opens the account menu. The
  // wide shell hides it — the rail avatar holds the menu there.
  const openMobileMenu = () => setAccountMenuOpen(true);

  // Account menu contents, shared by the desktop rail dropdown and the mobile
  // sheet so the two stay in sync.
  const gotoScreen = (s: Screen) => {
    setAccountMenuOpen(false);
    navigate(s);
  };
  const signOut = async () => {
    setAccountMenuOpen(false);
    // Clear the demo cookie too: `authClient.signOut()` only revokes the
    // better-auth session, so a demo user signing out would otherwise land
    // on /login with `macrotide_demo` intact and slide right back in.
    await clearDemoSession();
    await authClient.signOut();
    window.location.href = "/";
  };
  const accountMenuItems = (
    <>
      <button onClick={() => gotoScreen("settings")}>
        <Icon name="settings" size={14} /> Settings
      </button>
      <button onClick={() => gotoScreen("models")}>
        <Icon name="insight" size={14} /> Templates
      </button>
      <button onClick={() => gotoScreen("account")}>
        <Icon name="user" size={14} /> Account
      </button>
      {isOwner && (
        <button onClick={() => gotoScreen("admin")}>
          <Icon name="shield" size={14} /> Admin
        </button>
      )}
      <hr />
      <button onClick={signOut}>
        <Icon name="refresh" size={14} /> Sign out
      </button>
    </>
  );

  // Each keep-alive root is added the first time it becomes active, so it mounts
  // while VISIBLE (charts measure correctly) and is hidden — never unmounted —
  // thereafter. Updated during render; `screen` changing is what re-renders.
  const visitedRoots = useRef<Set<Screen>>(new Set());
  if (KEEPALIVE_ROOTS.includes(screen)) visitedRoots.current.add(screen);

  // The keep-alive root tabs. Rendered for every visited root (active shown,
  // others hidden); see renderScreen.
  const renderRoot = (s: Screen) => {
    if (s === "portfolio") {
      return (
        <PortfolioScreen
          onOpenSettings={openMobileMenu}
          showMenu={!isWide}
          onOpenModels={() => navigate("models")}
          onOpenChat={openChat}
          onOpenImport={() => {
            setAddEntryMode("investment");
            setAddMode("snapshot");
            setAddOpen(true);
          }}
          onOpenCash={() => {
            setAddEntryMode("cash");
            setAddMode("snapshot");
            setAddOpen(true);
          }}
          onOpenActivity={() => navigate("activity")}
          onOpenPosition={(t) => {
            setPositionTicker(t);
            navigate("position");
          }}
          onOpenPortfolios={() => (isWide ? setActiveApp("portfolios") : navigate("portfolios"))}
        />
      );
    }
    if (s === "markets") {
      return <MarketsScreen onOpenSettings={openMobileMenu} showMenu={!isWide} />;
    }
    if (s === "funds") {
      return <FundSelectScreen onOpenSettings={openMobileMenu} showMenu={!isWide} />;
    }
    if (s === "journal") {
      return (
        <JournalScreen
          onOpenChat={openChat}
          onOpenModels={() => navigate("models")}
          onOpenSettings={openMobileMenu}
          showMenu={!isWide}
          initialTab={journalTab}
          onTabConsumed={() => setJournalTab(null)}
        />
      );
    }
    return null;
  };

  // Transient screens — sub-screens (and mobile chat) that render only while
  // active and unmount on leave.
  const renderTransient = () => {
    if (screen === "portfolios") {
      return <PortfoliosScreen onBack={goBack} />;
    }
    if (screen === "activity") {
      return (
        <HistoryScreen
          onBack={goBack}
          onAdd={() => {
            setAddMode("activity");
            setAddOpen(true);
          }}
          notice={
            cashNudges && cashNudges.nudges.length > 0 ? (
              <div
                style={{ display: "flex", flexDirection: "column", gap: 8, margin: "4px 0 12px" }}
              >
                {cashNudges.nudges.map((n) => (
                  <CashNudgeCard
                    key={`${n.buyTicker}-${n.tradeDate}-${n.shortfall}`}
                    bucketId={cashNudges.bucketId}
                    nudge={n}
                    onResolve={() =>
                      setCashNudges((prev) =>
                        prev ? { ...prev, nudges: prev.nudges.filter((x) => x !== n) } : prev,
                      )
                    }
                  />
                ))}
              </div>
            ) : null
          }
        />
      );
    }
    if (screen === "position" && positionTicker) {
      return (
        <PositionScreen
          ticker={positionTicker}
          onBack={goBack}
          onRecord={() => {
            setAddMode("activity");
            setAddOpen(true);
          }}
        />
      );
    }
    // Mobile full-screen chat: an empty mount-point for the persistent chat host
    // (see chatHost note); the single ChatScreen is portaled into it. Guarded to
    // mobile — on wide, `screen === "chat"` is transient (the effect at L509
    // redirects to portfolio) and chat lives in the dock, so we never mount a
    // second chat-slot in main alongside the panel's.
    if (screen === "chat" && !isWide) {
      return <div ref={setChatSlot} className="chat-mount" />;
    }
    if (screen === "models") {
      return (
        <ModelPortfoliosScreen
          selectedId={selectedModelId}
          onSelect={async (id) => {
            setSelectedModelOverride(id);
            try {
              await fetch("/api/plan", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  markdown: plan?.markdown ?? "",
                  selectedModelId: id,
                }),
              });
              invalidate("/api/plan");
            } catch (err) {
              console.error("Failed to persist selected model:", err);
            }
          }}
          onBack={goBack}
        />
      );
    }
    if (screen === "settings") {
      return (
        <SettingsScreen
          theme={theme}
          onThemeChange={(t) => setTheme(t)}
          onBack={goBack}
          onConnectBroker={openConnect}
        />
      );
    }
    if (screen === "account") {
      return <AccountScreen isDemo={isDemo} onBack={goBack} />;
    }
    if (screen === "admin") {
      // Defense in depth: even if a non-owner reaches this branch, the API
      // returns 403 and AdminScreen renders an access-denied message.
      return <AdminScreen onBack={goBack} />;
    }
    if (screen === "connect") {
      return <ConnectBrokerScreen onBack={goBack} onOrganize={() => navigate("settings")} />;
    }
    return null;
  };

  // Keep every visited root tab mounted; show the active one (boxless, so layout
  // is unchanged), hide the rest with display:none — which also removes them from
  // tab order and the accessibility tree. A transient sub-screen (or mobile chat)
  // renders on top only while it's the active screen.
  const renderScreen = () => (
    <>
      {[...visitedRoots.current].map((s) => (
        <div
          key={s}
          className="screen-keepalive"
          style={{ display: screen === s ? "contents" : "none" }}
        >
          {renderRoot(s)}
        </div>
      ))}
      {!KEEPALIVE_ROOTS.includes(screen) && renderTransient()}
    </>
  );

  // Modals rendered outside the layout swap so they survive mobile↔wide.
  const sharedModals = (
    <>
      <PortfolioSheet
        open={!!portfolioSheet}
        initial={
          portfolioSheet?.mode === "edit" ? portfolioToFormValues(portfolioSheet.portfolio) : null
        }
        onClose={() => setPortfolioSheet(null)}
        onSave={savePortfolio}
        onDelete={
          portfolioSheet?.mode === "edit"
            ? () => deletePortfolio(portfolioSheet.portfolio.id)
            : undefined
        }
      />
      <RecordSheet
        open={addOpen}
        defaultKind={addMode === "activity" ? "buy" : "opening"}
        defaultMode={addEntryMode}
        defaultBucketId={activeId === "all" ? undefined : activeId}
        holdingsSeed={importSeed}
        txnSeed={txnSeed}
        onClose={() => {
          setAddOpen(false);
          setImportSeed(null);
          setTxnSeed(null);
          setAddEntryMode("investment"); // next open defaults to Investment
        }}
        onConnectBroker={() => {
          setAddOpen(false);
          setImportSeed(null);
          setTxnSeed(null);
          openConnect();
        }}
        onSaved={() => navigate("activity")}
        onCashNudges={(bucketId, nudges) => setCashNudges({ bucketId, nudges })}
      />
    </>
  );

  // Both shells render an empty .screen-host slot; the persistent screen
  // subtree is portaled into whichever one is mounted (see screenHost note +
  // the single return below). The portal itself sits at a stable React-tree
  // position (the final return), so it is NOT remounted by the shell swap.
  // ===== MOBILE SHELL (unchanged behavior from original) =====
  const mobileShell = (() => {
    const hideNav =
      screen === "settings" || screen === "models" || screen === "account" || screen === "admin";
    return (
      <div className="app-root">
        <div className="app-frame" data-screen-label={screen}>
          {/* Mount-point: the persistent screen host (and the portaled
                renderScreen() inside it) is re-parented here — see screenHost
                note — so the screen survives the mobile↔wide remount.

                With a fine pointer we wrap it in a bounded .app-scroll container
                that OverlayScrollbars takes over (the fixed .bottom-nav stays a
                sibling OUTSIDE it, so it keeps positioning against the window).
                With a coarse pointer the slot is a direct child as before, so
                the native document-scroll path is byte-for-byte unchanged. */}
          {/* DISTINCT KEYS are load-bearing: both branches render a <div>, so
              without keys React REUSES the element when `customScroll` flips
              (e.g. DevTools device-mode toggling `pointer: coarse`). When the
              wrapper was the OverlayScrollbars-managed `.app-scroll`, OS has
              moved `.screen-slot` into its generated `os-viewport`, so React's
              attempt to removeChild the (now-relocated) inner node throws
              "removeChild: not a child". Different keys force a clean unmount of
              `.app-scroll` as a whole unit instead. */}
          {customScroll ? (
            <div key="app-scroll" className="app-scroll" ref={appScrollRef}>
              <div ref={setScreenSlot} className="screen-slot" />
            </div>
          ) : (
            <div key="native-scroll" ref={setScreenSlot} className="screen-slot" />
          )}
          {!hideNav && (
            <nav className="bottom-nav">
              {MOBILE_NAV.map((item) => (
                <button
                  key={item.id}
                  data-active={screen === item.id}
                  onClick={() => navigate(item.id)}
                >
                  <Icon name={item.icon} size={17} />
                  <span>{item.label}</span>
                </button>
              ))}
            </nav>
          )}
          {/* Account menu opens from each screen's top-right control (the
                settings gear, or the kebab on Chat) — see openMobileMenu. */}
          {accountMenuOpen && (
            <>
              <button
                type="button"
                className="mobile-menu-backdrop"
                aria-label="Close menu"
                onClick={() => setAccountMenuOpen(false)}
              />
              <div className="mobile-account-menu">{accountMenuItems}</div>
            </>
          )}
        </div>
      </div>
    );
  })();

  // ===== Resizable Advisor panel (issue #95) =====
  // The handle sits on the panel's LEFT edge, so the panel grows as the pointer
  // moves left: width = (window right edge − apps rail) − pointerX. The apps rail
  // is the panel's right anchor and differs by mode (desktop grid column 76px vs
  // tablet overlay `right: 72px`). Resizing works on both desktop and the tablet
  // overlay; only mobile (separate shell, no panel) opts out.
  const railOffset = viewport === "tablet" ? TABLET_APPS_RAIL : APPS_RAIL_WIDTH;
  // Shared by every panel head's Maximize/Restore toggle (issue #95).
  const toggleMax = () => setPanelMaxed((m) => !m);
  // Apply a freshly-computed width during a resize. On the tablet overlay the
  // nav rail is the maximized endpoint: once the drag gets within `snap` of it
  // the panel snaps the rest of the way and flips into the maximized state (a
  // little hysteresis below that releases it, so it doesn't flicker); dragging
  // back out un-maximizes. Keyboard passes snap=0 for exact, step-by-step
  // control. On desktop, drag and Maximize stay distinct — width only.
  // Returns the resulting maximized state. `snapFrac` sizes the snap-to-maximize
  // zone as a fraction of the overlay's travel (0 = exact, for keyboard).
  // `wasMaxed` lets a drag pass its own synchronously-tracked value (state
  // updates are async) so the hysteresis and the end-of-drag decision stay
  // consistent within one gesture.
  const applyResize = (next: number, snapFrac = 0, wasMaxed = panelMaxed): boolean => {
    if (viewport !== "tablet") {
      setPanelWidth(clampPanelWidth(next, window.innerWidth, viewport));
      return false;
    }
    const max = panelMaxWidth(window.innerWidth, "tablet");
    const snap = snapFrac > 0 ? Math.max(PANEL_SNAP_MIN_PX, (max - PANEL_MIN_WIDTH) * snapFrac) : 0;
    const enter = max - snap;
    const exit = snap > 0 ? enter - 24 : enter;
    const nowMaxed = next >= enter ? true : next < exit ? false : wasMaxed;
    setPanelMaxed(nowMaxed);
    if (next < enter) setPanelWidth(clampPanelWidth(next, window.innerWidth, viewport));
    return nowMaxed;
  };
  const onPanelResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (viewport === "mobile") return;
    e.preventDefault();
    // Snapshot the pre-drag width. A drag that ends maximized shouldn't leave
    // panelWidth at the snap edge it last tracked — restore should return to the
    // width the panel had before this gesture, like un-maximizing a window.
    const startWidth = panelWidth;
    let maxed = panelMaxed;
    const move = (ev: PointerEvent) => {
      maxed = applyResize(window.innerWidth - railOffset - ev.clientX, PANEL_SNAP_FRAC, maxed);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (maxed) setPanelWidth(startWidth);
    };
    // Attach the tracking listeners BEFORE pointer capture: capture can throw
    // for a non-primary/synthetic pointer, and we don't want that to strand the
    // drag. The window listeners keep the drag alive past the 8px bar on their
    // own; capture is just a nicety so the cursor stays consistent.
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
  };
  // Keyboard resize: arrows nudge, Home/End jump to the min/max. On the overlay,
  // End (or arrowing to the rail) maximizes and Home/ArrowRight un-maximizes;
  // when already maxed we measure from the max endpoint so the first nudge is
  // smooth rather than jumping from a stale pre-maximize width.
  const onPanelResizeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const max = panelMaxWidth(window.innerWidth, viewport);
    const step = e.shiftKey ? 48 : 16;
    const current = panelMaxed && viewport === "tablet" ? max : panelWidth;
    const targets: Record<string, number> = {
      ArrowLeft: current + step,
      ArrowRight: current - step,
      Home: PANEL_MIN_WIDTH,
      End: max,
    };
    const target = targets[e.key];
    if (target === undefined) return;
    e.preventDefault();
    applyResize(target);
  };

  // ===== WIDE SHELL (tablet + desktop) =====
  const wideShell = (
    <>
      <div
        className={`ra-shell ${viewport} ${activeApp ? "panel-open" : "panel-closed"}${
          panelMaxed && activeApp ? " panel-max" : ""
        }`}
        style={{ ["--ra-panel-width" as string]: `${panelWidth}px` }}
        data-screen-label={screen}
      >
        {/* ===== Left nav rail ===== */}
        <aside className="ra-rail">
          <nav className="ra-rail-nav">
            {WIDE_NAV.map((item) => (
              <button
                key={item.id}
                className="ra-rail-item"
                data-active={screen === item.id}
                onClick={() => navigate(item.id)}
                aria-label={item.label}
              >
                <Icon name={item.icon} size={18} />
                <span className="ra-rail-item-label">{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="ra-rail-foot">
            <button
              className="ra-rail-avatar-btn"
              onClick={() => setAccountMenuOpen((o) => !o)}
              aria-label="Account"
            >
              <span className="ra-rail-avatar">{accountInitials}</span>
              {isDesktop && (
                <div className="ra-rail-acct-text">
                  <div className="ra-rail-acct-name">{accountName}</div>
                </div>
              )}
            </button>
            {accountMenuOpen && (
              <div className="ra-account-menu" onMouseLeave={() => setAccountMenuOpen(false)}>
                {accountMenuItems}
              </div>
            )}
          </div>
        </aside>

        {/* ===== Main content ===== */}
        <main className="ra-main" ref={raMainRef}>
          {/* Mount-point: the persistent screen host (and the portaled
              renderScreen() inside it) is re-parented here — see screenHost
              note — so the screen survives the mobile↔wide remount. */}
          <div className="ra-main-inner" data-screen-label={screen} ref={setScreenSlot} />
        </main>

        {/* ===== Apps panel + backdrop =====
            Backdrop is only visible at tablet (CSS) where the panel becomes
            an overlay over main content. Clicking it dismisses the panel. */}
        {activeApp && (
          <>
            <button
              type="button"
              className="ra-panel-backdrop"
              onClick={() => setActiveApp(null)}
              aria-label="Close panel"
            />
            <section className="ra-panel">
              {/* Drag-to-resize handle on the panel's left edge. Kept visible on
                  the tablet overlay even when maximized so the user can drag back
                  out; on desktop it hides while maximized (Restore via the button,
                  drag unchanged). role="separator" + aria-value* = keyboard slider. */}
              {!(panelMaxed && isDesktop) && (
                // biome-ignore lint/a11y/useSemanticElements: a focusable resizer is the canonical separator pattern (W3C ARIA, radix/shadcn Resizable); an <hr> can't host the pointer-drag + keyboard-slider behavior.
                <div
                  className="ra-panel-resize"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize panel"
                  tabIndex={0}
                  aria-valuemin={PANEL_MIN_WIDTH}
                  aria-valuemax={
                    typeof window === "undefined"
                      ? PANEL_MIN_WIDTH
                      : panelMaxWidth(window.innerWidth, viewport)
                  }
                  aria-valuenow={
                    panelMaxed && typeof window !== "undefined"
                      ? panelMaxWidth(window.innerWidth, viewport)
                      : panelWidth
                  }
                  onPointerDown={onPanelResizePointerDown}
                  onKeyDown={onPanelResizeKeyDown}
                />
              )}
              {activeApp === "chat" && (
                <ChatPanel
                  chatSlotRef={setChatSlot}
                  onClose={() => setActiveApp(null)}
                  maxed={panelMaxed}
                  onToggleMax={toggleMax}
                />
              )}
              {activeApp === "portfolios" && (
                <PortfoliosPanel
                  onClose={() => setActiveApp(null)}
                  maxed={panelMaxed}
                  onToggleMax={toggleMax}
                />
              )}
              {activeApp === "plan" && (
                <PlanPanel
                  onClose={() => setActiveApp(null)}
                  maxed={panelMaxed}
                  onToggleMax={toggleMax}
                />
              )}
              {activeApp === "notes" && (
                <NotesPanel
                  onClose={() => setActiveApp(null)}
                  maxed={panelMaxed}
                  onToggleMax={toggleMax}
                />
              )}
            </section>
          </>
        )}

        {/* ===== Right apps icon rail ===== */}
        <aside className="ra-apps-rail">
          {APPS_RAIL.map((a) => (
            <button
              key={a.id}
              className="ra-apps-rail-btn"
              data-active={activeApp === a.id}
              onClick={() => setActiveApp(activeApp === a.id ? null : a.id)}
              aria-label={a.label}
            >
              <Icon name={a.icon} size={18} />
              <span className="ra-apps-rail-label">{a.label}</span>
            </button>
          ))}
        </aside>
      </div>
    </>
  );

  // Single return so the persistent screen portal and sharedModals sit at a
  // STABLE React-tree position. Swapping `mobileShell`/`wideShell` re-renders
  // the chrome, but the portal element keeps its slot, so renderScreen() and
  // any modal it owns are reconciled (state preserved), not remounted. The
  // screen subtree is rendered once here and createPortal targets the single
  // persistent host node, which the layout effect re-parents into the active
  // shell's mount-point as the shells swap.
  return (
    <>
      {screenHostRef.current && createPortal(renderScreen(), screenHostRef.current)}
      {/* The single persistent Advisor chat (see chatHost note). Portaled into the
          stable host node, which the layout effect re-parents into the active
          shell's chat mount-point — so the conversation survives the shell swap.
          `activeScreen` is the screen behind the dock on wide; on mobile chat is
          the screen, so there's nothing behind it. */}
      {chatHostRef.current &&
        createPortal(
          <ChatScreen
            persona="advisor"
            seedPrompt={pendingPrompt}
            onPromptConsumed={() => setPendingPrompt(null)}
            onOpenMenu={() => setAccountMenuOpen(true)}
            activeScreen={isWide ? toAdvisorScreen(screen) : "chat"}
          />,
          chatHostRef.current,
        )}
      {isWide ? wideShell : mobileShell}
      {sharedModals}
    </>
  );
}
