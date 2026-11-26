// Long explainers (deep / comprehensive): research + outline first, then one fresh-context agent per
// section. Each section writer sees the outline, the glossary, summaries of earlier sections and the end
// of the previous section — enough for continuity without holding the whole document in context.
// Progress is persisted in outline.json + sections/, so an interrupted run resumes where it stopped.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stringify as toYaml } from 'yaml';
import { ROOT } from '../scripts/lib/paths.ts';
import { DEPTHS, type Depth, type Rigor } from './depth.ts';
import type { Tool } from './llm.ts';
import { type AgentContext, runAgent } from './loop.ts';
import { RESEARCH_TOOL_NAMES } from './research/index.ts';
import type { Workspace } from './workspace.ts';

export interface OutlineSection {
  heading: string;
  goal: string;
  key_points: string[];
  visuals: string[];
  quiz: boolean;
  target_words: number;
  sources: string[];
  // progress
  status?: 'pending' | 'done';
  summary?: string;
  terms?: string[];
}

export interface Outline {
  request: string;
  depth: Depth;
  title: string;
  description: string;
  tags: string[];
  level: 'beginner' | 'intermediate' | 'advanced';
  glossary: { term: string; definition: string }[];
  sections: OutlineSection[];
}

const prompt = (name: string) => readFileSync(path.join(ROOT, 'agent/prompts', name), 'utf8');

/** Step 2 of the outline/section prompts, by rigor. */
const POLICY = {
  outline: {
    thorough: 'Research the topic broadly so the structure is right and complete: overview articles, official documentation, standards, textbooks. Collect the most authoritative URLs for each section.',
    quick: 'Plan from your own knowledge of the topic — there is no need to research what you already know. Use the background reading in the task if there is any (its URLs can go into `sources`); look something up only if the topic is recent or niche (small budget). Then save the outline right away.',
  },
  section: {
    thorough: 'List the specific facts you need and **research them before writing** (cross-check important numbers; read the actual pages, using `focus`). Start with the sources listed for your section in the outline.',
    quick: "Write from your own knowledge: well-established facts need no lookup and no cross-checking. Look up only what you can't write confidently (at most one or two lookups, usually none); if you are still unsure, leave the detail out or mark it as approximate. A reviewer reads the whole document afterwards.",
  },
};

const OUTLINE_TOOL: Tool = {
  type: 'function',
  function: {
    name: 'save_outline',
    description: 'Save the outline of the explainer. It is validated; fix the reported problems and call again if needed.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string', description: 'One or two sentences shown under the title' },
        tags: { type: 'array', items: { type: 'string' } },
        level: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
        glossary: { type: 'array', items: { type: 'object', properties: { term: { type: 'string' }, definition: { type: 'string' } }, required: ['term', 'definition'] } },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string' },
              goal: { type: 'string', description: 'What the reader understands after this section' },
              key_points: { type: 'array', items: { type: 'string' } },
              visuals: { type: 'array', items: { type: 'string' } },
              quiz: { type: 'boolean' },
              target_words: { type: 'number' },
              sources: { type: 'array', items: { type: 'string' }, description: 'URLs found during research that the writer should use' },
            },
            required: ['heading', 'goal', 'key_points', 'target_words'],
          },
        },
      },
      required: ['title', 'description', 'sections'],
    },
  },
};

const SECTION_TOOLS: Tool[] = [
  { type: 'function', function: { name: 'write_section', description: 'Write your complete section (replaces any previous version). The whole document is then built and checked.', parameters: { type: 'object', properties: { content: { type: 'string', description: 'MDX of the section only, starting with "## <heading>" (no frontmatter)' } }, required: ['content'] } } },
  { type: 'function', function: { name: 'edit_section', description: 'Exact search/replace edits within your section. Each find must match exactly once.', parameters: { type: 'object', properties: { edits: { type: 'array', items: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' } }, required: ['find', 'replace'] } } }, required: ['edits'] } } },
  { type: 'function', function: { name: 'read_section', description: 'Read your section with line numbers (as they appear in the full document).', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'finish_section', description: 'Finish once the check passes.', parameters: { type: 'object', properties: { summary: { type: 'string', description: '2–3 sentences: what this section covered' }, terms: { type: 'array', items: { type: 'string' }, description: 'New terms/notation introduced' } }, required: ['summary'] } } },
];

export function loadOutline(file: string): Outline | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

const saveOutline = (file: string, o: Outline) => writeFileSync(file, JSON.stringify(o, null, 2) + '\n');
const sectionFile = (ws: Workspace, i: number) => path.join(ws.p.sectionsDir, `${String(i + 1).padStart(2, '0')}.mdx`);

/** Phase 1: research + outline. Returns the saved outline, or null if the agent failed. */
export async function planOutline(ctx: AgentContext, ws: Workspace, request: string, depth: Depth, opts: { rigor: Rigor; background?: string }): Promise<Outline | null> {
  const spec = DEPTHS[depth];
  const quick = opts.rigor === 'quick';
  const q = ctx.cfg.quick;
  let saved: Outline | null = null;
  const research = ws.research;
  if (quick) research.beginRun(q.webSearches, q.researchCalls);
  else research.beginRun(depth === 'comprehensive' ? 35 : 25);
  const run = await runAgent(ctx, {
    name: 'outline',
    system: prompt('outline.md').replace('{{RESEARCH_POLICY}}', () => POLICY.outline[opts.rigor]),
    user: `Plan an explainer for this request:\n\n${request}\n\n` +
      `Depth: **${spec.label}** (about ${spec.minutes} minutes of reading). ${spec.brief}\n` +
      `Plan ${spec.sections[0]}–${spec.sections[1]} sections totalling ${spec.words[0].toLocaleString('en')}–${spec.words[1].toLocaleString('en')} words, with ${spec.visuals} visuals and ${spec.quizzes} quizzes spread across the sections.\n\n` +
      (opts.background ? `${opts.background}\n\n` : '') +
      `Today is ${new Date().toISOString().slice(0, 10)}. ${research.tools().length ? `Research tools${quick ? ` (at most ${q.researchCalls} call(s))` : ''}: ${research.tools().map((t) => t.function.name).join(', ')}.` : 'No research tools are available: plan from well-established knowledge.'}`,
    maxSteps: quick ? q.maxSteps : ctx.cfg.agent.maxSteps,
    researchBudget: 0.6,
    ...(quick && { researchSteps: Math.max(1, Math.min(q.researchCalls, 3)) }),
    tools: () => [...research.tools(), OUTLINE_TOOL],
    outputTools: () => [OUTLINE_TOOL],
    outputNudge: 'Stop researching and call save_outline with the complete outline now.',
    hasOutput: () => saved !== null,
    isDone: () => saved !== null,
    nextHint: () => 'Call save_outline with the complete outline.',
    describeCall: (name, a) => (name === 'save_outline' ? `(${a?.sections?.length ?? 0} sections)` : ''),
    runTool: async (name, raw) => {
      let a: any;
      try { a = JSON.parse(raw || '{}'); } catch (err: any) { return `ERROR: invalid JSON arguments (${err.message}). Make sure the outline is valid JSON.`; }
      if (RESEARCH_TOOL_NAMES.has(name)) return research.run(name, a);
      if (name !== 'save_outline') return `ERROR: unknown tool ${name}`;
      const problems = validateOutline(a, depth);
      if (problems.length) return `ERROR: the outline has problems — fix them and call save_outline again:\n${problems.map((p) => `- ${p}`).join('\n')}`;
      saved = {
        request, depth,
        title: String(a.title), description: String(a.description),
        tags: (a.tags ?? []).map(String).slice(0, 4),
        level: ['beginner', 'intermediate', 'advanced'].includes(a.level) ? a.level : 'intermediate',
        glossary: (a.glossary ?? []).filter((g: any) => g?.term).map((g: any) => ({ term: String(g.term), definition: String(g.definition ?? '') })),
        sections: a.sections.map((s: any) => ({
          heading: String(s.heading).replace(/^#+\s*/, ''), goal: String(s.goal ?? ''),
          key_points: (s.key_points ?? []).map(String), visuals: (s.visuals ?? []).map(String),
          quiz: Boolean(s.quiz), target_words: Math.max(150, Number(s.target_words) || 400),
          sources: (s.sources ?? []).map(String).filter((u: string) => research.isKnown(u)),
          status: 'pending',
        })),
      };
      saveOutline(ws.p.outline, saved);
      return `Outline saved: ${saved.sections.length} sections, ~${saved.sections.reduce((n, s) => n + s.target_words, 0)} words.`;
    },
  });
  if (!run.done) ctx.emit({ type: 'note', level: 'error', text: `outline agent did not finish (${run.reason})` });
  return saved;
}

function validateOutline(a: any, depth: Depth): string[] {
  const spec = DEPTHS[depth];
  const p: string[] = [];
  if (!a.title || !a.description) p.push('title and description are required');
  const sections = Array.isArray(a.sections) ? a.sections : [];
  const [min, max] = spec.sections;
  if (sections.length < min - 1 || sections.length > max + 2) p.push(`${sections.length} sections; plan ${min}–${max}`);
  const total = sections.reduce((n: number, s: any) => n + (Number(s?.target_words) || 0), 0);
  if (total < spec.words[0] * 0.8 || total > spec.words[1] * 1.25) p.push(`target_words add up to ${total}; they should total ${spec.words[0]}–${spec.words[1]}`);
  const seen = new Set<string>();
  sections.forEach((s: any, i: number) => {
    if (!s?.heading) p.push(`section ${i + 1} has no heading`);
    else if (seen.has(String(s.heading).toLowerCase())) p.push(`duplicate heading "${s.heading}"`);
    else seen.add(String(s.heading).toLowerCase());
    if (!Array.isArray(s?.key_points) || s.key_points.length < 2) p.push(`section ${i + 1} ("${s?.heading ?? ''}") needs at least 2 key_points`);
  });
  return p;
}

/** Assemble frontmatter + finished sections (+ the one in progress) into index.mdx. Returns the line range of section `current`. */
function assemble(ws: Workspace, outline: Outline, current?: number): { from: number; to: number } {
  const fm = toYaml({ title: outline.title, description: outline.description, tags: outline.tags, level: outline.level, date: new Date().toISOString().slice(0, 10), model: ws.model }).trim();
  let text = `---\n${fm}\n---\n`;
  let range = { from: 0, to: 0 };
  outline.sections.forEach((s, i) => {
    const f = sectionFile(ws, i);
    if (!existsSync(f) || (s.status !== 'done' && i !== current)) return;
    const body = readFileSync(f, 'utf8').trim();
    const from = text.split('\n').length + 1;
    text += `\n${body}\n`;
    if (i === current) range = { from, to: text.split('\n').length - 1 };
  });
  writeFileSync(ws.p.mdx, text);
  return range;
}

/** Normalise a section: ensure the right heading, and prefix footnote labels so sections can't collide. */
function normalizeSection(content: string, outline: Outline, i: number): string {
  let t = content.replace(/\r\n/g, '\n').trim().replace(/^```(?:mdx|markdown|md)?\n([\s\S]*?)\n```$/, '$1').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  const heading = outline.sections[i].heading;
  if (i === 0) t = t.replace(/^##\s+[^\n]*\n+/, ''); // the introduction has no heading
  else if (!/^##\s/.test(t)) t = `## ${heading}\n\n${t}`;
  const prefix = `s${i + 1}-`;
  return t.replace(/\[\^([^\]\s]+)\]/g, (m, label: string) => (label.startsWith(prefix) ? m : `[^${prefix}${label}]`));
}

/** Phase 2: write every pending section. Returns true if all sections were written with a passing check. */
export async function writeSections(ctx: AgentContext, ws: Workspace, outline: Outline, guide: string, rigor: Rigor): Promise<boolean> {
  mkdirSync(ws.p.sectionsDir, { recursive: true });
  const research = ws.research;
  const quick = rigor === 'quick';
  const q = ctx.cfg.quick;
  const beginRun = (thoroughBudget: number) => (quick ? research.beginRun(q.webSearches, q.researchCalls) : research.beginRun(thoroughBudget));
  const n = outline.sections.length;
  ws.verifyOptions = { requireCitations: false };

  for (let i = 0; i < n; i++) {
    const sec = outline.sections[i];
    if (sec.status === 'done' && existsSync(sectionFile(ws, i))) continue;
    ctx.emit({ type: 'phase', phase: 'section', label: `Section ${i + 1}/${n}: ${sec.heading}` });
    let finished = false;
    ws.passed = false; // a pass from the previous section must not count for this one
    beginRun(12);
    let written = existsSync(sectionFile(ws, i));
    let range = assemble(ws, outline, written ? i : undefined);

    const prev = outline.sections.slice(0, i).filter((s) => s.status === 'done');
    const prevTail = i > 0 && existsSync(sectionFile(ws, i - 1)) ? readFileSync(sectionFile(ws, i - 1), 'utf8').replace(/^\[\^[^\]]+\]:.*$/gm, '').trim().slice(-1500) : '';
    const role = i === 0
      ? 'This is the **introduction**: open with why the topic matters and a concrete motivating question or example, then a `<Callout type="tldr">` summarising the whole explainer (based on the outline). No `##` heading.'
      : i === n - 1
        ? 'This is the **conclusion**: a "Key takeaways" style wrap-up of the whole explainer (based on the outline and the summaries), optionally "Going further" (names of books/papers/tools, no invented URLs), and `<Flashcards>` with the key vocabulary from the glossary.'
        : '';

    const user = [
      `Request for the whole explainer: ${outline.request}`,
      `Explainer: "${outline.title}" — ${outline.description}`,
      `Outline (you write section ${i + 1} of ${n}, marked →):\n${outline.sections.map((s, k) => `${k === i ? '→' : ' '} ${k + 1}. ${s.heading} — ${s.goal}`).join('\n')}`,
      outline.glossary.length ? `Glossary (use these terms and this notation consistently):\n${outline.glossary.map((g) => `- ${g.term}: ${g.definition}`).join('\n')}` : '',
      prev.length ? `Already written (don't repeat; build on it):\n${prev.map((s) => `- ${s.heading}: ${s.summary ?? ''}${s.terms?.length ? ` (terms: ${s.terms.join(', ')})` : ''}`).join('\n')}` : '',
      prevTail ? `End of the previous section (continue smoothly from here):\n"""\n${prevTail}\n"""` : '',
      `YOUR SECTION: ${i + 1}. ${sec.heading}\nGoal: ${sec.goal}\nKey points:\n${sec.key_points.map((k) => `- ${k}`).join('\n')}` +
        (sec.visuals.length ? `\nPlanned visuals:\n${sec.visuals.map((v) => `- ${v}`).join('\n')}` : '') +
        `\nQuiz at the end: ${sec.quiz ? 'yes' : 'optional'}\nTarget length: about ${sec.target_words} words.` +
        (sec.sources.length ? `\nSources found during planning:\n${sec.sources.map((u) => `- ${u}`).join('\n')}` : ''),
      role,
      !research.tools().length ? 'No research tools are available: rely on well-established knowledge only; only cite URLs listed above.'
        : quick ? `Optional lookups (at most ${q.researchCalls} call(s), only for what you can't write confidently): ${research.tools().map((t) => t.function.name).join(', ')}.`
          : `Research tools: ${research.tools().map((t) => t.function.name).join(', ')}. Verify specific facts before writing.`,
    ].filter(Boolean).join('\n\n');

    const runTool = async (name: string, raw: string): Promise<string> => {
      let a: any;
      try { a = JSON.parse(raw || '{}'); } catch (err: any) { return `ERROR: invalid JSON arguments (${err.message}). Escape quotes, backslashes and newlines in long strings.`; }
      if (RESEARCH_TOOL_NAMES.has(name)) return research.run(name, a);
      if (name === 'write_section') {
        if (typeof a.content !== 'string' || !a.content.trim()) return 'ERROR: content must be the MDX of your section.';
        writeFileSync(sectionFile(ws, i), normalizeSection(a.content, outline, i) + '\n');
        written = true;
        return withRange(await verifySection());
      }
      if (name === 'edit_section') {
        if (!written) return 'ERROR: write the section first with write_section.';
        let text = readFileSync(sectionFile(ws, i), 'utf8');
        if (!Array.isArray(a.edits) || !a.edits.length) return 'ERROR: edits must be a non-empty array of { find, replace }.';
        for (const [k, e] of a.edits.entries()) {
          const count = typeof e?.find === 'string' && e.find ? text.split(e.find).length - 1 : 0;
          if (count !== 1) return `ERROR: edit #${k + 1}: "find" ${count === 0 ? 'was not found in your section' : `matches ${count} times`} — it must match exactly once. No edits applied. Use read_section to copy the exact text.`;
          text = text.replace(e.find, () => String(e.replace ?? ''));
        }
        writeFileSync(sectionFile(ws, i), normalizeSection(text, outline, i) + '\n');
        return withRange(await verifySection());
      }
      if (name === 'read_section') {
        if (!written) return 'ERROR: nothing written yet — call write_section.';
        range = assemble(ws, outline, i);
        return ws.readNumbered(range.from, range.to);
      }
      if (name === 'finish_section') {
        if (!ws.passed) return 'ERROR: the latest check did not pass — fix the issues first.';
        sec.status = 'done';
        sec.summary = String(a.summary ?? '');
        sec.terms = Array.isArray(a.terms) ? a.terms.map(String) : [];
        saveOutline(ws.p.outline, outline);
        finished = true;
        return 'OK — section complete.';
      }
      return `ERROR: unknown tool ${name}`;
    };
    const verifySection = async () => {
      range = assemble(ws, outline, i);
      return ws.verify();
    };
    const withRange = (report: string) => `${report}\n\n(Your section is lines ${range.from}–${range.to} of the assembled document; errors elsewhere are unlikely to be yours.)`;

    // Up to two attempts per section; the second (fresh) agent starts from the first one's draft.
    let run: Awaited<ReturnType<typeof runAgent>> | null = null;
    for (let attempt = 1; attempt <= 2 && !finished; attempt++) {
    if (attempt > 1) {
      ctx.emit({ type: 'note', level: 'warn', text: `section ${i + 1}: retrying with a fresh agent` });
      beginRun(8);
    }
    const retryNote = attempt > 1 && written
      ? `\n\nNOTE: a previous attempt at this section did not finish. Its draft is saved: read it with read_section, then fix the problems the check reports (or rewrite the section with write_section if that is simpler), and call finish_section.`
      : '';
    run = await runAgent(ctx, {
      name: `section ${i + 1}/${n}${attempt > 1 ? ' (retry)' : ''}`,
      system: prompt('section.md').replace('{{RESEARCH_POLICY}}', () => POLICY.section[rigor]).replace('{{AUTHORING_GUIDE}}', () => guide),
      user: user + retryNote,
      maxSteps: quick ? q.maxSteps : ctx.cfg.agent.maxSteps,
      ...(quick && { researchSteps: Math.max(1, Math.min(q.researchCalls, 3)) }),
      tools: () => [...research.tools(), ...SECTION_TOOLS.filter((t) => written || !['edit_section', 'read_section'].includes(t.function.name))],
      outputTools: () => SECTION_TOOLS.filter((t) => t.function.name === 'write_section'),
      outputNudge: quick ? 'Write your section NOW with write_section, from what you know.' : 'Stop researching and write your section NOW with write_section, using what you verified.',
      hasOutput: () => written,
      isDone: () => finished,
      nextHint: () => (!written ? 'Call write_section with your complete section.' : ws.passed ? 'Call finish_section.' : 'Fix the reported issues with edit_section.'),
      onText: async (content) => {
        const m = /```(?:mdx|markdown|md)?\n([\s\S]*?)\n```/.exec(content);
        if (!m || m[1].length < 300) return null;
        ctx.emit({ type: 'note', level: 'warn', text: 'model pasted the section as text — saving it via write_section' });
        return `Your message contained the section, so it was saved for you. Next time call the tools directly.\n\n${await runTool('write_section', JSON.stringify({ content: m[1] }))}`;
      },
      supersedes: 'write_section',
      compactAfter: ['write_section', 'edit_section'],
      describeCall: (name, a) => (name === 'write_section' ? `(${((a?.content?.length ?? 0) / 1024).toFixed(1)} KB)` : name === 'edit_section' ? `(${a?.edits?.length ?? 0} edit(s))` : ''),
      runTool,
    });
    }
    if (!finished) {
      ctx.emit({ type: 'note', level: 'error', text: `section ${i + 1} did not finish (${run?.reason})` });
      assemble(ws, outline);
      return false;
    }
  }
  assemble(ws, outline);
  return true;
}
