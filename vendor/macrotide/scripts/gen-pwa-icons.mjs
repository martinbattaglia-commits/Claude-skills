// Generates the PWA / iOS icon set from the brand wave mark.
//
// Two shapes, because the OS treats icons differently per surface:
//
//  • BLEED (full square, opaque) — for surfaces that apply their OWN mask:
//    iOS home-screen (apple-icon) and the Android "maskable" icon. The art runs
//    edge to edge; the OS rounds it. A pre-rounded/transparent source here would
//    double-mask (halo / wallpaper through the corners).
//
//  • BADGE (rounded square, transparent corners) — for surfaces that show the
//    icon AS-IS, unmasked: the Android splash screen, the install dialog, the
//    task switcher, desktop PWAs. A flush square would look like a bare square
//    on the splash; the rounded badge reads as a real logo on background_color.
//
// Run: node scripts/gen-pwa-icons.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const INK = "#111110";
const TEAL = "#0AA694";

// Full-bleed: dark field + the teal tide wave to the square edges.
const bleed = (
  s,
) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22" width="${s}" height="${s}">
  <rect width="22" height="22" fill="${INK}"/>
  <path d="M 0 11 Q 5.5 5 11 11 T 22 11 L 22 22 L 0 22 Z" fill="${TEAL}"/>
</svg>`;

// Rounded badge (matches app/icon.svg): rx corners, wave tucked inside, corners
// left transparent so the host surface shows through.
const badge = (
  s,
) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22" width="${s}" height="${s}">
  <rect width="22" height="22" rx="6" fill="${INK}"/>
  <path d="M 0 11 Q 5.5 5 11 11 T 22 11 L 22 16 A 6 6 0 0 1 16 22 L 6 22 A 6 6 0 0 1 0 16 Z" fill="${TEAL}"/>
</svg>`;

const opaque = (size, art, outAbs) =>
  sharp(Buffer.from(art(size)))
    .flatten({ background: INK }) // no alpha — OS will mask it
    .png()
    .toFile(outAbs)
    .then(() => console.log("✓ opaque ", path.relative(root, outAbs), `(${size}×${size})`));

const transparent = (size, art, outAbs) =>
  sharp(Buffer.from(art(size)))
    .png() // keep alpha — rounded corners show the surface behind
    .toFile(outAbs)
    .then(() => console.log("✓ alpha  ", path.relative(root, outAbs), `(${size}×${size})`));

await Promise.all([
  opaque(180, bleed, path.join(root, "app/apple-icon.png")), // iOS masks
  opaque(512, bleed, path.join(root, "public/icon-512-maskable.png")), // Android masks
  transparent(192, badge, path.join(root, "public/icon-192.png")), // shown as-is
  transparent(512, badge, path.join(root, "public/icon-512.png")), // shown as-is (splash)
]);
console.log("done");
