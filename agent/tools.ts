// Tools exposed to the model. Every write/edit is immediately built and checked in a real browser,
// so the model always gets concrete feedback (build errors with line numbers, render issues, stats).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from '../scripts/build.ts';
import { check, formatReport } from '../scripts/check.ts';
import { paths } from '../scripts/lib/paths.ts';
import type { Tool } from './llm.ts';
import * as ui from './ui.ts';

export const TOOLS: Tool[] = [
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

export class Workspace {
  slug: string;
  model: string;
  passed = false;
  finished = false;
  summary = '';
  private p: ReturnType<typeof paths>;

  constructor(slug: string, model: string) {
    this.slug = slug;
    this.model = model;
    this.p = paths(slug);
    mkdirSync(this.p.dir, { recursive: true });
  }

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
    switch (name) {
      case 'write_explainer': return this.write(args.content);
      case 'edit_explainer': return this.edit(args.edits);
      case 'read_explainer': return this.readNumbered(args.from_line, args.to_line);
      case 'finish': return this.finish(args.summary);
      default: return `ERROR: unknown tool "${name}". Available: ${TOOLS.map((t) => t.function.name).join(', ')}`;
    }
  }

  async write(content: unknown): Promise<string> {
    if (typeof content !== 'string' || !content.trim()) return 'ERROR: `content` must be the full MDX text.';
    const normalized = normalize(content, this.model);
    if (normalized.error) return `ERROR: ${normalized.error}`;
    writeFileSync(this.p.mdx, normalized.text);
    ui.line(ui.dim(`  saved ${this.p.mdx.replace(process.cwd() + '/', '')} (${normalized.text.split('\n').length} lines)`));
    return this.verify();
  }

  async edit(edits: unknown): Promise<string> {
    if (!this.exists) return 'ERROR: there is no file yet — use write_explainer first.';
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
    ui.line(ui.dim(`  applied ${edits.length} edit(s)`));
    return this.verify();
  }

  readNumbered(from?: number, to?: number): string {
    if (!this.exists) return 'ERROR: there is no file yet — use write_explainer first.';
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
    ui.status(ui.dim('  building…'));
    const b = await build(this.slug);
    if (!b.ok) {
      ui.clearStatus();
      ui.line(ui.red('  ✗ build failed'));
      return `BUILD FAILED — fix this and try again (line numbers refer to the MDX file, including frontmatter):\n\n${b.error}`;
    }
    ui.status(ui.dim('  checking render in headless browser…'));
    const r = await check(this.slug);
    ui.clearStatus();
    this.passed = r.ok;
    ui.line(r.ok ? ui.green(`  ✓ build + render check passed`) + ui.dim(` (${r.warnings.length} warning(s))`) : ui.red(`  ✗ render check: ${r.issues.length} issue(s)`));
    return `BUILD OK.\n${formatReport(r)}\n\n${r.ok ? (r.warnings.length ? 'Consider the warnings; fix them if reasonable, then call finish.' : 'Everything passed. Call finish (or improve the content first if needed).') : 'Fix every issue, then the file will be checked again.'}`;
  }
}

/** Light clean-up of common model mistakes + automatic metadata. */
function normalize(input: string, model: string): { text: string; error?: string } {
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
