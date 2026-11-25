import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** All generated content lives here (a mounted volume in the container). Override with EXPLAINER_DATA_DIR. */
export const DATA_DIR = path.resolve(process.env.EXPLAINER_DATA_DIR ?? path.join(ROOT, 'data'));
export const EXPLAINERS_DIR = path.join(DATA_DIR, 'explainers');
/** Test fixtures shipped with the code (e.g. the component showcase). */
export const FIXTURES_DIR = path.join(ROOT, 'fixtures');

export type ExplainerPaths = ReturnType<typeof explainerPaths>;

/** File layout of one explainer folder (anywhere on disk). */
export function explainerPaths(dir: string) {
  dir = path.resolve(dir);
  const slug = path.basename(dir);
  return {
    dir,
    slug,
    mdx: path.join(dir, 'index.mdx'),            // source of truth
    html: path.join(dir, 'index.html'),          // built standalone page
    meta: path.join(dir, 'meta.json'),           // metadata for the index (title, tags, depth, status…)
    sources: path.join(dir, 'sources.json'),     // research ledger
    factcheck: path.join(dir, 'factcheck.json'), // last fact-check report
    outline: path.join(dir, 'outline.json'),     // long-form plan (deep/comprehensive)
    sectionsDir: path.join(dir, 'sections'),     // long-form section drafts
    log: path.join(dir, 'agent-log.jsonl'),      // full agent transcript
    checkDir: path.join(dir, '.check'),          // screenshots of the last render check
    buildDir: path.join(ROOT, '.build', slug),   // scratch space for astro build
  };
}

/** Paths of the explainer `slug` in the data directory. */
export const paths = (slug: string) => explainerPaths(path.join(EXPLAINERS_DIR, slug));

/** Accepts a slug (data dir, then fixtures), a folder path or a path to index.mdx; exits with a message if missing. */
export function requireTarget(arg: string | undefined): ExplainerPaths {
  if (!arg) {
    console.error('Usage: <command> <slug | path/to/explainer-folder>');
    process.exit(2);
  }
  const p = resolveTarget(arg);
  if (!existsSync(p.mdx)) {
    console.error(`No explainer found at ${path.relative(process.cwd(), p.mdx)}`);
    process.exit(2);
  }
  return p;
}

export function resolveTarget(arg: string): ExplainerPaths {
  const cleaned = arg.replace(/\/index\.mdx$/, '').replace(/\/$/, '');
  if (cleaned.includes('/') || cleaned.startsWith('.')) return explainerPaths(cleaned);
  if (existsSync(path.join(EXPLAINERS_DIR, cleaned))) return paths(cleaned);
  if (existsSync(path.join(FIXTURES_DIR, cleaned))) return explainerPaths(path.join(FIXTURES_DIR, cleaned));
  return paths(cleaned);
}

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
