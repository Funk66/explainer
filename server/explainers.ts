// Reading the explainer library from the data directory.
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { type ExplainerMeta, readMeta, writeMeta } from '../scripts/lib/meta.ts';
import { EXPLAINERS_DIR, paths } from '../scripts/lib/paths.ts';

export function listExplainers(): ExplainerMeta[] {
  if (!existsSync(EXPLAINERS_DIR)) return [];
  const out: ExplainerMeta[] = [];
  for (const d of readdirSync(EXPLAINERS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = paths(d.name);
    let meta = readMeta(p);
    if (!meta && existsSync(p.mdx)) meta = writeMeta(p, { status: existsSync(p.html) ? 'ready' : 'needs-attention' }); // created before meta.json existed
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function explainerDetail(slug: string) {
  const p = paths(slug);
  const meta = readMeta(p);
  if (!meta) return null;
  const read = (f: string) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
  const sources = (read(p.sources) ?? []) as { url: string; title: string; status: string }[];
  return {
    meta,
    hasHtml: existsSync(p.html),
    factCheck: read(p.factcheck),
    outline: read(p.outline),
    sources: sources.filter((s) => s.status === 'fetched'),
    sourcesSeen: sources.length,
  };
}

export function deleteExplainer(slug: string): boolean {
  const p = paths(slug);
  if (path.dirname(p.dir) !== EXPLAINERS_DIR || !existsSync(p.dir)) return false; // never outside the data dir
  rmSync(p.dir, { recursive: true, force: true });
  rmSync(p.buildDir, { recursive: true, force: true });
  return true;
}

export const validSlug = (s: string) => /^[a-z0-9][a-z0-9-]{0,80}$/.test(s);
