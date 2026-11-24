// Usage: node scripts/build.ts <slug> [--open]
// Builds explainers/<slug>/index.mdx into the standalone file explainers/<slug>/<slug>.html
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { inlineHtml } from './lib/inline.ts';
import { paths, requireSlug, ROOT, stripAnsi } from './lib/paths.ts';
import { COMPONENT_NAMES as components } from './lib/components.ts';

export async function build(slug: string): Promise<{ ok: true; html: string; bytes: number } | { ok: false; error: string }> {
  const p = paths(slug);
  rmSync(p.buildDir, { recursive: true, force: true });
  mkdirSync(p.buildDir, { recursive: true });
  const res = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/astro/bin/astro.mjs'), 'build', '--silent'], {
    cwd: ROOT,
    env: { ...process.env, EXPLAINER_SLUG: slug, EXPLAINER_OUT_DIR: p.buildDir, ASTRO_TELEMETRY_DISABLED: '1', FORCE_COLOR: '0' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) return { ok: false, error: cleanError(`${res.stdout}\n${res.stderr}`) };
  try {
    const html = await inlineHtml(path.join(p.buildDir, `${slug}.html`), p.buildDir);
    writeFileSync(p.html, html);
    return { ok: true, html: p.html, bytes: Buffer.byteLength(html) };
  } catch (err: any) {
    return { ok: false, error: `Inlining failed: ${err?.message ?? err}` };
  }
}

/** Keep the part of Astro's output that is useful to an author: message, location and code frame. */
function cleanError(out: string): string {
  const lines = stripAnsi(out).split('\n')
    .filter((l) => !/^\s+at\s|^\s*Stack trace:|node:internal|^\/\*! .*daisyUI/.test(l))
    .map((l) => l.replaceAll(ROOT + '/', ''));
  let text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const missing = /Expected component `(\w+)` to be defined/.exec(text);
  if (missing) {
    text += `\n\n<${missing[1]}> is not an available component. Available components: ${components.join(', ')}.`;
  }
  return text.slice(0, 4000);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const slug = requireSlug(process.argv[2]);
  const t = Date.now();
  const r = await build(slug);
  if (!r.ok) {
    console.error(`✗ Build failed for ${slug}\n\n${r.error}`);
    process.exit(1);
  }
  console.log(`✓ Built ${path.relative(process.cwd(), r.html)} (${(r.bytes / 1024 / 1024).toFixed(2)} MB) in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  if (process.argv.includes('--open')) {
    const [cmd, ...args] = process.platform === 'darwin' ? ['open', r.html] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', r.html] : ['xdg-open', r.html];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  }
}
