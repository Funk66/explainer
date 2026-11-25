// Astro configuration. Content authors never need to touch this file.
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import { unified } from '@astrojs/markdown-remark';
import tailwindcss from '@tailwindcss/vite';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import remarkMermaid from './src/lib/remark-mermaid.mjs';
import rehypeTableWrap from './src/lib/rehype-table-wrap.mjs';

/** KaTeX ships woff2 + woff + ttf fonts; keep only woff2 so the standalone HTML stays small. */
const katexWoff2Only = {
  name: 'katex-woff2-only',
  enforce: 'pre',
  transform(code, id) {
    if (!/katex(\.min)?\.css/.test(id)) return;
    return code.replace(/,\s*url\([^)]*\.(woff|ttf)\)\s*format\("(woff|truetype)"\)/g, '');
  },
};

export default defineConfig({
  outDir: process.env.EXPLAINER_OUT_DIR ?? './.build/site',
  build: { format: 'file', inlineStylesheets: 'always' },
  devToolbar: { enabled: false },
  markdown: {
    processor: unified({
      remarkPlugins: [remarkMath, remarkMermaid],
      rehypePlugins: [[rehypeKatex, { strict: false, throwOnError: false }], rehypeTableWrap],
      // Footnotes ([^1]) are how explainers cite sources.
      remarkRehype: {
        footnoteLabel: 'Sources',
        footnoteLabelTagName: 'h2',
        footnoteLabelProperties: { className: ['footnotes-label'] },
        footnoteBackLabel: 'Back to text',
      },
    }),
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
    },
  },
  integrations: [mdx()],
  vite: {
    plugins: [tailwindcss(), katexWoff2Only],
    // Inline every asset (fonts, images) as data: URIs -> one self-contained HTML file.
    build: { assetsInlineLimit: () => true, modulePreload: { polyfill: false, resolveDependencies: () => [] } },
  },
});
