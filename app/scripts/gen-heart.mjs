// One-off: generate rounded heart icons for the watchlist toggle (white on
// transparent so they can be tinted at runtime). Run: node scripts/gen-heart.mjs
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';

// Rounded heart path (24x24 viewBox), matching a classic filled-heart silhouette.
const PATH =
  'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z';

function svg(filled) {
  const inner = filled
    ? `<path d="${PATH}" fill="#ffffff"/>`
    : `<path d="${PATH}" fill="none" stroke="#ffffff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  return `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}

function render(filled, out) {
  // White on transparent at 4x (96px) so it stays crisp tinted at ~20–24px.
  const resvg = new Resvg(svg(filled), { fitTo: { mode: 'width', value: 96 } });
  writeFileSync(out, resvg.render().asPng());
  console.log('wrote', out);
}

render(false, 'assets/heart-outline.png');
render(true, 'assets/heart-filled.png');
