// Builds the web UI (src/pages/app.astro + src/app/) into a single file: dist-app/index.html
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inlineHtml } from './lib/inline.ts';
import { ROOT, stripAnsi } from './lib/paths.ts';

const out = path.join(ROOT, '.build', '__app');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const t = Date.now();
const res = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/astro/bin/astro.mjs'), 'build', '--silent'], {
  cwd: ROOT,
  // No explainer content: only the static pages (the app) are built.
  env: { ...process.env, EXPLAINER_SLUG: '__no_explainer__', EXPLAINER_OUT_DIR: out, ASTRO_TELEMETRY_DISABLED: '1', FORCE_COLOR: '0' },
  encoding: 'utf8',
});
if (res.status !== 0) {
  console.error(`✗ App build failed\n${stripAnsi(`${res.stdout}\n${res.stderr}`).trim()}`);
  process.exit(1);
}
const html = await inlineHtml(path.join(out, 'app.html'), out);
mkdirSync(path.join(ROOT, 'dist-app'), { recursive: true });
writeFileSync(path.join(ROOT, 'dist-app/index.html'), html);
console.log(`✓ Built dist-app/index.html (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB) in ${((Date.now() - t) / 1000).toFixed(1)}s`);
