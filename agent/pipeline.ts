// The explainer workflows, independent of how they are triggered (CLI or job queue):
//   generate:  [single]   writer (write → fix; research first only with thorough rigor)
//              [sections] outline → section writers → final check
//              then review (quick) or fact-check (thorough) → fixer → meta.json
//   revise:    writer with the existing file and an instruction
//   recheck:   fact-check (or review) → fixer on an existing explainer
//
// Rigor: "quick" (default) writes from the model's knowledge with a few optional lookups and one review
// pass — a handful of model turns. "thorough" researches first and fact-checks claim by claim.
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { type ExplainerMeta, readMeta, writeMeta } from '../scripts/lib/meta.ts';
import { DATA_DIR, type ExplainerPaths, paths, ROOT } from '../scripts/lib/paths.ts';
import type { Config } from './config.ts';
import { DEPTHS, depthBrief, type Depth, type Rigor } from './depth.ts';
import type { Emit } from './events.ts';
import { type CheckRange, factCheck, type FactCheckReport, type FixOptions, fixFindings, review, saveReport } from './factcheck.ts';
import { createClient } from './llm.ts';
import { loadOutline, planOutline, writeSections } from './longform.ts';
import { type AgentContext, runAgent } from './loop.ts';
import { Research } from './research/index.ts';
import { Workspace } from './workspace.ts';

export interface RunContext { cfg: Config; emit: Emit; signal?: AbortSignal }

/** A run that stopped part-way and can be resumed by running it again (long-form explainers). */
export class IncompleteRun extends Error {
  constructor(message: string) { super(message); this.name = 'IncompleteRun'; }
}

export interface GenerateRequest {
  prompt: string;
  /** Folder name; derived from the prompt when omitted. An existing unfinished long-form run with this slug is resumed. */
  slug?: string;
  depth?: Depth;
  /** quick | thorough (default: agent.defaultRigor). */
  rigor?: Rigor;
  /** Review/fact-check after writing (default: factCheck.enabled). */
  factCheck?: boolean;
}

export interface PipelineResult { slug: string; ok: boolean; meta: ExplainerMeta; summary: string }

const prompt = (name: string) => readFileSync(path.join(ROOT, 'agent/prompts', name), 'utf8');
export const authoringGuide = () => prompt('authoring-guide.md').trim();

function setup(rc: RunContext, p: ExplainerPaths, opts: { model?: string; rigor?: Rigor } = {}) {
  const model = opts.model ?? rc.cfg.llm.model;
  const effort = opts.rigor === 'quick' && rc.cfg.quick.reasoningEffort ? rc.cfg.quick.reasoningEffort : rc.cfg.llm.reasoningEffort;
  const cfg = model === rc.cfg.llm.model && effort === rc.cfg.llm.reasoningEffort ? rc.cfg : { ...rc.cfg, llm: { ...rc.cfg.llm, model, reasoningEffort: effort } };
  const log = (entry: object) => {
    try { appendFileSync(p.log, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n'); } catch { /* folder may not exist yet */ }
  };
  const ctx: AgentContext = { client: createClient(cfg), cfg, emit: rc.emit, log, signal: rc.signal };
  return ctx;
}

/** Research with the shared search cache and the explainer-wide limit on paid searches. */
function newResearch(cfg: Config, depth: Depth): Research {
  const research = new Research(cfg.research);
  research.attachCache(path.join(DATA_DIR, 'search-cache.json'));
  research.setJobLimit(cfg.research.searchLimits[depth]);
  return research;
}

function researchNote(research: Research, rigor: Rigor, cfg: Config) {
  if (rigor === 'quick') {
    const tools = research.tools().map((t) => t.function.name);
    return tools.length && cfg.quick.researchCalls > 0
      ? `Research policy: write from your knowledge. Optional lookups for things you can't write confidently: at most ${cfg.quick.researchCalls} call(s) with ${tools.join(', ')}.`
      : 'Research policy: write from your knowledge; no research tools in this run. Omit details you are unsure about; only cite URLs from the background reading (if any).';
  }
  return research.enabled
    ? `Research tools available: ${research.tools().map((t) => t.function.name).join(', ')}.`
    : 'No research tools are available in this run: rely on well-established knowledge only, omit anything you are unsure about, and do not include URLs.';
}

/** Limits for quick-rigor fixer agents. */
const quickFix = (cfg: Config): FixOptions => ({ maxSteps: cfg.quick.maxSteps, webSearches: cfg.quick.webSearches, researchCalls: cfg.quick.researchCalls });

/** Background reading for quick runs (no model turns): top Wikipedia passages for the request. */
async function backgroundReading(rc: RunContext, research: Research, request: string): Promise<string> {
  if (!rc.cfg.quick.reference) return '';
  rc.emit({ type: 'status', text: 'fetching background reading…' });
  const ref = await research.reference(request);
  const titles = [...ref.matchAll(/^SOURCE: (.*)$/gm)].map((m) => m[1]);
  if (titles.length) rc.emit({ type: 'note', level: 'info', text: `background reading: ${titles.join(', ')}` });
  return ref ? `Background reading (excerpts from Wikipedia; use what is relevant, ignore the rest; these URLs may be cited):\n\n${ref}` : '';
}

// ---------------------------------------------------------------------------------------------

export async function generate(req: GenerateRequest, rc: RunContext): Promise<PipelineResult> {
  const { cfg, emit } = rc;
  const depth = req.depth ?? cfg.agent.defaultDepth;
  const rigor = req.rigor ?? cfg.agent.defaultRigor;
  const quick = rigor === 'quick';
  const spec = DEPTHS[depth];
  const slug = req.slug ?? uniqueSlug(slugify(req.prompt));
  const p = paths(slug);
  const resuming = spec.mode === 'sections' && loadOutline(p.outline)?.request === req.prompt;
  if (!resuming) for (const f of [p.log, p.outline, p.sectionsDir, p.factcheck]) rmSync(f, { recursive: true, force: true });

  const research = newResearch(cfg, depth);
  const ws = new Workspace(p, cfg.llm.model, research, emit);
  const ctx = setup(rc, p, { rigor });
  writeMeta(p, { status: 'draft', statusDetail: 'generating', prompt: req.prompt, depth, rigor, model: cfg.llm.model, title: req.prompt });
  emit({ type: 'phase', phase: 'start', label: `${resuming ? 'Resuming' : 'Writing'} "${req.prompt}" → ${slug} (${spec.label}, ~${spec.minutes} min read, ${rigor})` });
  emit({ type: 'note', level: 'info', text: `model ${cfg.llm.model} · research: ${research.providers.length ? `web search via ${research.searchLabel}` : 'no web search'}${cfg.research.wikipedia ? ' + Wikipedia' : ''}${quick ? ` · quick: ≤${cfg.quick.researchCalls} lookups per agent` : ''}` });

  const guide = authoringGuide();
  let written = false;

  if (spec.mode === 'single') {
    emit({ type: 'phase', phase: 'write', label: quick ? 'Write' : 'Research and write' });
    ws.verifyOptions = { requireCitations: !quick, targetWords: spec.words };
    const background = quick ? await backgroundReading(rc, research, req.prompt) : '';
    written = await runWriter(ctx, ws, {
      user: `${req.prompt}\n\n${depthBrief(depth)}\n\n(Today is ${new Date().toISOString().slice(0, 10)}.)\n\n${background ? `${background}\n\n` : ''}${researchNote(research, rigor, cfg)}`,
      searchBudget: depth === 'overview' ? 15 : 30,
      rigor,
    });
  } else {
    let outline = resuming ? loadOutline(p.outline) : null;
    if (!outline) {
      emit({ type: 'phase', phase: 'outline', label: quick ? 'Outline' : 'Research and outline' });
      const background = quick ? await backgroundReading(rc, research, req.prompt) : '';
      outline = await planOutline(ctx, ws, req.prompt, depth, { rigor, background });
    } else {
      emit({ type: 'note', level: 'info', text: `resuming: ${outline.sections.filter((s) => s.status === 'done').length}/${outline.sections.length} sections already written` });
    }
    if (!outline) throw new IncompleteRun('the outline could not be created');
    {
      const ok = await writeSections(ctx, ws, outline, guide, rigor);
      if (!ok) {
        const done = outline.sections.filter((s) => s.status === 'done').length;
        writeMeta(p, { status: 'draft', statusDetail: `${done}/${outline.sections.length} sections written; will resume` });
        // Thrown so the job queue retries later; the retry resumes from the unfinished section.
        throw new IncompleteRun(`long-form writing stopped after ${done}/${outline.sections.length} sections; it resumes from there when retried`);
      }
      if (ok) {
        emit({ type: 'phase', phase: 'final-check', label: 'Check the complete document' });
        ws.verifyOptions = { requireCitations: !quick, targetWords: spec.words };
        const report = await ws.verify();
        written = ws.passed || (await fixFindings(ctx, ws, [], guide, `The complete document does not pass the check yet:\n\n${report}`, quick ? quickFix(cfg) : undefined));
      }
    }
  }

  if (!written) {
    const meta = writeMeta(p, { status: existsSync(p.html) ? 'needs-attention' : 'failed', statusDetail: 'writing did not complete with a passing check' });
    emit({ type: 'done', ok: false, summary: meta.statusDetail! });
    return { slug, ok: false, meta, summary: meta.statusDetail! };
  }
  return finalize(rc, ws, ctx, { factCheck: req.factCheck ?? cfg.factCheck.enabled, depth, rigor, summary: ws.summary });
}

export async function revise(slug: string, instruction: string, rc: RunContext, opts: { factCheck?: boolean; rigor?: Rigor } = {}): Promise<PipelineResult> {
  const p = paths(slug);
  if (!existsSync(p.mdx)) throw new Error(`No explainer "${slug}"`);
  const rigor = opts.rigor ?? rc.cfg.agent.defaultRigor;
  const research = newResearch(rc.cfg, 'standard');
  const ws = new Workspace(p, rc.cfg.llm.model, research, rc.emit);
  ws.verifyOptions = { requireCitations: rigor === 'thorough' };
  const ctx = setup(rc, p, { rigor });
  writeMeta(p, { status: 'draft', statusDetail: 'revising' });
  rc.emit({ type: 'phase', phase: 'revise', label: `Revising ${slug}: ${instruction}` });
  const cited = research.sources.filter((x) => x.status === 'fetched').map((x) => `- ${x.title}: ${x.url}`).join('\n');
  const ok = await runWriter(ctx, ws, {
    user: `Revise the existing explainer according to this request:\n\n${instruction}\n\nCurrent file (index.mdx):\n\n${ws.readNumbered()}\n\n` +
      (cited ? `Sources already collected for this explainer (citable):\n${cited}\n\n` : '') +
      `${rigor === 'thorough' ? 'Research any new facts before adding them. ' : ''}Prefer edit_explainer for targeted changes; use write_explainer only for a substantial rewrite.${rigor === 'quick' ? ' Call finish when the check passes.' : ''}\n\n${researchNote(research, rigor, rc.cfg)}`,
    rigor,
    // A revision may take several edits, so the model decides when it is done.
    autoFinish: false,
  });
  if (!ok) {
    const meta = writeMeta(p, { status: 'needs-attention', statusDetail: 'revision did not complete with a passing check' });
    rc.emit({ type: 'done', ok: false, summary: meta.statusDetail! });
    return { slug, ok: false, meta, summary: meta.statusDetail! };
  }
  return finalize(rc, ws, ctx, { factCheck: opts.factCheck ?? false, rigor, summary: ws.summary });
}

/**
 * Check (and fix) an existing explainer. Defaults to the thorough claim-by-claim fact-check: this is the
 * way to spend more effort on an explainer that was written quickly.
 */
export async function recheck(slug: string, rc: RunContext, opts: { rigor?: Rigor } = {}): Promise<PipelineResult> {
  const p = paths(slug);
  if (!existsSync(p.mdx)) throw new Error(`No explainer "${slug}"`);
  const rigor = opts.rigor ?? 'thorough';
  const depth = (readMeta(p)?.depth ?? 'standard') as Depth;
  const research = newResearch(rc.cfg, depth);
  const ws = new Workspace(p, rc.cfg.llm.model, research, rc.emit);
  // Explainers written quickly may have no citations; that's not something a re-check should fail on.
  ws.verifyOptions = { requireCitations: false };
  const ctx = setup(rc, p, { rigor });
  await ws.verify(); // establishes the starting state (and stats)
  return finalize(rc, ws, ctx, { factCheck: true, depth, rigor, summary: '' });
}

// ---------------------------------------------------------------------------------------------

async function runWriter(ctx: AgentContext, ws: Workspace, opts: { user: string; searchBudget?: number; rigor: Rigor; autoFinish?: boolean }): Promise<boolean> {
  const quick = opts.rigor === 'quick';
  const q = ctx.cfg.quick;
  ws.finished = false;
  ws.autoFinish = quick && opts.autoFinish !== false;
  if (quick) ws.research.beginRun(q.webSearches, q.researchCalls);
  else ws.research.beginRun(opts.searchBudget ?? 30);
  const run = await runAgent(ctx, {
    name: 'writer',
    system: prompt(quick ? 'writer-quick.md' : 'writer.md').replace('{{AUTHORING_GUIDE}}', () => authoringGuide()),
    user: opts.user,
    maxSteps: quick ? q.maxSteps : ctx.cfg.agent.maxSteps,
    ...(quick && { researchSteps: Math.max(1, Math.min(q.researchCalls, 3)) }),
    tools: () => ws.tools,
    outputTools: () => ws.writeOnlyTools,
    outputNudge: quick
      ? 'Write the complete explainer NOW with write_explainer, from what you know (leave out details you are unsure of).'
      : 'Research is over: write the complete explainer NOW with write_explainer, using what you have verified so far (leave out anything you could not verify).',
    hasOutput: () => ws.exists,
    isDone: () => ws.finished,
    nextHint: () => (!ws.exists ? 'Call write_explainer with the complete MDX now.' : ws.passed ? 'Call finish now.' : 'Fix the reported issues with edit_explainer.'),
    onText: async (content) => {
      const pasted = /```(?:mdx|markdown|md)\n(---\n[\s\S]*?)\n```/.exec(content)?.[1] ?? (/^---\ntitle:/.test(content.trim()) ? content : null);
      if (!pasted) return null;
      ctx.emit({ type: 'note', level: 'warn', text: 'model pasted the MDX as text — saving it via write_explainer' });
      return `Your message contained the MDX, so it was saved for you. Next time call the tools directly.\n\n${await ws.write(pasted)}`;
    },
    supersedes: 'write_explainer',
    compactAfter: ['write_explainer', 'edit_explainer'],
    describeCall: (name, a) => (name === 'write_explainer' ? `(${((a?.content?.length ?? 0) / 1024).toFixed(1)} KB)` : name === 'edit_explainer' ? `(${a?.edits?.length ?? 0} edit(s))` : ''),
    runTool: (name, raw) => ws.run(name, raw),
  });
  ws.autoFinish = false;
  return (run.done || ws.passed) && ws.passed;
}

async function finalize(rc: RunContext, ws: Workspace, ctx: AgentContext, opts: { factCheck: boolean; depth?: Depth; rigor: Rigor; summary: string }): Promise<PipelineResult> {
  const { cfg, emit } = rc;
  const p = ws.p;
  let report: FactCheckReport | undefined;

  if (opts.factCheck) {
    const quick = opts.rigor === 'quick';
    emit({ type: 'phase', phase: 'fact-check', label: quick ? 'Review' : 'Fact-check' });
    const model = cfg.factCheck.model || cfg.llm.model;
    const fcCtx = model === cfg.llm.model ? ctx : setup(rc, p, { model, rigor: opts.rigor });
    const depth = opts.depth ?? 'standard';
    if (quick) {
      // One read-through of the whole document; only very long documents are split into a few parts.
      const ranges = checkRanges(ws.read(), (ws.lastStats.words ?? 0) > 6000, 5000);
      report = await review(fcCtx, ws, { ranges, model, maxSteps: cfg.quick.maxSteps, researchCalls: Math.min(2, cfg.quick.researchCalls), webSearches: Math.min(1, cfg.quick.webSearches) });
    } else {
      const ranges = checkRanges(ws.read(), DEPTHS[depth].mode === 'sections');
      report = await factCheck(fcCtx, ws, { ranges, claimsPerRange: DEPTHS[depth].factCheckClaims, model });
    }
    saveReport(p.factcheck, report);
    if (report.findings.length) {
      emit({ type: 'phase', phase: 'fix', label: `Fix ${report.findings.length} ${quick ? 'review' : 'fact-check'} finding(s)` });
      if (!ws.passed) await ws.verify();
      report.fixed = await fixFindings(ctx, ws, report.findings, authoringGuide(), '', quick ? quickFix(cfg) : undefined);
      saveReport(p.factcheck, report);
    } else {
      report.fixed = true;
      saveReport(p.factcheck, report);
    }
  }

  const stats = ws.lastStats;
  const unresolved = report && report.findings.length > 0 && !report.fixed;
  const status = !ws.passed ? 'needs-attention' : unresolved ? 'needs-attention' : 'ready';
  const meta = writeMeta(p, {
    status,
    statusDetail: !ws.passed ? 'the last check did not pass' : unresolved ? `${report!.findings.length} ${report!.mode === 'review' ? 'review' : 'fact-check'} finding(s) not fully resolved` : undefined,
    words: stats.words,
    citations: stats.citations,
    summary: opts.summary || undefined,
    ...(opts.depth && { depth: opts.depth }),
    ...(report && { factCheck: { checkedAt: report.checkedAt, model: report.model, mode: report.mode, claimsChecked: report.claimsChecked, problems: report.findings.length, fixed: report.fixed } }),
  });
  const checked = report ? (report.mode === 'review' ? `, review: ${report.findings.length} problem(s)` : `, fact-check ${report.claimsChecked} claims / ${report.findings.length} problem(s)`) : '';
  const summary = `${meta.title}: ${meta.words ?? '?'} words, ${meta.citations ?? 0} citations${checked}${report?.findings.length ? (report.fixed ? ' (fixed)' : ' (unresolved)') : ''}`;
  emit({ type: 'done', ok: status === 'ready', summary });
  return { slug: p.slug, ok: status === 'ready', meta, summary };
}

/** Ranges for the fact-checker: the whole body, or one per `##` section for long documents. */
export function checkRanges(mdx: string, perSection: boolean, partWords = 1200): CheckRange[] {
  const lines = mdx.split('\n');
  const bodyStart = (/^---\n[\s\S]*?\n---\n/.exec(mdx)?.[0].split('\n').length ?? 1);
  const end = lines.length;
  if (!perSection) return [{ label: 'the whole explainer', from: bodyStart, to: end }];
  const starts = lines.map((l, i) => (/^## /.test(l) ? i + 1 : 0)).filter(Boolean);
  const bounds = [bodyStart, ...starts.filter((s) => s > bodyStart)];
  const sections = bounds.map((from, k) => ({
    label: k === 0 ? 'Introduction' : lines[from - 1].replace(/^##\s*/, ''),
    from,
    to: (bounds[k + 1] ?? end + 1) - 1,
  })).filter((r) => r.to - r.from > 2);
  // Group consecutive sections into parts of ~1,200 words: fewer fact-check agents (and searches).
  const words = (r: CheckRange) => lines.slice(r.from - 1, r.to).join(' ').split(/\s+/).length;
  const parts: CheckRange[] = [];
  for (const sec of sections) {
    const last = parts[parts.length - 1];
    if (last && words(last) < partWords) parts[parts.length - 1] = { label: `${last.label} … ${sec.label}`, from: last.from, to: sec.to };
    else parts.push({ ...sec });
  }
  return parts;
}

export function slugify(s: string): string {
  const stop = new Set('a an the of to and or in on for with about is are be how what why when which who explain explainer describe tell me please write its it this that into using use detailed detail'.split(' '));
  const words = s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w && !stop.has(w));
  return words.slice(0, 6).join('-').slice(0, 60).replace(/-+$/, '') || 'explainer';
}

export function uniqueSlug(base: string): string {
  let s = base;
  for (let i = 2; existsSync(paths(s).dir); i++) s = `${base}-${i}`;
  return s;
}
