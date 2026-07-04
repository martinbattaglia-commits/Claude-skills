// Icons resolve in three tiers:
//   1. CUSTOM_PATHS  — app-specific single-path SVGs (stroke 1.5, lucide-feel).
//   2. STATIC_LUCIDE — a few always-visible chrome icons imported eagerly so
//      they bundle into the main chunk and never lazy-load late.
//   3. DynamicIcon   — everything else from lucide (1700+), lazy-loaded per
//      glyph on demand.
// Use kebab-case lucide names — a name in neither map is passed straight to
// lucide's DynamicIcon.

import { ArrowLeft, ChevronRight, EllipsisVertical, type LucideIcon, Menu } from "lucide-react";
import { DynamicIcon, type IconName } from "lucide-react/dynamic";

// Persistent chrome icons (screen-header kebab/menu/back, row chevrons) — eager
// so they don't pop in after the inline icons around them. Keyed by the same
// kebab name callers pass.
const STATIC_LUCIDE: Record<string, LucideIcon> = {
  "ellipsis-vertical": EllipsisVertical,
  menu: Menu,
  "arrow-left": ArrowLeft,
  "chevron-right": ChevronRight,
};

const CUSTOM_PATHS: Record<string, string> = {
  home: "M3 12l9-8 9 8M5 10v10h14V10",
  chart: "M3 20h18M6 17V11M10 17V8M14 17V13M18 17V6",
  chat: "M21 12c0 4.4-4 8-9 8-1.5 0-2.9-.3-4.2-.9L3 21l1.3-3.6C3.5 16.1 3 14.1 3 12c0-4.4 4-8 9-8s9 3.6 9 8z",
  insight:
    "M9 2v4M15 2v4M3 10h18M5 6h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2zM8 14l3 3 5-6",
  user: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z",
  settings:
    "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 01-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 01-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 012.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 012.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z",
  send: "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z",
  sparkle: "M12 3l1.9 4.7L18 9l-4.1 1.3L12 15l-1.9-4.7L6 9l4.1-1.3L12 3z",
  arrowRight: "M5 12h14M12 5l7 7-7 7",
  arrowUp: "M12 19V5M5 12l7-7 7 7",
  arrowDown: "M12 5v14M5 12l7 7 7-7",
  plus: "M12 5v14M5 12h14",
  "chevron-down": "M6 9l6 6 6-6",
  close: "M18 6L6 18M6 6l12 12",
  check: "M5 12l5 5 9-11",
  info: "M12 16v-4M12 8h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  refresh: "M3 12a9 9 0 015-8 9 9 0 0114 5M21 12a9 9 0 01-5 8 9 9 0 01-14-5M21 4v6h-6M3 20v-6h6",
  copy: "M9 9h10v10a2 2 0 01-2 2H9zM5 15H3V5a2 2 0 012-2h10v2",
  "rotate-cw": "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8M21 3v5h-5",
  pulse: "M22 12h-4l-3 9L9 3l-3 9H2",
  search: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3",
  lock: "M5 11h14v10H5zM7 11V7a5 5 0 0110 0v4",
  book: "M4 19V5a2 2 0 012-2h12v18H6a2 2 0 010-4h12",
  pencil: "M17 3a2.85 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z",
};

export interface IconProps {
  name: string;
  size?: number;
  className?: string;
}

export function Icon({ name, size = 18, className = "" }: IconProps) {
  // 1. App-specific icons render from local paths.
  const d = CUSTOM_PATHS[name];
  if (d) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
      >
        <path d={d}></path>
      </svg>
    );
  }
  // 2. Eager chrome icons — bundled, no lazy load.
  const Static = STATIC_LUCIDE[name];
  if (Static) {
    return <Static size={size} strokeWidth={1.5} className={className} aria-hidden="true" />;
  }
  // 3. Fall through to lucide (1700+ icons, each lazy-loaded on demand).
  const lucideName = name as IconName;
  return (
    <DynamicIcon
      name={lucideName}
      size={size}
      strokeWidth={1.5}
      className={className}
      aria-hidden="true"
    />
  );
}
