// Usage: node scripts/rebuild.ts --all | <slug…> [--no-check]
// Re-renders explainers from their MDX (no LLM involved), e.g. after a design or component update,
// and refreshes meta.json. Failures are reported but don't stop the batch.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { build } from './build.ts';
import { check } from './check.ts';
import { writeMeta } from './lib/meta.ts';
import { EXPLAINERS_DIR, type ExplainerPaths, resolveTarget } from './lib/paths.ts';

export interface RebuildOutcome { slug: string; ok: boolean; error?: string }

export async function rebuild(p: ExplainerPaths, opts: { check?: boolean } = {}): Promise<RebuildOutcome> {
  const b = await build(p);
  if (!b.ok) {
    writeMeta(p, { status: 'failed', statusDetail: `Build failed: ${b.error.split('\n').slice(0, 3).join(' ')}` });
    return { slug: p.slug, ok: false, error: b.error };
  }
  if (opts.check === false) {
    writeMeta(p, {});
    return { slug: p.slug, ok: true };
  }
  const r = await check(p);
  writeMeta(p, {
    status: r.ok ? 'ready' : 'needs-attention',
    statusDetail: r.ok ? undefined : r.issues.slice(0, 3).join(' · ').slice(0, 500),
    words: r.stats.words,
  });
  return { slug: p.slug, ok: r.ok, error: r.ok ? undefined : r.issues.join('\n') };
}

export function allExplainers(): ExplainerPaths[] {
  if (!existsSync(EXPLAINERS_DIR)) return [];
  return readdirSync(EXPLAINERS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(EXPLAINERS_DIR, d.name, 'index.mdx')))
    .map((d) => resolveTarget(path.join(EXPLAINERS_DIR, d.name)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const targets = args.includes('--all') ? allExplainers() : args.filter((a) => !a.startsWith('--')).map(resolveTarget);
  if (targets.length === 0) {
    console.error('Usage: npm run rebuild -- --all | <slug…> [--no-check]');
    process.exit(2);
  }
  let failed = 0;
  for (const [i, p] of targets.entries()) {
    process.stdout.write(`[${i + 1}/${targets.length}] ${p.slug} … `);
    const t = Date.now();
    const r = await rebuild(p, { check: !args.includes('--no-check') });
    if (!r.ok) failed++;
    console.log(r.ok ? `✓ ${((Date.now() - t) / 1000).toFixed(1)}s` : `✗\n${r.error!.split('\n').map((l) => `    ${l}`).join('\n')}`);
  }
  console.log(`\n${targets.length - failed}/${targets.length} rebuilt successfully.`);
  process.exit(failed ? 1 : 0);
}
