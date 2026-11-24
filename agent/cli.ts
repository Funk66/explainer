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
import { TOOLS, Workspace } from './tools.ts';
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
const ws = new Workspace(slug, cfg.llm.model);
if (revising && !ws.exists) fail(`No explainer to revise at ${path.relative(process.cwd(), ws.mdxPath)}`);
const logFile = paths(slug).log;
if (!revising) rmSync(logFile, { force: true });

// ---------- Prompt ----------
const agentsMd = readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8').split(/\n## For agents maintaining this repository/)[0].trim();
const system = readFileSync(path.join(ROOT, 'agent/system-prompt.md'), 'utf8').replace('{{AGENTS_MD}}', () => agentsMd);
const user = revising
  ? `Revise the existing explainer according to this request:\n\n${request}\n\nCurrent file (explainers/${slug}/index.mdx):\n\n${ws.readNumbered()}\n\nPrefer edit_explainer for targeted changes; use write_explainer only for a substantial rewrite.`
  : `${request}\n\n(Today is ${new Date().toISOString().slice(0, 10)}. The explainer will be saved as explainers/${slug}/index.mdx.)`;
const messages: Message[] = [
  { role: 'system', content: system },
  { role: 'user', content: user },
];
messages.forEach(log);

// ---------- Loop ----------
ui.line(ui.bold(`\n📘 ${revising ? 'Revising' : 'Writing'} explainer → explainers/${slug}/`));
ui.line(ui.dim(`   model ${cfg.llm.model} @ ${cfg.llm.baseUrl}${cfg.llm.reasoningEffort ? ` · reasoning ${cfg.llm.reasoningEffort}` : ''}`));

const client = createClient(cfg);
const started = Date.now();
let idleTurns = 0;

for (let step = 1; step <= cfg.agent.maxSteps && !ws.finished; step++) {
  ui.line(ui.magenta(`\n── step ${step}/${cfg.agent.maxSteps} ${'─'.repeat(40)}`));
  let res;
  try {
    res = await complete(client, cfg, messages, TOOLS);
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

  for (const call of res.toolCalls) {
    ui.line(ui.cyan(`  → ${call.name}`) + ui.dim(` ${describeArgs(call.name, call.arguments)}`));
    const result = await ws.run(call.name, call.arguments);
    if (call.name !== 'read_explainer') ui.line(indent(result.startsWith('ERROR') ? ui.red(result) : ui.dim(result)));
    const m: Message = { role: 'tool', tool_call_id: call.id, content: result };
    messages.push(m);
    log(m);
    if (call.name === 'write_explainer' && !result.startsWith('ERROR')) compactHistory(call.id);
    if (ws.finished) break;
  }
}

// ---------- Result ----------
const minutes = ((Date.now() - started) / 60000).toFixed(1);
ui.line('');
if (ws.finished || ws.passed) {
  ui.line(ui.green(ui.bold(`✓ Explainer ready in ${minutes} min`)));
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

/** Older full-file writes are superseded by later ones: drop their content to save context. */
function compactHistory(keepId: string) {
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    for (const c of m.tool_calls as any[]) {
      if (c.function?.name === 'write_explainer' && c.id !== keepId && !c.function.arguments.includes('"[superseded')) {
        c.function.arguments = JSON.stringify({ content: '[superseded by a later version — use read_explainer to see the current file]' });
      }
    }
  }
}

function describeArgs(name: string, raw: string): string {
  try {
    const a = JSON.parse(raw);
    if (name === 'write_explainer') return `(${(a.content?.length / 1024).toFixed(1)} KB)`;
    if (name === 'edit_explainer') return `(${a.edits?.length ?? 0} edit(s))`;
    if (name === 'finish') return '';
  } catch { /* reported by the tool */ }
  return '';
}

function indent(s: string) {
  const lines = s.split('\n');
  const shown = lines.slice(0, 40).map((l) => `    ${l}`).join('\n');
  return lines.length > 40 ? `${shown}\n    … (${lines.length - 40} more lines)` : shown;
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
