"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface in the browser console so dev sees the stack; production
    // hosts should wire a real error reporter here.
    console.error("[macrotide] unhandled error", error);
  }, [error]);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        fontFamily: "var(--font-sans)",
        background: "var(--bg)",
        color: "var(--ink)",
      }}
    >
      <div
        style={{
          maxWidth: 420,
          textAlign: "center",
          border: "1px solid var(--line-soft)",
          background: "var(--paper)",
          borderRadius: 12,
          padding: "32px 24px",
        }}
      >
        <div style={{ fontSize: 28, marginBottom: 12 }}>⚠</div>
        <div
          style={{
            fontSize: 18,
            fontWeight: 500,
            letterSpacing: "-0.02em",
            marginBottom: 8,
          }}
        >
          Something broke
        </div>
        <div
          style={{
            fontSize: 13,
            color: "var(--muted)",
            lineHeight: 1.5,
            marginBottom: 20,
          }}
        >
          {error.message || "An unexpected error occurred."}
          {error.digest && (
            <span
              style={{
                display: "block",
                marginTop: 6,
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                opacity: 0.7,
              }}
            >
              ref: {error.digest}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <button type="button" className="btn primary" onClick={reset}>
            Try again
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              window.location.href = "/";
            }}
          >
            Reload home
          </button>
        </div>
      </div>
    </div>
  );
}
