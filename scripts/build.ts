// Usage: node scripts/build.ts <slug | path/to/explainer> [--open]
// Builds <explainer>/index.mdx into the standalone file <explainer>/index.html
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { COMPONENT_NAMES as components } from './lib/components.ts';
import { inlineHtml } from './lib/inline.ts';
import { type ExplainerPaths, requireTarget, ROOT, stripAnsi } from './lib/paths.ts';
import { validateMdx } from './lib/validate-mdx.ts';

export type BuildResult = { ok: true; html: string; bytes: number } | { ok: false; error: string };

export async function build(p: ExplainerPaths): Promise<BuildResult> {
  const problems = validateMdx(readFileSync(p.mdx, 'utf8'));
  if (problems.length) return { ok: false, error: `MDX validation failed:\n${problems.map((x) => `- ${x}`).join('\n')}` };

  rmSync(p.buildDir, { recursive: true, force: true });
  mkdirSync(p.buildDir, { recursive: true });
  const res = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/astro/bin/astro.mjs'), 'build', '--silent'], {
    cwd: ROOT,
    env: {
      ...process.env,
      EXPLAINER_CONTENT_DIR: path.dirname(p.dir),
      EXPLAINER_SLUG: p.slug,
      EXPLAINER_OUT_DIR: p.buildDir,
      ASTRO_TELEMETRY_DISABLED: '1',
      FORCE_COLOR: '0',
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) return { ok: false, error: cleanError(`${res.stdout}\n${res.stderr}`) };
  try {
    const html = await inlineHtml(path.join(p.buildDir, `${p.slug}.html`), p.buildDir);
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
    .map((l) => l.replaceAll(ROOT + '/', '').replace(/\S*\/([^/\s]+\/index\.mdx)/g, 'index.mdx'));
  let text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const missing = /Expected component `(\w+)` to be defined/.exec(text);
  if (missing) {
    text += `\n\n<${missing[1]}> is not an available component. Available components: ${components.join(', ')}.`;
  }
  return text.slice(0, 4000);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const p = requireTarget(process.argv[2]);
  const t = Date.now();
  const r = await build(p);
  if (!r.ok) {
    console.error(`✗ Build failed for ${p.slug}\n\n${r.error}`);
    process.exit(1);
  }
  console.log(`✓ Built ${path.relative(process.cwd(), r.html)} (${(r.bytes / 1024 / 1024).toFixed(2)} MB) in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  if (process.argv.includes('--open')) {
    const [cmd, ...args] = process.platform === 'darwin' ? ['open', r.html] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', r.html] : ['xdg-open', r.html];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  }
}
