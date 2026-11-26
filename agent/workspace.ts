// The explainer file and the tools to write it. Every write/edit is immediately built and checked in
// a real browser, so the model always gets concrete feedback (build errors with line numbers, render
// issues, citation problems, stats).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from '../scripts/build.ts';
import { check, formatReport } from '../scripts/check.ts';
import type { ExplainerPaths } from '../scripts/lib/paths.ts';
import type { Emit } from './events.ts';
import type { Tool } from './llm.ts';
import { citedUrls, Research, RESEARCH_TOOL_NAMES } from './research/index.ts';

export const AUTHOR_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'write_explainer',
      description: 'Write the complete MDX explainer (frontmatter + body), replacing the current file. It is then built and checked automatically; the build/check report is returned.',
      parameters: {
        type: 'object',
        properties: { content: { type: 'string', description: 'The full MDX file content, starting with the --- frontmatter.' } },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_explainer',
      description: 'Apply one or more exact search/replace edits to the current MDX file. Each `find` must match exactly once (copy it verbatim, including whitespace). The file is then rebuilt and checked; the report is returned.',
      parameters: {
        type: 'object',
        properties: {
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                find: { type: 'string', description: 'Exact text currently in the file' },
                replace: { type: 'string', description: 'Replacement text' },
              },
              required: ['find', 'replace'],
            },
          },
        },
        required: ['edits'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_explainer',
      description: 'Read the current MDX file with line numbers.',
      parameters: { type: 'object', properties: { from_line: { type: 'number' }, to_line: { type: 'number' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Finish once the latest build succeeded and the check reported no issues.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string', description: '1–3 sentence summary of the explainer' } },
        required: ['summary'],
      },
    },
  },
];

export interface VerifyOptions {
  /** Require at least one footnote citation when research is available (off while long-form sections are still being written). */
  requireCitations?: boolean;
  /** Target word range for the requested depth (a warning is given when far off). */
  targetWords?: [number, number];
}

export class Workspace {
  readonly p: ExplainerPaths;
  model: string;
  research: Research;
  emit: Emit;
  passed = false;
  finished = false;
  summary = '';
  /** Stats of the last successful render check (words, visuals, citations, …). */
  lastStats: Record<string, number> = {};
  verifyOptions: VerifyOptions = { requireCitations: true };
  /** Finish automatically as soon as a check passes (saves the model a turn; used by quick writers). */
  autoFinish = false;

  constructor(p: ExplainerPaths, model: string, research: Research, emit: Emit) {
    this.p = p;
    this.model = model;
    this.research = research;
    this.emit = emit;
    mkdirSync(this.p.dir, { recursive: true });
    research.attachLedger(this.p.sources);
  }

  get slug() { return this.p.slug; }

  /** Tools offered in the current state: reading/editing only once a file exists. Research tools first. */
  get tools(): Tool[] {
    const authoring = AUTHOR_TOOLS.filter((t) => this.exists || !['read_explainer', 'edit_explainer'].includes(t.function.name));
    return [...this.research.tools(), ...authoring];
  }

  /** Only the write tool: used to push a stuck model into writing. */
  get writeOnlyTools(): Tool[] { return AUTHOR_TOOLS.filter((t) => t.function.name === 'write_explainer'); }

  get exists() { return existsSync(this.p.mdx); }
  get htmlPath() { return this.p.html; }
  get mdxPath() { return this.p.mdx; }
  read() { return readFileSync(this.p.mdx, 'utf8'); }

  async run(name: string, rawArgs: string): Promise<string> {
    let args: any;
    try {
      args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch (err: any) {
      return `ERROR: could not parse the tool arguments as JSON (${err.message}). If the content is very long, make sure quotes, backslashes and newlines are escaped correctly in the JSON string.`;
    }
    if (RESEARCH_TOOL_NAMES.has(name)) return this.research.run(name, args);
    switch (name) {
      case 'write_explainer': return this.write(args.content);
      case 'edit_explainer': return this.edit(args.edits);
      case 'read_explainer': return this.readNumbered(args.from_line, args.to_line);
      case 'finish': return this.finish(args.summary);
      default: return `ERROR: unknown tool "${name}". Available: ${this.tools.map((t) => t.function.name).join(', ')}`;
    }
  }

  async write(content: unknown): Promise<string> {
    if (typeof content !== 'string' || !content.trim()) return 'ERROR: `content` must be the full MDX text.';
    const normalized = normalize(content, this.model);
    if (normalized.error) return `ERROR: ${normalized.error}`;
    writeFileSync(this.p.mdx, normalized.text);
    this.emit({ type: 'note', level: 'info', text: `saved index.mdx (${normalized.text.split('\n').length} lines)` });
    return this.verify();
  }

  async edit(edits: unknown): Promise<string> {
    if (!this.exists) return 'ERROR: there is no file yet. Your next call must be write_explainer with the complete MDX.';
    if (!Array.isArray(edits) || edits.length === 0) return 'ERROR: `edits` must be a non-empty array of { find, replace }.';
    let text = this.read();
    for (const [i, e] of edits.entries()) {
      if (typeof e?.find !== 'string' || typeof e?.replace !== 'string') return `ERROR: edit #${i + 1} must have string "find" and "replace". No edits were applied.`;
      const count = e.find ? text.split(e.find).length - 1 : 0;
      if (count !== 1) {
        return `ERROR: edit #${i + 1}: "find" text ${count === 0 ? 'was not found' : `matches ${count} times`} — it must match exactly once. No edits were applied. Use read_explainer to copy the exact current text.`;
      }
      text = text.replace(e.find, () => e.replace);
    }
    const normalized = normalize(text, this.model);
    if (normalized.error) return `ERROR: ${normalized.error} No edits were applied.`;
    writeFileSync(this.p.mdx, normalized.text);
    this.emit({ type: 'note', level: 'info', text: `applied ${edits.length} edit(s)` });
    return this.verify();
  }

  readNumbered(from?: number, to?: number): string {
    if (!this.exists) return 'ERROR: there is no file yet, so there is nothing to read. Your next call must be write_explainer with the complete MDX.';
    const lines = this.read().split('\n');
    const a = Math.max(1, from ?? 1);
    const b = Math.min(lines.length, to ?? lines.length);
    return lines.slice(a - 1, b).map((l, i) => `${String(a + i).padStart(4)} | ${l}`).join('\n');
  }

  finish(summary: string): string {
    if (!this.passed) return 'ERROR: cannot finish yet — the latest build/check did not pass. Fix the reported issues first.';
    this.finished = true;
    this.summary = summary ?? '';
    return 'OK — explainer complete.';
  }

  async verify(): Promise<string> {
    this.passed = false;
    this.emit({ type: 'status', text: 'building…' });
    const b = await build(this.p);
    if (!b.ok) {
      this.emit({ type: 'build', ok: false, issues: 1, warnings: 0, detail: 'build failed' });
      return `BUILD FAILED — fix this and try again (line numbers refer to the MDX file, including frontmatter):\n\n${b.error}`;
    }
    this.emit({ type: 'status', text: 'checking render in headless browser…' });
    const r = await check(this.p);

    // Citations: every URL in the text must have come up during research (prevents invented URLs).
    const mdx = this.read();
    const unknown = citedUrls(mdx).filter((u) => !this.research.isKnown(u));
    if (unknown.length) {
      r.ok = false;
      r.issues.push(`These URLs never appeared in your research results (possibly invented or mistyped). Remove them, or find and fetch the real source and cite the exact URL:\n${unknown.map((u) => `      ${u}`).join('\n')}`);
    }
    const body = mdx.replace(/```[\s\S]*?```/g, '');
    const defs = new Set([...body.matchAll(/^\[\^([^\]]+)\]:/gm)].map((m) => m[1]));
    const refs = new Set([...body.matchAll(/\[\^([^\]]+)\](?!:)/g)].map((m) => m[1]));
    const undefinedRefs = [...refs].filter((x) => !defs.has(x));
    const unusedDefs = [...defs].filter((x) => !refs.has(x));
    if (undefinedRefs.length) { r.ok = false; r.issues.push(`Footnote markers without a definition (they render as raw text): ${undefinedRefs.map((x) => `[^${x}]`).join(', ')}`); }
    if (unusedDefs.length) r.warnings.push(`Footnote definitions never referenced in the text (they are dropped): ${unusedDefs.map((x) => `[^${x}]`).join(', ')}`);
    const footnotes = defs.size;
    r.stats.citations = footnotes;
    if (this.research.enabled && footnotes === 0 && this.verifyOptions.requireCitations !== false) {
      r.ok = false;
      r.issues.push('No sources cited. Add footnote citations ([^label] after the claim, definitions at the end of the file) for the key facts and figures, using URLs from your research.');
    }
    const t = this.verifyOptions.targetWords;
    if (t && r.stats.words) {
      if (r.stats.words < t[0] * 0.8) r.warnings.push(`Too short for the requested depth: ${r.stats.words} words, target ${t[0]}–${t[1]}. Add depth (mechanisms, examples, misconceptions), not filler.`);
      else if (r.stats.words > t[1] * 1.3) r.warnings.push(`Longer than the requested depth: ${r.stats.words} words, target ${t[0]}–${t[1]}. Consider tightening.`);
    }
    this.passed = r.ok;
    if (r.ok) this.lastStats = r.stats;
    this.emit({ type: 'build', ok: r.ok, issues: r.issues.length, warnings: r.warnings.length, detail: r.ok ? undefined : `render check: ${r.issues.length} issue(s)` });
    if (r.ok && this.autoFinish) {
      this.finished = true;
      return `BUILD OK.\n${formatReport(r)}\n\nThe check passed — the explainer is complete.`;
    }
    return `BUILD OK.\n${formatReport(r)}\n\n${r.ok ? (r.warnings.length ? 'Consider the warnings; fix them if reasonable, then call finish.' : 'Everything passed. Call finish (or improve the content first if needed).') : 'Fix every issue, then the file will be checked again.'}`;
  }
}

/** Light clean-up of common model mistakes + automatic metadata. */
export function normalize(input: string, model: string): { text: string; error?: string } {
  let text = input.replace(/\r\n/g, '\n').trim();
  // Unwrap ```mdx … ``` if the whole file was fenced
  const fenced = /^```(?:mdx|markdown|md)?\n([\s\S]*?)\n```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!fm) return { text, error: 'the file must start with YAML frontmatter between --- lines (title, description, …).' };
  let front = fm[1];
  if (!/^title:/m.test(front)) return { text, error: 'frontmatter is missing `title:`.' };
  if (!/^description:/m.test(front)) return { text, error: 'frontmatter is missing `description:`.' };
  if (!/^date:/m.test(front)) front += `\ndate: ${new Date().toISOString().slice(0, 10)}`;
  if (!/^model:/m.test(front) && model) front += `\nmodel: ${JSON.stringify(model)}`;
  // The title is rendered from frontmatter; drop a duplicated leading "# Title".
  const body = text.slice(fm[0].length).replace(/^\s*# [^\n]+\n/, '');
  return { text: `---\n${front}\n---\n\n${body.trim()}\n` };
}
