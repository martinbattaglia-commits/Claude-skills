// Fixture generator for the OCR eval. Emits realistic, macrotide-styled mobile
// holdings screens from a sectioned fund array — P/L and return % are COMPUTED
// from invested+value so the rendered numbers are always internally consistent.
// Synthetic data only (illustrative Thai fund codes, invented amounts — NOT any
// real portfolio). Add funds by editing the SECTIONS array, then re-run:
//   node scripts/eval/fixtures/ocr/_build.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// macrotide palette — light + dark (from app/globals.css). OCR on a dark
// background is a real-world condition, so we render both themes.
const THEMES = {
  light: {
    bg: "#f8f8f9",
    paper: "#ffffff",
    line: "#e6e7ea",
    ink: "#0a0a0b",
    inkSoft: "#3a3d43",
    muted: "#7e828a",
    muted2: "#a8acb2",
    gain: "#10a86b",
    loss: "#d14545",
  },
  dark: {
    bg: "#0c0d0f",
    paper: "#16181b",
    line: "#22252a",
    ink: "#f4f5f7",
    inkSoft: "#c5c8cd",
    muted: "#7a7f87",
    muted2: "#595d63",
    gain: "#19c37d",
    loss: "#f46a6a",
  },
};

const num = (n) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (p) => `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;
// `style.baht` prefixes ฿ (the "฿ is not a digit" hard edge); `style.paren`
// renders losses as (1,234.56) instead of -1,234.56 (the paren-negative edge).
const money = (n, style) => {
  const neg = n < 0;
  const body = `${style.baht ? "฿" : ""}${num(Math.abs(n))}`;
  if (neg) return style.paren ? `(${body})` : `-${body}`;
  return body;
};

// Each fund: { code, invested, value }. pl + return% are derived. Codes match
// their tax-wrapper section (RMF funds end -RMF, SSF -SSF, ThaiESG -TESG).
const SECTIONS = [
  {
    title: "RMF",
    funds: [
      { code: "KGOLDRMF", invested: 150000, value: 168420.55 },
      { code: "SCBSP500RMF", invested: 250000, value: 231780.4 },
    ],
  },
  {
    title: "SSF",
    funds: [
      { code: "KUSASSF", invested: 100000, value: 112340.1 },
      { code: "SCBSET50SSF", invested: 80000, value: 74512.8 },
    ],
  },
  {
    title: "ThaiESG",
    funds: [{ code: "K-TESG", invested: 60000, value: 63905.25 }],
  },
  {
    title: "กองทุนรวมทั่วไป",
    funds: [
      { code: "TISCOMS", invested: 120000, value: 134220.7 },
      { code: "K-USA-A(A)", invested: 90000, value: 86430.15 },
    ],
  },
];

const allFunds = SECTIONS.flatMap((s) => s.funds);
const totalInvested = allFunds.reduce((a, f) => a + f.invested, 0);
const totalValue = allFunds.reduce((a, f) => a + f.value, 0);
const totalPl = totalValue - totalInvested;

function card(y, f, style, C) {
  const pl = f.value - f.invested;
  const ret = (pl / f.invested) * 100;
  const col = pl >= 0 ? C.gain : C.loss;
  return `
  <rect x="36" y="${y}" width="1008" height="160" rx="16" fill="${C.paper}" stroke="${C.line}" stroke-width="1.5"/>
  <text x="68" y="${y + 52}" font-size="34" font-weight="700" fill="${C.ink}">${f.code}</text>
  <text x="1012" y="${y + 52}" font-size="32" font-weight="700" fill="${col}" text-anchor="end">${pct(ret)}  ›</text>
  <text x="68"  y="${y + 116}" font-size="32" font-weight="700" fill="${C.ink}">${money(f.invested, style)}</text>
  <text x="402" y="${y + 116}" font-size="32" font-weight="700" fill="${C.ink}">${money(f.value, style)}</text>
  <text x="1012" y="${y + 116}" font-size="32" font-weight="700" fill="${col}" text-anchor="end">${money(pl, style)}</text>
  <text x="68"  y="${y + 148}" font-size="22" fill="${C.muted}" font-family="Thonburi, sans-serif">ยอดเงินลงทุน</text>
  <text x="402" y="${y + 148}" font-size="22" fill="${C.muted}" font-family="Thonburi, sans-serif">มูลค่าปัจจุบัน</text>
  <text x="1012" y="${y + 148}" font-size="22" fill="${C.muted}" text-anchor="end" font-family="Thonburi, sans-serif">กำไร / ขาดทุน</text>`;
}

function build(style, filename, C) {
  let y = 420;
  let body = "";
  for (const s of SECTIONS) {
    body += `
  <text x="44" y="${y}" font-size="30" font-weight="700" fill="${C.ink}" font-family="Thonburi, sans-serif">${s.title}</text>
  <text x="1036" y="${y}" font-size="26" fill="${C.muted}" text-anchor="end" font-family="Thonburi, sans-serif">${s.funds.length} กองทุน</text>`;
    y += 28;
    for (const f of s.funds) {
      body += card(y, f, style, C);
      y += 178;
    }
    y += 28;
  }
  const navY = y + 60;
  const H = navY + 120;
  const totalCol = totalPl >= 0 ? C.gain : C.loss;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${H}" font-family="Helvetica, Arial, sans-serif">
  <rect width="1080" height="${H}" fill="${C.bg}"/>
  <text x="36" y="44" font-size="26" fill="${C.inkSoft}">9:41</text>
  <text x="1044" y="44" font-size="24" fill="${C.inkSoft}" text-anchor="end">● ▮▮▮ 82%</text>
  <circle cx="58" cy="106" r="16" fill="${C.gain}"/>
  <text x="86" y="118" font-size="40" font-weight="700" fill="${C.ink}">Holdings</text>
  <text x="1044" y="116" font-size="28" font-weight="600" fill="${C.muted}" text-anchor="end" font-family="Thonburi, sans-serif">บัญชี 087-512</text>
  <text x="44" y="186" font-size="30" font-weight="600" fill="${C.inkSoft}" font-family="Thonburi, sans-serif">มูลค่าพอร์ตรวม</text>
  <text x="44" y="248" font-size="48" font-weight="700" fill="${C.ink}">${money(totalValue, style)}</text>
  <text x="1044" y="248" font-size="44" font-weight="700" fill="${totalCol}" text-anchor="end">${money(totalPl, style)}</text>
  <text x="44" y="288" font-size="26" fill="${C.muted}" font-family="Thonburi, sans-serif">ยอดเงินลงทุน ${money(totalInvested, style)}</text>
  <text x="1044" y="288" font-size="26" fill="${C.muted}" text-anchor="end" font-family="Thonburi, sans-serif">กำไร / ขาดทุน</text>
  <line x1="44" y1="332" x2="1036" y2="332" stroke="${C.line}" stroke-width="2"/>${body}
  <line x1="0" y1="${navY}" x2="1080" y2="${navY}" stroke="${C.line}" stroke-width="2"/>
  <text x="120" y="${navY + 56}" font-size="24" fill="${C.gain}" text-anchor="middle" font-family="Thonburi, sans-serif">พอร์ต</text>
  <text x="360" y="${navY + 56}" font-size="24" fill="${C.muted2}" text-anchor="middle" font-family="Thonburi, sans-serif">สำรวจ</text>
  <text x="600" y="${navY + 56}" font-size="24" fill="${C.muted2}" text-anchor="middle" font-family="Thonburi, sans-serif">ที่ปรึกษา</text>
  <text x="840" y="${navY + 56}" font-size="24" fill="${C.muted2}" text-anchor="middle" font-family="Thonburi, sans-serif">ตลาด</text>
  <text x="1000" y="${navY + 56}" font-size="30" fill="${C.muted2}" text-anchor="middle">⌕</text>
</svg>
`;
  writeFileSync(join(HERE, filename), svg);
}

// UIs varying theme + number hard-edge, SAME data → one shared ground-truth set.
build({ baht: false, paren: false }, "mobile-3col.svg", THEMES.light); // light, plain
build({ baht: true, paren: true }, "mobile-baht.svg", THEMES.light); // light, ฿ + (paren)
build({ baht: false, paren: false }, "mobile-dark.svg", THEMES.dark); // dark mode

const rows = allFunds.map((f) => ({
  ticker: f.code,
  costTotal: f.invested,
  value: f.value,
  pl: Math.round((f.value - f.invested) * 100) / 100,
}));
console.log(
  "wrote mobile-3col.svg + mobile-baht.svg + mobile-dark.svg ·",
  allFunds.length,
  "funds (shared ground truth):",
);
console.log(JSON.stringify(rows, null, 2));
