// Usage: node scripts/check.ts <slug | path/to/explainer> [--json]
// Opens the built standalone HTML in headless Chromium and verifies that it really renders:
// no JS errors, no network requests, every diagram/chart/widget initialised, no math errors,
// no horizontal overflow on mobile. Saves desktop + mobile screenshots to <explainer>/.check/
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright';
import { type ExplainerPaths, requireTarget } from './lib/paths.ts';

export interface CheckReport {
  ok: boolean;
  issues: string[];
  warnings: string[];
  stats: Record<string, number>;
  screenshots: string[];
}

export async function check(p: ExplainerPaths): Promise<CheckReport> {
  const issues: string[] = [];
  const warnings: string[] = [];
  const screenshots: string[] = [];
  if (!existsSync(p.html)) return { ok: false, issues: [`${p.html} does not exist — build first`], warnings, stats: {}, screenshots };
  mkdirSync(p.checkDir, { recursive: true });
  const url = pathToFileURL(p.html).href;

  const browser = await chromium.launch();
  try {
    const watch = (page: Page) => {
      page.on('pageerror', (e) => issues.push(`Uncaught exception: ${e.message}`));
      page.on('console', (m) => {
        // Component failures are logged as "[component] ..." and reported below with more context.
        if (m.type() === 'error' && !/^\[[a-z-]+\] /.test(m.text())) issues.push(`Console error: ${m.text().slice(0, 600)}`);
      });
      page.on('request', (r) => {
        const u = r.url();
        if (u !== url && !u.startsWith('data:') && !u.startsWith('blob:')) issues.push(`Unexpected network request (the page must be self-contained): ${u}`);
      });
    };

    // ---------- Desktop ----------
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    watch(desktop);
    await desktop.goto(url, { waitUntil: 'load' });
    await waitForComponents(desktop);

    const result = await desktop.evaluate(() => {
      const comps = [...document.querySelectorAll<HTMLElement>('[data-component]')];
      const byType: Record<string, number> = {};
      comps.forEach((c) => { byType[c.dataset.component!] = (byType[c.dataset.component!] ?? 0) + 1; });
      const errors = comps.filter((c) => c.dataset.state === 'error').map((c) => `${c.dataset.component}: ${c.dataset.error}`);
      const pending = comps.filter((c) => c.dataset.state === 'pending').map((c) => c.dataset.component);
      const katexErrors = [...document.querySelectorAll<HTMLElement>('.katex-error')].map((e) => `${e.textContent?.slice(0, 80)} → ${e.title}`);
      const emptyCharts = [...document.querySelectorAll<HTMLElement>('.chart-target, .fp-chart')].filter((el) => !el.querySelector('canvas, svg') && el.offsetParent !== null).length;
      const article = document.querySelector('article')!;
      const text = article.innerText;
      const prose = article.cloneNode(true) as HTMLElement;
      prose.querySelectorAll('pre, code, .katex, [data-component]').forEach((el) => el.remove());
      const rawMarkdown = (prose.textContent!.match(/(^|\n)\s*#{1,6} |\*\*[^*\n]+\*\*|```/g) ?? []).length;
      return {
        byType, errors, pending, katexErrors, emptyCharts, rawMarkdown,
        words: text.split(/\s+/).filter(Boolean).length,
        h2: article.querySelectorAll('h2').length,
        h3: article.querySelectorAll('h3').length,
        math: article.querySelectorAll('.katex').length,
        codeBlocks: article.querySelectorAll('pre').length,
        tables: article.querySelectorAll('table').length,
        callouts: article.querySelectorAll('.callout').length,
      };
    });
    issues.push(...result.errors.map((e) => `Component failed: ${e}`));
    if (result.pending.length) issues.push(`Components never finished rendering: ${result.pending.join(', ')}`);
    issues.push(...result.katexErrors.map((e) => `KaTeX error: ${e}`));
    if (result.emptyCharts) issues.push(`${result.emptyCharts} chart(s) rendered nothing`);
    if (result.rawMarkdown) warnings.push(`${result.rawMarkdown} spot(s) of raw Markdown syntax visible in the rendered text (e.g. "**" or "#") — usually Markdown inside a JSX prop string or missing blank lines around JSX.`);

    const clipped = await desktop.evaluate(findClipped);
    if (clipped.length) warnings.push(`Content extends beyond the text column on desktop (likely clipped):\n  ${clipped.join('\n  ')}`);

    const shot = path.join(p.checkDir, 'desktop.png');
    await desktop.screenshot({ path: shot, fullPage: true });
    screenshots.push(shot);

    // ---------- Mobile ----------
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    watch(mobile);
    await mobile.goto(url, { waitUntil: 'load' });
    await waitForComponents(mobile);
    const overflow = await mobile.evaluate(() => {
      const w = document.documentElement.clientWidth;
      if (document.documentElement.scrollWidth <= w + 1) return [];
      return [...document.querySelectorAll<HTMLElement>('article *')]
        .filter((el) => el.getBoundingClientRect().right > w + 1 && !el.closest('pre, table, .katex-display, .overflow-x-auto'))
        .slice(0, 5)
        .map((el) => `<${el.tagName.toLowerCase()} class="${el.className}"> ${el.textContent?.trim().slice(0, 60)}`);
    });
    if (overflow.length) warnings.push(`Content overflows horizontally on a 390px-wide phone screen:\n  ${overflow.join('\n  ')}`);
    const mshot = path.join(p.checkDir, 'mobile.png');
    await mobile.screenshot({ path: mshot, fullPage: true });
    screenshots.push(mshot);

    // ---------- Dark theme ----------
    await desktop.click('#theme-toggle');
    await desktop.waitForTimeout(600);
    await waitForComponents(desktop);
    const dshot = path.join(p.checkDir, 'desktop-dark.png');
    await desktop.screenshot({ path: dshot, fullPage: true });
    screenshots.push(dshot);

    const { byType, errors, pending, katexErrors, emptyCharts, rawMarkdown, ...stats } = result;
    for (const [k, v] of Object.entries(byType)) (stats as any)[k] = v;
    if (stats.words < 300) warnings.push(`Only ${stats.words} words — the explainer is probably too short.`);
    if (stats.h2 < 2) warnings.push('Fewer than two "## " sections — add structure.');
    const visuals = (byType['mermaid'] ?? 0) + (byType['chart'] ?? 0) + (byType['function-plot'] ?? 0);
    if (visuals === 0) warnings.push('No diagrams or charts — consider adding at least one visual.');

    return { ok: issues.length === 0, issues: [...new Set(issues)], warnings, stats: stats as Record<string, number>, screenshots };
  } finally {
    await browser.close();
  }
}

/** Elements sticking out of the article column (ignoring things that are meant to scroll or bleed). */
function findClipped(): string[] {
  const article = document.querySelector('article')!;
  const right = article.getBoundingClientRect().right;
  const scrollable = (el: Element) => { const o = getComputedStyle(el).overflowX; return o === 'auto' || o === 'scroll'; };
  const out: string[] = [];
  for (const el of article.querySelectorAll<HTMLElement>('*')) {
    if (out.length >= 5) break;
    if (el.closest('.figure-wide, .katex, svg, .tooltip')) continue;
    const r = el.getBoundingClientRect();
    const spills = el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && !scrollable(el);
    if (r.width === 0 || (r.right <= right + 2 && !spills)) continue;
    let a: Element | null = el.parentElement, inside = false;
    while (a && a !== article) { if (scrollable(a)) { inside = true; break; } a = a.parentElement; }
    if (inside) continue;
    // Only report the outermost offender
    if (!spills && el.parentElement && el.parentElement !== article && el.parentElement.getBoundingClientRect().right > right + 2) continue;
    out.push(`<${el.tagName.toLowerCase()} class="${el.className}"> "${el.textContent?.trim().slice(0, 60)}"`);
  }
  return out;
}

async function waitForComponents(page: Page) {
  await page.waitForFunction(() => !document.querySelector('[data-component][data-state="pending"]'), null, { timeout: 20_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400); // let chart animations settle
}

export function formatReport(r: CheckReport): string {
  const lines = [r.ok ? '✓ Render check passed' : '✗ Render check FAILED'];
  if (r.issues.length) lines.push('', 'Issues (must fix):', ...r.issues.map((i) => `  - ${i}`));
  if (r.warnings.length) lines.push('', 'Warnings (should consider):', ...r.warnings.map((w) => `  - ${w}`));
  lines.push('', `Stats: ${Object.entries(r.stats).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await check(requireTarget(process.argv[2]));
  console.log(process.argv.includes('--json') ? JSON.stringify(r, null, 2) : formatReport(r));
  if (!process.argv.includes('--json')) console.log(`Screenshots: ${r.screenshots.map((s) => path.relative(process.cwd(), s)).join(', ')}`);
  process.exit(r.ok ? 0 : 1);
}
