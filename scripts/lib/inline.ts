// Turns Astro's multi-file output into a single self-contained HTML file:
// stylesheets and assets become inline/data: URIs and all module scripts are re-bundled
// (with esbuild, no code splitting) into one inline <script type="module">.
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import * as esbuild from 'esbuild';

const MIME: Record<string, string> = {
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
};

export async function inlineHtml(htmlFile: string, outDir: string): Promise<string> {
  let html = await readFile(htmlFile, 'utf8');
  const local = (href: string) => path.join(outDir, href.replace(/^\.?\//, ''));
  const dataUri = async (href: string) => {
    const mime = MIME[path.extname(href).toLowerCase()] ?? 'application/octet-stream';
    return `data:${mime};base64,${(await readFile(local(href))).toString('base64')}`;
  };

  // 1. Stylesheets
  for (const m of [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*href="(\/[^"]+)"[^>]*>/g)]) {
    const css = await readFile(local(m[1]), 'utf8');
    html = html.replace(m[0], () => `<style>${css}</style>`);
  }
  // 2. Preload hints are pointless in a single file
  html = html.replace(/<link[^>]+rel="modulepreload"[^>]*>/g, '');

  // 3. Module scripts -> one bundle, executed in document order
  const imports: string[] = [];
  const temp: string[] = [];
  for (const m of [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]) {
    const attrs = m[1];
    if (!/type="module"/.test(attrs)) continue;
    const src = /src="([^"]+)"/.exec(attrs)?.[1];
    if (src) {
      imports.push(local(src));
    } else {
      const file = path.join(outDir, `__inline_${temp.length}.mjs`);
      await writeFile(file, m[2]);
      temp.push(file);
      imports.push(file);
    }
    html = html.replace(m[0], () => '');
  }
  if (imports.length) {
    const result = await esbuild.build({
      stdin: { contents: imports.map((f) => `import ${JSON.stringify(f)};`).join('\n'), resolveDir: outDir, loader: 'js' },
      bundle: true, write: false, format: 'esm', minify: true, target: 'es2022', legalComments: 'none', charset: 'utf8', logLevel: 'silent',
      plugins: [{
        name: 'astro-absolute',
        setup(b) {
          b.onResolve({ filter: /^\/_astro\// }, (a) => ({ path: local(a.path) }));
          b.onLoad({ filter: /\.m?js$/ }, async (a) => ({
            contents: (await readFile(a.path, 'utf8'))
              // Rolldown emits import(`./chunk.js`); esbuild only inlines import("./chunk.js").
              .replace(/import\(`([^`$]+)`\)/g, (_, p) => `import(${JSON.stringify(p)})`)
              // Vite's preload helper would try to fetch the (now inlined) chunks: give it no deps.
              .replace(/__vite__mapDeps\(\[[\d,\s]*\]\)/g, '[]'),
            loader: 'js',
          }));
        },
      }],
    });
    const code = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
    html = html.replace('</body>', () => `<script type="module">${code}</script></body>`);
    await Promise.all(temp.map((f) => rm(f)));
  }

  // 4. Remaining asset references (images, css url()) -> data: URIs
  for (const m of [...new Set(html.match(/\/_astro\/[^"')\s]+/g) ?? [])]) {
    html = html.split(m).join(await dataUri(m));
  }
  return html;
}
