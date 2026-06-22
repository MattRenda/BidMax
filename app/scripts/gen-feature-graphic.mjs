// One-off: generate the Google Play feature graphic (1024x500) matching the
// app icon (green "B" badge) and splash (#080d14 dark). Run:
//   node scripts/gen-feature-graphic.mjs
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';

const GREEN = '#22c55e';
const INK = '#04140a';
const DARK = '#080d14';
const MUTED = '#9aa6b2';

const ARIAL = 'C:/Windows/Fonts/arial.ttf';
const ARIAL_BD = 'C:/Windows/Fonts/arialbd.ttf';

const W = 1024;
const H = 500;

// Badge geometry (left side), mirrors the rounded app icon.
const BADGE = 230;
const BX = 90;
const BY = (H - BADGE) / 2;
const badgeCx = BX + BADGE / 2;
const badgeCy = BY + BADGE / 2;
// Center an Arial-bold cap "B" of this size vertically in the badge.
const bFont = 168;
const bBaseline = Math.round(badgeCy + 0.716 * bFont * 0.5);

const textX = BX + BADGE + 55; // start of the text block

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1220"/>
      <stop offset="1" stop-color="#05160c"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="${DARK}"/>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>

  <!-- faint oversized B watermark on the right for depth -->
  <text x="990" y="430" font-family="Arial" font-weight="bold" font-size="560"
        fill="${GREEN}" fill-opacity="0.06" text-anchor="end">B</text>

  <!-- green app badge -->
  <rect x="${BX}" y="${BY}" width="${BADGE}" height="${BADGE}" rx="50" fill="${GREEN}"/>
  <text x="${badgeCx}" y="${bBaseline}" font-family="Arial" font-weight="bold"
        font-size="${bFont}" fill="${INK}" text-anchor="middle">B</text>

  <!-- wordmark + tagline -->
  <text x="${textX}" y="240" font-family="Arial" font-weight="bold" font-size="116"
        fill="#ffffff">BidMax</text>
  <text x="${textX}" y="308" font-family="Arial" font-weight="bold" font-size="42" fill="${GREEN}">
    Built for BidRL bidders
  </text>
  <text x="${textX}" y="356" font-family="Arial" font-size="28" fill="${MUTED}">
    Know an item's worth before you bid.
  </text>
</svg>`;

const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: W },
  font: { fontFiles: [ARIAL, ARIAL_BD], loadSystemFonts: false, defaultFontFamily: 'Arial' },
});
writeFileSync('assets/play-feature-graphic.png', resvg.render().asPng());
console.log('wrote assets/play-feature-graphic.png (1024x500)');
