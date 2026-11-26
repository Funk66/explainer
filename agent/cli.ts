// Command-line front end for the explainer pipeline.
//   npm run explain -- "explain X and its applicability to Y" [--depth deep] [--thorough]
//   npm run explain -- --revise <slug> "make the intro shorter and add a chart about Z"
//   npm run explain -- --fact-check <slug>
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { paths } from '../scripts/lib/paths.ts';
import { CONFIG_PATH, loadConfig } from './config.ts';
import { DEPTH_NAMES, DEPTHS, type Depth, RIGOR_NAMES, type Rigor } from './depth.ts';
import { AgentAborted } from './loop.ts';
import { generate, recheck, revise, type PipelineResult } from './pipeline.ts';
import { terminalRenderer } from './terminal.ts';
import * as ui from './ui.ts';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    depth: { type: 'string', short: 'd' },
    rigor: { type: 'string' },
    thorough: { type: 'boolean', default: false },
    slug: { type: 'string' },
    revise: { type: 'string' },
    'fact-check': { type: 'string' },
    'no-fact-check': { type: 'boolean', default: false },
    model: { type: 'string' },
    effort: { type: 'string' },
    'max-steps': { type: 'string' },
    'no-open': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const request = positionals.join(' ').trim();
const recheckSlug = opts['fact-check'];
if (opts.help || (!request && !recheckSlug)) {
  console.log(`Usage:
  npm run explain -- "explain X and its applicability to Y" [--depth <depth>] [--thorough]
  npm run explain -- --revise <slug> "what to change"
  npm run explain -- --fact-check <slug>     (thorough claim-by-claim check; --rigor quick for a single review)

Depths:
${DEPTH_NAMES.map((d) => `  ${d.padEnd(14)} ~${DEPTHS[d].minutes} min read, ${DEPTHS[d].words[0]}–${DEPTHS[d].words[1]} words${DEPTHS[d].mode === 'sections' ? ' (outline + section by section)' : ''}`).join('\n')}

Options:
  -d, --depth <depth>  How detailed (default: agent.defaultDepth in explainer.config.json)
  --rigor <rigor>      quick: write from knowledge + one review pass (few model turns)
                       thorough: research first + claim-by-claim fact-check (much slower)
                       (default: agent.defaultRigor)
  --thorough           Same as --rigor thorough
  --slug <slug>        Output folder name (default: derived from the prompt). Re-using the slug of an
                       interrupted deep/comprehensive run with the same prompt resumes it.
  --no-fact-check      Skip the review / fact-check pass
  --model <id>         Override llm.model
  --effort <level>     Override llm.reasoningEffort (none | low | medium | high)
  --max-steps <n>      Override agent.maxSteps (per agent)
  --no-open            Don't open the result in the browser`);
  process.exit(opts.help ? 0 : 1);
}

const cfg = loadConfig();
if (opts.model) cfg.llm.model = opts.model;
if (opts.effort) cfg.llm.reasoningEffort = opts.effort as any;
if (opts['max-steps']) cfg.agent.maxSteps = Number(opts['max-steps']);
if (opts['no-open']) cfg.output.openInBrowser = false;
if (!cfg.llm.model) fail(`No model configured. Set "llm.model" in ${path.relative(process.cwd(), CONFIG_PATH)} or pass --model.`);
if (opts.depth && !DEPTH_NAMES.includes(opts.depth as Depth)) fail(`--depth must be one of: ${DEPTH_NAMES.join(', ')}`);
if (opts.rigor && !RIGOR_NAMES.includes(opts.rigor as Rigor)) fail(`--rigor must be one of: ${RIGOR_NAMES.join(', ')}`);
const rigor = (opts.thorough ? 'thorough' : opts.rigor) as Rigor | undefined;

const emit = terminalRenderer({ showReasoning: cfg.agent.showReasoning });
const controller = new AbortController();
process.on('SIGINT', () => {
  if (controller.signal.aborted) process.exit(130);
  ui.line(ui.yellow('\n  cancelling… (Ctrl-C again to quit immediately)'));
  controller.abort();
});
const rc = { cfg, emit, signal: controller.signal };
const started = Date.now();

let result: PipelineResult;
try {
  if (recheckSlug) result = await recheck(recheckSlug, rc, { rigor });
  else if (opts.revise) result = await revise(opts.revise, request, rc, { factCheck: false, rigor });
  else result = await generate({ prompt: request, slug: opts.slug, depth: opts.depth as Depth | undefined, rigor, factCheck: opts['no-fact-check'] ? false : undefined }, rc);
} catch (err: any) {
  if (err instanceof AgentAborted) fail('Cancelled. A deep/comprehensive run can be resumed with the same --slug and prompt.');
  if (err?.name === 'IncompleteRun') fail(`${err.message}. To resume, run the same command again with --slug <slug shown above> and the same prompt and depth.`);
  fail(err?.message ?? String(err));
}

const p = paths(result.slug);
const minutes = ((Date.now() - started) / 60000).toFixed(1);
ui.line('');
ui.line(result.ok ? ui.green(ui.bold(`✓ Done in ${minutes} min`)) : ui.yellow(ui.bold(`⚠ Finished in ${minutes} min with status "${result.meta.status}": ${result.meta.statusDetail ?? ''}`)));
ui.line(`  ${result.summary}`);
if (result.meta.summary) ui.line(ui.dim(`  ${result.meta.summary}`));
ui.line(`  MDX:  ${path.relative(process.cwd(), p.mdx)}`);
if (existsSync(p.html)) ui.line(`  HTML: ${path.relative(process.cwd(), p.html)}`);
if (existsSync(p.factcheck)) ui.line(`  Fact-check report: ${path.relative(process.cwd(), p.factcheck)}`);
if (!result.ok) ui.line(ui.dim(`  Continue with: npm run explain -- --revise ${result.slug} "fix the remaining issues"`));
if (cfg.output.openInBrowser && existsSync(p.html)) openInBrowser(p.html);
process.exit(result.ok ? 0 : 1);

function openInBrowser(file: string) {
  const [cmd, ...args] = process.platform === 'darwin' ? ['open', file] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', file] : ['xdg-open', file];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

function fail(msg: string): never {
  ui.line(ui.red(`\n✗ ${msg}`));
  process.exit(1);
}
