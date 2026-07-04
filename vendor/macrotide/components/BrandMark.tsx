// Macrotide brand mark — L-09 × C-03 (Horizon × sine wave, bluegreen)
//
// Inline SVG so it scales crisply at every size and no external file is loaded
// before first paint. Pure presentation — `aria-hidden` is on by default; if
// you ever need it announced, pass `aria-label` and `role="img"` from the call
// site.
//
// Outer fill uses `var(--ink)` so the mark inverts cleanly in dark mode (the
// same pattern as the old solid-square mark). The wave uses `var(--accent-2)`
// — defined in `app/globals.css`. Both tokens have light + dark values so the
// mark stays legible against any theme.

interface BrandMarkProps {
  size?: number;
  className?: string;
}

export function BrandMark({ size = 22, className }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 22 22"
      aria-hidden="true"
      role="presentation"
      className={className}
      style={{ display: "block", flexShrink: 0 }}
    >
      <rect width="22" height="22" rx="6" fill="var(--ink)" />
      <path
        d="M 0 11 Q 5.5 5 11 11 T 22 11 L 22 16 A 6 6 0 0 1 16 22 L 6 22 A 6 6 0 0 1 0 16 Z"
        fill="var(--accent-2)"
      />
    </svg>
  );
}
