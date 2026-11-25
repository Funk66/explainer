// meta.json: everything the index/UI needs about an explainer without parsing MDX or HTML.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { ExplainerPaths } from './paths.ts';

export type Depth = 'overview' | 'standard' | 'deep' | 'comprehensive';
export type ExplainerStatus = 'draft' | 'ready' | 'needs-attention' | 'failed';

export interface ExplainerMeta {
  slug: string;
  title: string;
  description: string;
  tags: string[];
  level?: string;
  depth?: Depth;
  prompt?: string;
  model?: string;
  status: ExplainerStatus;
  /** Why the status is not "ready" (build error, unresolved fact-check problems, …). */
  statusDetail?: string;
  words?: number;
  readingMinutes?: number;
  htmlBytes?: number;
  citations?: number;
  factCheck?: { checkedAt: string; model: string; claimsChecked: number; problems: number; fixed: boolean };
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export function readFrontmatter(mdx: string): Record<string, any> {
  const m = /^---\n([\s\S]*?)\n---/.exec(mdx);
  if (!m) return {};
  try { return parseYaml(m[1]) ?? {}; } catch { return {}; }
}

export function readMeta(p: ExplainerPaths): ExplainerMeta | null {
  if (!existsSync(p.meta)) return null;
  try { return JSON.parse(readFileSync(p.meta, 'utf8')); } catch { return null; }
}

/** Merge `patch` into meta.json, refreshing title/description/tags/level/model from the MDX frontmatter. */
export function writeMeta(p: ExplainerPaths, patch: Partial<ExplainerMeta> = {}): ExplainerMeta {
  const prev = readMeta(p);
  const fm = existsSync(p.mdx) ? readFrontmatter(readFileSync(p.mdx, 'utf8')) : {};
  const now = new Date().toISOString();
  const meta: ExplainerMeta = {
    status: 'ready',
    createdAt: prev?.createdAt ?? (existsSync(p.mdx) ? statSync(p.mdx).birthtime.toISOString() : now),
    ...prev,
    ...patch,
    slug: p.slug,
    title: String(fm.title ?? patch.title ?? prev?.title ?? p.slug),
    description: String(fm.description ?? patch.description ?? prev?.description ?? ''),
    tags: Array.isArray(fm.tags) ? fm.tags.map(String) : prev?.tags ?? [],
    level: fm.level ?? prev?.level,
    model: patch.model ?? (fm.model ? String(fm.model) : prev?.model),
    updatedAt: now,
  };
  if (existsSync(p.html)) meta.htmlBytes = statSync(p.html).size;
  if (meta.words) meta.readingMinutes = Math.max(1, Math.round(meta.words / 220));
  writeFileSync(p.meta, JSON.stringify(meta, null, 2) + '\n');
  return meta;
}
