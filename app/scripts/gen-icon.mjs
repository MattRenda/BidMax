// One-off: generate app icons that match the in-app sign-in logo
// (green field + bold "B"). Run: node scripts/gen-icon.mjs
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const GREEN = '#22c55e';
const INK = '#04140a';
const FONT = 'C:/Windows/Fonts/arialbd.ttf';

// Baseline y to visually center an Arial cap "B" of the given font size on 1024.
const baseline = (size) => Math.round(512 + 0.716 * size * 0.5);

function svg(fontSize) {
  return `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <rect width="1024" height="1024" fill="${GREEN}"/>
  <text x="512" y="${baseline(fontSize)}" font-family="Arial" font-weight="bold" font-size="${fontSize}" fill="${INK}" text-anchor="middle">B</text>
</svg>`;
}

// flatten: strip the alpha channel (RGBA→RGB). iOS app icons must NOT have an
// alpha channel or they render blank / get rejected, even when fully opaque.
function render(svgStr, out, size = 1024, flatten = false) {
  const resvg = new Resvg(svgStr, {
    fitTo: { mode: 'width', value: size },
    font: { fontFiles: [FONT], loadSystemFonts: false, defaultFontFamily: 'Arial' },
  });
  let buf = resvg.render().asPng();
  if (flatten) {
    const png = PNG.sync.read(buf);
    buf = PNG.sync.write(png, { colorType: 2, inputColorType: 6 }); // RGB out, RGBA in
  }
  writeFileSync(out, buf);
  console.log('wrote', out, flatten ? '(RGB, no alpha)' : '');
}

// Full-bleed icon (the OS rounds the corners). iOS needs no alpha → flatten.
render(svg(620), 'assets/icon.png', 1024, true);
// Android adaptive foreground — keep alpha (adaptive icons may use transparency).
render(svg(470), 'assets/adaptive-icon.png');
// 512×512 hi-res icon for the Play Store listing — flatten for safety.
render(svg(620), 'assets/play-store-icon.png', 512, true);
