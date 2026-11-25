// Usage:
//   npm run explain -- "explain X and its applicability to Y"
//   npm run explain -- --revise <slug> "make the intro shorter and add a chart about Z"
// Options: --slug <slug>  --model <id>  --effort <none|low|medium|high>  --max-steps <n>  --no-open
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { paths, ROOT } from '../scripts/lib/paths.ts';
import { CONFIG_PATH, loadConfig } from './config.ts';
import { complete, createClient, type Message } from './llm.ts';
import { Research, RESEARCH_TOOL_NAMES } from './research/index.ts';
import { Workspace } from './tools.ts';
import * as ui from './ui.ts';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    slug: { type: 'string' },
    revise: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    'max-steps': { type: 'string' },
    'no-open': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const request = positionals.join(' ').trim();
if (opts.help || !request) {
  console.log(`Usage:
  npm run explain -- "explain X and its applicability to Y"
  npm run explain -- --revise <slug> "what to change"

Options:
  --slug <slug>        Output folder name (default: derived from the prompt)
  --model <id>         Override llm.model from explainer.config.json
  --effort <level>     Override llm.reasoningEffort (none | low | medium | high)
  --max-steps <n>      Override agent.maxSteps
  --no-open            Don't open the result in the browser`);
  process.exit(opts.help ? 0 : 1);
}

const cfg = loadConfig();
if (opts.model) cfg.llm.model = opts.model;
if (opts.effort) cfg.llm.reasoningEffort = opts.effort as any;
if (opts['max-steps']) cfg.agent.maxSteps = Number(opts['max-steps']);
if (opts['no-open']) cfg.output.openInBrowser = false;
if (!cfg.llm.model) fail(`No model configured. Set "llm.model" in ${path.relative(process.cwd(), CONFIG_PATH)} or pass --model.`);

// ---------- Target ----------
const revising = Boolean(opts.revise);
const slug = revising ? opts.revise! : opts.slug ?? uniqueSlug(slugify(request));
let research: Research;
try {
  research = new Research(cfg.research);
} catch (err: any) {
  fail(err.message);
}
const ws = new Workspace(slug, cfg.llm.model, research);
if (revising && !ws.exists) fail(`No explainer to revise at ${path.relative(process.cwd(), ws.mdxPath)}`);
const logFile = paths(slug).log;
if (!revising) rmSync(logFile, { force: true });

// ---------- Prompt ----------
const guide = readFileSync(path.join(ROOT, 'agent/prompts/authoring-guide.md'), 'utf8').trim();
const system = readFileSync(path.join(ROOT, 'agent/prompts/system.md'), 'utf8').replace('{{AUTHORING_GUIDE}}', () => guide);
const researchNote = research.enabled
  ? `Research tools available: ${research.tools().map((t) => t.function.name).join(', ')}.`
  : 'No research tools are available in this run: rely on well-established knowledge only, omit anything you are unsure about, and do not include URLs.';
const user = revising
  ? `Revise the existing explainer according to this request:\n\n${request}\n\nCurrent file (explainers/${slug}/index.mdx):\n\n${ws.readNumbered()}\n\n${research.sources.length ? `Sources already collected for this explainer (citable): \n${research.sources.filter((x) => x.status === 'fetched').map((x) => `- ${x.title}: ${x.url}`).join('\n')}\n\n` : ''}Research any new facts before adding them. Prefer edit_explainer for targeted changes; use write_explainer only for a substantial rewrite.\n\n${researchNote}`
  : `${request}\n\n(Today is ${new Date().toISOString().slice(0, 10)}. The explainer will be saved as explainers/${slug}/index.mdx.)\n\n${researchNote}`;
const messages: Message[] = [
  { role: 'system', content: system },
  { role: 'user', content: user },
];
messages.forEach(log);

// ---------- Loop ----------
ui.line(ui.bold(`\n📘 ${revising ? 'Revising' : 'Writing'} explainer → explainers/${slug}/`));
ui.line(ui.dim(`   model ${cfg.llm.model} @ ${cfg.llm.baseUrl}${cfg.llm.reasoningEffort ? ` · reasoning ${cfg.llm.reasoningEffort}` : ''}`));
ui.line(ui.dim(`   research: ${research.providers.length ? `web search via ${research.searchLabel}` : 'no web search'}${cfg.research.wikipedia ? ' + Wikipedia' : ''}${research.enabled ? ' + fetch_page' : ''}`));

const client = createClient(cfg);
const started = Date.now();
let idleTurns = 0;
// Loop guards for weaker models: repeated identical calls, or researching forever without writing.
let lastSignature = '';
let repeats = 0;
let forceWrite = false;
const researchBudget = Math.max(8, Math.floor(cfg.agent.maxSteps * 0.5));

for (let step = 1; step <= cfg.agent.maxSteps && !ws.finished; step++) {
  ui.line(ui.magenta(`\n── step ${step}/${cfg.agent.maxSteps} ${'─'.repeat(40)}`));
  let res;
  try {
    if (!ws.exists && step > researchBudget && !forceWrite) {
      forceWrite = true;
      const m: Message = { role: 'user', content: `You have used ${step - 1} of ${cfg.agent.maxSteps} steps without writing the file. Research is over: write the complete explainer NOW with write_explainer, using what you have verified so far (leave out anything you could not verify).` };
      messages.push(m);
      log(m);
      ui.line(ui.yellow('  (research budget reached — asking the model to write now)'));
    }
    const tools = forceWrite && !ws.exists ? ws.writeOnlyTools : ws.tools;
    res = await complete(client, cfg, messages, tools, forceWrite && !ws.exists ? 'required' : 'auto');
  } catch (err: any) {
    fail(`LLM request failed: ${err?.message ?? err}\nIs the server running at ${cfg.llm.baseUrl} and is "${cfg.llm.model}" available?`);
  }
  if (res.usage) ui.line(ui.dim(`   tokens: ${res.usage.prompt_tokens} in / ${res.usage.completion_tokens} out`));

  const assistant: Message = {
    role: 'assistant',
    content: res.content || null,
    ...(res.toolCalls.length && { tool_calls: res.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } })) }),
  };
  messages.push(assistant);
  log({ ...assistant, reasoning: res.reasoning } as any);

  if (res.toolCalls.length === 0) {
    // Fallback: the model pasted the MDX as text instead of calling the tool.
    const pasted = /```(?:mdx|markdown|md)\n(---\n[\s\S]*?)\n```/.exec(res.content)?.[1] ?? (/^---\ntitle:/.test(res.content.trim()) ? res.content : null);
    let note: string;
    if (pasted) {
      ui.line(ui.yellow('  (model pasted the MDX as text — saving it via write_explainer)'));
      note = `Your message contained the MDX, so it was saved for you. Next time call the tools directly.\n\n${await ws.write(pasted)}`;
    } else if (res.finishReason === 'length') {
      note = 'Your response was cut off (token limit). Continue, using the tools. If you were writing the file, write it with write_explainer — keep it within the limit.';
    } else {
      if (++idleTurns >= 3) break;
      note = ws.passed
        ? 'The explainer passes all checks. Call finish with a short summary, or keep improving it with the tools.'
        : 'Please continue by calling the tools (write_explainer / edit_explainer). Do not reply with plain text.';
    }
    const m: Message = { role: 'user', content: note };
    messages.push(m);
    log(m);
    continue;
  }
  idleTurns = 0;

  // Repetition guard: the same call with the same arguments again and again means the model is stuck.
  const signature = res.toolCalls.map((c) => `${c.name}:${c.arguments}`).join('|');
  repeats = signature === lastSignature ? repeats + 1 : 0;
  lastSignature = signature;
  if (repeats >= 4) fail(`The model is stuck repeating the same tool call (${res.toolCalls[0].name}). Try a different model or a lower temperature; the transcript is in ${path.relative(process.cwd(), logFile)}.`);

  for (const call of res.toolCalls) {
    ui.line(ui.cyan(`  → ${call.name}`) + ui.dim(` ${describeArgs(call.name, call.arguments)}`));
    const result = await ws.run(call.name, call.arguments);
    if (RESEARCH_TOOL_NAMES.has(call.name)) ui.line(indent(result.startsWith('ERROR') ? ui.red(result) : ui.dim(summarizeResearch(result)), 6));
    else if (call.name !== 'read_explainer') ui.line(indent(result.startsWith('ERROR') ? ui.red(result) : ui.dim(result)));
    const m: Message = { role: 'tool', tool_call_id: call.id, content: result };
    messages.push(m);
    log(m);
    if ((call.name === 'write_explainer' || call.name === 'edit_explainer') && !result.startsWith('ERROR')) compactHistory(call.id);
    if (ws.finished) break;
  }
  if (ws.exists) forceWrite = false;
  if (repeats >= 2) {
    const next = !ws.exists ? 'Call write_explainer with the complete MDX now.' : ws.passed ? 'Call finish now.' : 'Fix the reported issues with edit_explainer.';
    const m: Message = { role: 'user', content: `You have made exactly the same tool call ${repeats + 1} times in a row and got the same result. Do something different. ${next}` };
    messages.push(m);
    log(m);
    if (!ws.exists) forceWrite = true;
    ui.line(ui.yellow('  (repeated identical calls — nudging the model)'));
  }
}

// ---------- Result ----------
const minutes = ((Date.now() - started) / 60000).toFixed(1);
ui.line('');
const sourcesNote = research.enabled ? ` · ${research.stats.searches} searches, ${research.stats.fetches} pages read, ${research.sources.filter((x) => x.status === 'fetched').length} sources in ledger` : '';
if (ws.finished || ws.passed) {
  ui.line(ui.green(ui.bold(`✓ Explainer ready in ${minutes} min`)) + ui.dim(sourcesNote));
  if (ws.summary) ui.line(`  ${ws.summary}`);
} else if (existsSync(ws.htmlPath)) {
  ui.line(ui.yellow(ui.bold(`⚠ Stopped after ${minutes} min without a passing check — the last successful build is shown.`)));
  ui.line(ui.dim(`  Continue with: npm run explain -- --revise ${slug} "fix the remaining issues"`));
} else {
  fail(`No successful build after ${minutes} min. See ${path.relative(process.cwd(), logFile)} for the transcript.`);
}
ui.line(`  MDX:  ${path.relative(process.cwd(), ws.mdxPath)}`);
ui.line(`  HTML: ${path.relative(process.cwd(), ws.htmlPath)}`);
if (cfg.output.openInBrowser && existsSync(ws.htmlPath)) openInBrowser(ws.htmlPath);

// ---------- Helpers ----------
function slugify(s: string): string {
  const stop = new Set('a an the of to and or in on for with about is are be how what why when which who explain explainer describe tell me please write its it this that into using use detailed detail'.split(' '));
  const words = s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w && !stop.has(w));
  return words.slice(0, 6).join('-').slice(0, 60).replace(/-+$/, '') || 'explainer';
}

function uniqueSlug(base: string): string {
  let s = base;
  for (let i = 2; existsSync(paths(s).dir); i++) s = `${base}-${i}`;
  return s;
}

/** Keep the context small once a draft exists:
 *  - older full-file writes are superseded by the file itself;
 *  - research results have been used; the sources stay in the ledger and pages are cached, so re-fetching is cheap. */
function compactHistory(keepId: string) {
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    for (const c of m.tool_calls as any[]) {
      names.set(c.id, c.function?.name);
      if (c.function?.name === 'write_explainer' && c.id !== keepId && !c.function.arguments.includes('"[superseded')) {
        c.function.arguments = JSON.stringify({ content: '[superseded by a later version — use read_explainer to see the current file]' });
      }
    }
  }
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    const name = names.get(m.tool_call_id);
    if (name && RESEARCH_TOOL_NAMES.has(name) && typeof m.content === 'string' && !m.content.startsWith('[research result')) {
      const head = m.content.split('\n').slice(0, 2).join(' | ');
      m.content = `[research result already used in the draft — ${head.slice(0, 200)}. Call the tool again if you need the details.]`;
    }
  }
}

function summarizeResearch(result: string): string {
  const lines = result.split('\n');
  if (result.startsWith('SOURCE:')) return `${lines[0]} · ${lines[2] ?? ''}`;
  const urls = lines.filter((l) => /^\d+\. /.test(l)).slice(0, 5).map((l) => l.replace(/^\d+\. /, '• ').slice(0, 110));
  return [lines[0], ...urls].join('\n');
}

function describeArgs(name: string, raw: string): string {
  try {
    const a = JSON.parse(raw);
    if (name === 'web_search' || name === 'search_wikipedia') return `"${a.query}"`;
    if (name === 'fetch_page') return `${a.url}${a.offset ? ` @${a.offset}` : ''}`;
    if (name === 'write_explainer') return `(${(a.content?.length / 1024).toFixed(1)} KB)`;
    if (name === 'edit_explainer') return `(${a.edits?.length ?? 0} edit(s))`;
    if (name === 'finish') return '';
  } catch { /* reported by the tool */ }
  return '';
}

function indent(s: string, max = 40) {
  const lines = s.split('\n');
  const shown = lines.slice(0, max).map((l) => `    ${l}`).join('\n');
  return lines.length > max ? `${shown}\n    … (${lines.length - max} more lines)` : shown;
}

function log(m: unknown) {
  try { appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), ...(m as object) }) + '\n'); } catch { /* folder may not exist yet */ }
}

function openInBrowser(file: string) {
  const [cmd, ...args] = process.platform === 'darwin' ? ['open', file] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', file] : ['xdg-open', file];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

function fail(msg: string): never {
  ui.line(ui.red(`\n✗ ${msg}`));
  process.exit(1);
}
