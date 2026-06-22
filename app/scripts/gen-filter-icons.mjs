// One-off: generate line icons for the Filters sheet (white on transparent so
// they can be tinted at runtime). Run: node scripts/gen-filter-icons.mjs
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';

const FONT = 'C:/Windows/Fonts/arialbd.ttf';

// 24x24 viewBox, stroke-based (white). Tinted per-row in the app.
const ICONS = {
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3.5 2"/>',
  'clock-late': '<polyline points="2 4 2 9.5 7.5 9.5"/><path d="M4.2 14.5a8.5 8.5 0 1 0 1.8-8.7"/>',
  'sort-desc': '<line x1="5" y1="4.5" x2="5" y2="19"/><polyline points="2 16 5 19.5 8 16"/><line x1="11" y1="6" x2="21" y2="6"/><line x1="11" y1="12" x2="18" y2="12"/><line x1="11" y1="18" x2="14.5" y2="18"/>',
  'sort-asc': '<line x1="5" y1="19.5" x2="5" y2="5"/><polyline points="2 8 5 4.5 8 8"/><line x1="11" y1="6" x2="14.5" y2="6"/><line x1="11" y1="12" x2="18" y2="12"/><line x1="11" y1="18" x2="21" y2="18"/>',
  'trending-up': '<polyline points="22 6.5 13.5 15.5 8.5 10.5 2 17.5"/><polyline points="16.5 6.5 22 6.5 22 12"/>',
};

function wrap(inner) {
  return `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

function render(name, inner) {
  const resvg = new Resvg(wrap(inner), {
    fitTo: { mode: 'width', value: 72 },
    font: { fontFiles: [FONT], loadSystemFonts: false, defaultFontFamily: 'Arial' },
  });
  writeFileSync(`assets/ic-${name}.png`, resvg.render().asPng());
  console.log('wrote ic-' + name);
}

for (const [name, inner] of Object.entries(ICONS)) render(name, inner);

// A–Z: down arrow + bold "A"/"Z" letters (filled, so they tint with the icon).
render('az',
  '<line x1="4.5" y1="4.5" x2="4.5" y2="19"/><polyline points="1.5 16 4.5 19.5 7.5 16"/>' +
  '<text x="10" y="10.5" font-family="Arial" font-weight="bold" font-size="9" fill="#ffffff" stroke="none">A</text>' +
  '<text x="10" y="21" font-family="Arial" font-weight="bold" font-size="9" fill="#ffffff" stroke="none">Z</text>'
);
