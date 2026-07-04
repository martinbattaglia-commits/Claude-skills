"use client";

import { useEffect, useRef, useState } from "react";
import { clearDemoSession } from "@/lib/auth/clear-demo";

export function DemoBanner() {
  const [exiting, setExiting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Publish the banner's actual rendered height to a CSS variable so layout
  // containers (.ra-main, .ra-shell, rails, etc.) subtract the right amount.
  // The banner wraps to 2 lines on narrow viewports — a static 48px guess
  // leaves an 18px gap on desktop where it's only 30px tall.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      document.body.style.setProperty("--demo-banner-h", `${el.offsetHeight}px`);
    };
    apply();
    const obs = new ResizeObserver(apply);
    obs.observe(el);
    return () => {
      obs.disconnect();
      document.body.style.removeProperty("--demo-banner-h");
    };
  }, []);

  async function exit() {
    setExiting(true);
    await clearDemoSession();
    window.location.href = "/";
  }

  return (
    <div
      // Class is a hook for selectors; the actual height value comes from the
      // ResizeObserver above so it matches whatever the banner actually
      // renders at (varies by viewport — wraps to 2 lines under ~480px).
      ref={ref}
      className="demo-banner"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "var(--amber)",
        color: "#1a1a1a",
        padding: "6px 16px",
        fontSize: 12,
        fontWeight: 500,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: 12,
        textAlign: "center",
      }}
    >
      <span style={{ minWidth: 0 }}>Demo mode — your changes won't be saved.</span>
      <button
        type="button"
        onClick={exit}
        disabled={exiting}
        style={{
          background: "rgba(0,0,0,0.18)",
          color: "inherit",
          border: "none",
          borderRadius: 6,
          padding: "3px 10px",
          fontSize: 11,
          fontWeight: 500,
          cursor: "pointer",
          flexShrink: 0,
          whiteSpace: "nowrap",
        }}
      >
        {exiting ? "Exiting…" : "Exit demo"}
      </button>
    </div>
  );
}
