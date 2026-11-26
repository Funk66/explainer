// Generic tool-calling agent loop with the guards weaker local models need. Agents (writer,
// fact-checker, section writers, …) are described by an AgentSpec; this file knows nothing about
// explainers.
import type OpenAI from 'openai';
import type { Config } from './config.ts';
import type { Emit } from './events.ts';
import { complete, type Message, type Tool } from './llm.ts';
import { RESEARCH_TOOL_NAMES } from './research/index.ts';

export interface AgentContext {
  client: OpenAI;
  cfg: Config;
  emit: Emit;
  /** Appends an entry to the explainer's transcript (agent-log.jsonl). */
  log: (entry: object) => void;
  signal?: AbortSignal;
}

export interface AgentSpec {
  /** Shown in progress output, e.g. "writer", "fact-check", "section 3/9". */
  name: string;
  system: string;
  user: string;
  maxSteps: number;
  /** Tools offered in the current state. */
  tools(): Tool[];
  runTool(name: string, rawArgs: string): Promise<string>;
  isDone(): boolean;
  /** Has the agent produced its main output yet? Until it has, a research budget applies. */
  hasOutput(): boolean;
  /** Tools offered once the research budget is exhausted without output (e.g. only the write tool). */
  outputTools(): Tool[];
  /** Message sent when the budget is exhausted. */
  outputNudge: string;
  /** One sentence telling the model what to do next (used when it stalls or repeats itself). */
  nextHint(): string;
  /** Handle a plain-text reply (e.g. pasted MDX). Return a message for the model, or null for the default nudge. */
  onText?(content: string): Promise<string | null>;
  /** Tool whose older calls are superseded by newer ones (their arguments are dropped from the context). */
  supersedes?: string;
  /** Tools after which earlier research results are compacted (the draft now contains what mattered). */
  compactAfter?: string[];
  /** Share of maxSteps that may pass before the output is forced (default 0.5, at least 6 steps). */
  researchBudget?: number;
  /** Absolute number of steps before the output is forced; overrides researchBudget (quick runs). */
  researchSteps?: number;
  /** Short description of a call's arguments for progress output. */
  describeCall?(name: string, args: any): string;
}

export interface AgentRun {
  done: boolean;
  steps: number;
  reason: 'done' | 'max-steps' | 'stuck' | 'idle';
  messages: Message[];
}

export class AgentAborted extends Error {
  constructor() { super('cancelled'); this.name = 'AgentAborted'; }
}

export async function runAgent(ctx: AgentContext, spec: AgentSpec): Promise<AgentRun> {
  const { cfg, emit, log } = ctx;
  const messages: Message[] = [
    { role: 'system', content: spec.system },
    { role: 'user', content: spec.user },
  ];
  log({ agent: spec.name, ...messages[0] });
  log({ agent: spec.name, ...messages[1] });
  const say = (content: string) => {
    const m: Message = { role: 'user', content };
    messages.push(m);
    log({ agent: spec.name, ...m });
  };

  const budget = spec.researchSteps ?? Math.max(6, Math.floor(spec.maxSteps * (spec.researchBudget ?? 0.5)));
  let forceOutput = false;
  let idle = 0;
  let lastSignature = '';
  let repeats = 0;
  let step = 0;

  while (step < spec.maxSteps && !spec.isDone()) {
    step++;
    if (ctx.signal?.aborted) throw new AgentAborted();
    emit({ type: 'step', agent: spec.name, step, maxSteps: spec.maxSteps });

    if (!spec.hasOutput() && step > budget && !forceOutput) {
      forceOutput = true;
      say(`You have used ${step - 1} of ${spec.maxSteps} steps. ${spec.outputNudge}`);
      emit({ type: 'note', level: 'warn', text: 'research budget reached — asking the model to produce its output now' });
    }
    const forcing = forceOutput && !spec.hasOutput();
    const res = await completeWithRetry(ctx, messages, forcing ? spec.outputTools() : spec.tools(), forcing ? 'required' : 'auto');
    if (res.usage) emit({ type: 'usage', promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens });

    const assistant: Message = {
      role: 'assistant',
      content: res.content || null,
      ...(res.toolCalls.length && { tool_calls: res.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } })) }),
    };
    messages.push(assistant);
    log({ agent: spec.name, ...assistant, reasoning: res.reasoning });

    // ----- Plain text instead of tool calls -----
    if (res.toolCalls.length === 0) {
      const handled = res.content && spec.onText ? await spec.onText(res.content) : null;
      if (handled) { say(handled); continue; }
      if (res.finishReason === 'length') {
        // Usually the reasoning itself used up the output limit before any tool call was made.
        say(res.content?.trim()
          ? 'Your response was cut off (token limit). Continue using the tools, and keep each tool call within the limit.'
          : `Your response hit the output token limit while you were still thinking, so nothing was done. Think much less: don't draft the content in your head — make the tool call directly and put the content in it. ${spec.nextHint()}`);
        continue;
      }
      if (++idle >= 3) return { done: spec.isDone(), steps: step, reason: 'idle', messages };
      say(`Please continue by calling the tools — do not reply with plain text. ${spec.nextHint()}`);
      continue;
    }
    idle = 0;

    // ----- Repetition guard -----
    const signature = res.toolCalls.map((c) => `${c.name}:${c.arguments}`).join('|');
    repeats = signature === lastSignature ? repeats + 1 : 0;
    lastSignature = signature;
    if (repeats >= 4) {
      emit({ type: 'note', level: 'error', text: `the model is stuck repeating ${res.toolCalls[0].name}` });
      return { done: false, steps: step, reason: 'stuck', messages };
    }

    // ----- Run tools -----
    for (const call of res.toolCalls) {
      let args: any = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch { /* the tool reports it */ }
      emit({ type: 'tool-call', agent: spec.name, name: call.name, summary: describe(spec, call.name, args) });
      const result = await spec.runTool(call.name, call.arguments);
      const ok = !result.startsWith('ERROR');
      emit({ type: 'tool-result', agent: spec.name, name: call.name, ok, summary: summarizeResult(call.name, result) });
      const m: Message = { role: 'tool', tool_call_id: call.id, content: result };
      messages.push(m);
      log({ agent: spec.name, ...m });
      if (ok && spec.compactAfter?.includes(call.name)) compact(messages, call.id, spec.supersedes);
      if (spec.isDone()) break;
    }
    if (spec.hasOutput()) forceOutput = false;
    if (repeats >= 2 && !spec.isDone()) {
      say(`You have made exactly the same tool call ${repeats + 1} times in a row and got the same result. Do something different. ${spec.nextHint()}`);
      if (!spec.hasOutput()) forceOutput = true;
      emit({ type: 'note', level: 'warn', text: 'repeated identical calls — nudging the model' });
    }
  }
  return { done: spec.isDone(), steps: step, reason: spec.isDone() ? 'done' : 'max-steps', messages };
}

/** Network hiccups shouldn't throw away a long run: retry the request a few times. */
async function completeWithRetry(ctx: AgentContext, messages: Message[], tools: Tool[], toolChoice: 'auto' | 'required') {
  const waits = [10, 30, 90];
  for (let attempt = 0; ; attempt++) {
    try {
      return await complete(ctx.client, ctx.cfg, messages, tools, ctx.emit, toolChoice, ctx.signal);
    } catch (err: any) {
      if (ctx.signal?.aborted) throw new AgentAborted();
      const status = err?.status as number | undefined;
      const permanent = status && status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (permanent || attempt >= waits.length) {
        throw new Error(`LLM request failed: ${err?.message ?? err}. Is the server running at ${ctx.cfg.llm.baseUrl} and is "${ctx.cfg.llm.model}" available?`);
      }
      ctx.emit({ type: 'note', level: 'warn', text: `LLM request failed (${err?.message ?? err}); retrying in ${waits[attempt]}s` });
      await sleep(waits[attempt] * 1000, ctx.signal);
    }
  }
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new AgentAborted()); }, { once: true });
});

/** Keep the context small once an output exists: drop superseded full writes and used research results. */
function compact(messages: Message[], keepId: string, supersedes?: string) {
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    for (const c of m.tool_calls as any[]) {
      names.set(c.id, c.function?.name);
      if (supersedes && c.function?.name === supersedes && c.id !== keepId && !c.function.arguments.startsWith('{"content":"[superseded')) {
        c.function.arguments = JSON.stringify({ content: '[superseded by a later version — read the current file if needed]' });
      }
    }
  }
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    const name = names.get(m.tool_call_id);
    if (name && RESEARCH_TOOL_NAMES.has(name) && typeof m.content === 'string' && !m.content.startsWith('[research result')) {
      const head = m.content.split('\n').slice(0, 2).join(' | ');
      m.content = `[research result already used — ${head.slice(0, 200)}. Call the tool again if you need the details.]`;
    }
  }
}

function describe(spec: AgentSpec, name: string, a: any): string {
  const custom = spec.describeCall?.(name, a);
  if (custom !== undefined && custom !== '') return custom;
  if (name === 'web_search' || name === 'search_wikipedia') return `"${a?.query ?? ''}"`;
  if (name === 'fetch_page') return `${a?.url ?? ''}${a?.focus ? ` [focus: ${a.focus}]` : a?.offset ? ` @${a.offset}` : ''}`;
  return '';
}

function summarizeResult(name: string, result: string): string {
  if (result.startsWith('ERROR')) return result.split('\n').slice(0, 6).join('\n');
  if (RESEARCH_TOOL_NAMES.has(name)) {
    const lines = result.split('\n');
    if (result.startsWith('SOURCE:')) return `${lines[0]} · ${lines[2] ?? ''}`;
    return [lines[0], ...lines.filter((l) => /^\d+\. /.test(l)).slice(0, 5).map((l) => `• ${l.replace(/^\d+\. /, '').slice(0, 110)}`)].join('\n');
  }
  if (name.startsWith('read_')) return '';
  return result.length > 2500 ? `${result.slice(0, 2500)}…` : result;
}
