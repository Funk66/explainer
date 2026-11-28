// Renders the app icons (server/pwa/icons/*.png) with Playwright. Run only when the logo changes: `node scripts/make-icons.ts`
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from './lib/paths.ts';

const out = path.join(ROOT, 'server/pwa/icons');
mkdirSync(out, { recursive: true });
/** `inset` shrinks the glyph for maskable icons (platforms crop to a circle/squircle, keeping the inner 80%). */
const svg = (size: number, radius: number, inset: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="${radius}" fill="#344aa0"/>
  <g transform="translate(16 16) scale(${inset}) translate(-16 -16)"><path d="M9 9h14M9 16h10M9 23h7" stroke="white" stroke-width="3" stroke-linecap="round"/></g></svg>`;
const icons: [string, number, number, number][] = [
  ['icon-192.png', 192, 8, 1], ['icon-512.png', 512, 8, 1], ['icon-maskable-512.png', 512, 0, 0.8], ['apple-touch-icon.png', 180, 0, 0.9],
];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, radius, inset] of icons) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0">${svg(size, radius, inset)}</body>`);
  await page.screenshot({ path: path.join(out, name), clip: { x: 0, y: 0, width: size, height: size } });
}
await browser.close();
console.log(`✓ Icons written to ${out}`);
