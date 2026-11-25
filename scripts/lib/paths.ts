import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const EXPLAINERS_DIR = path.join(ROOT, 'explainers');

export const paths = (slug: string) => {
  const dir = path.join(EXPLAINERS_DIR, slug);
  return {
    dir,
    mdx: path.join(dir, 'index.mdx'),
    html: path.join(dir, `${slug}.html`),
    checkDir: path.join(dir, '.check'),
    log: path.join(dir, 'agent-log.jsonl'),
    sources: path.join(dir, 'sources.json'),
    buildDir: path.join(ROOT, '.build', slug),
  };
};

export function requireSlug(arg: string | undefined): string {
  if (!arg) {
    console.error('Usage: <command> <slug>   (the folder name inside explainers/)');
    process.exit(2);
  }
  const slug = path.basename(arg.replace(/\/index\.mdx$/, '').replace(/\/$/, ''));
  if (!existsSync(paths(slug).mdx)) {
    console.error(`No explainer found at ${path.relative(ROOT, paths(slug).mdx)}`);
    process.exit(2);
  }
  return slug;
}

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
