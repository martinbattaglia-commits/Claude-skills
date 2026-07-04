// Shared auth icons — used on both the /login buttons and the Account screen's
// sign-in methods so the two stay identical (no duplicated SVGs).
//
// Google: the official multi-color "Sign in with Google" G mark (fixed brand
// colors, so `size` scales it but there's no color override).
// Passkey: the Material Symbols "passkey" glyph (single-color, `fill`). This is
// the widely-used platform passkey icon, NOT the literal FIDO Alliance brand
// logo — swap the path if the official FIDO asset is required.

/** OAuth provider glyph. Google = official 4-color G; unknown ids = a neutral mark. */
export function ProviderIcon({ id, size = 15 }: { id: string; size?: number }) {
  if (id === "google") {
    return (
      <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
        <path
          fill="#EA4335"
          d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
        />
        <path
          fill="#4285F4"
          d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
        />
        <path
          fill="#FBBC05"
          d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
        />
        <path
          fill="#34A853"
          d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
        />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--muted)"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

/** Passkey glyph (Material Symbols "passkey"). */
export function PasskeyIcon({
  size = 15,
  color = "currentColor",
}: {
  size?: number;
  color?: string;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path
        fill={color}
        d="M3 20v-2.8q0-.85.438-1.562T4.6 14.55q1.55-.775 3.15-1.162T11 13q.5 0 1 .038t1 .112q-.1 1.45.525 2.738T15.35 18v2zm16 3l-1.5-1.5v-4.65q-1.1-.325-1.8-1.237T15 13.5q0-1.45 1.025-2.475T18.5 10t2.475 1.025T22 13.5q0 1.125-.638 2t-1.612 1.25L21 18l-1.5 1.5L21 21zm-8-11q-1.65 0-2.825-1.175T7 8t1.175-2.825T11 4t2.825 1.175T15 8t-1.175 2.825T11 12m8.213 1.713q.287-.288.287-.713t-.288-.712T18.5 12t-.712.288T17.5 13t.288.713t.712.287t.713-.288"
      />
    </svg>
  );
}
