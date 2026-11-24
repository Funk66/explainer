// Streaming chat completions against any OpenAI-compatible server (LM Studio, Ollama, llama.cpp, vLLM, …).
import OpenAI from 'openai';
import { Agent, fetch as undiciFetch } from 'undici';
import type { Config } from './config.ts';
import * as ui from './ui.ts';

export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type Tool = OpenAI.Chat.Completions.ChatCompletionFunctionTool;
export interface ToolCall { id: string; name: string; arguments: string }
export interface Completion { content: string; reasoning: string; toolCalls: ToolCall[]; finishReason: string | null; usage?: { prompt_tokens: number; completion_tokens: number } }

export function createClient(cfg: Config) {
  // Local servers may stay silent for many minutes (e.g. while generating a long tool call that is
  // only sent once complete). Node's default fetch aborts after 300 s without bytes, so disable the
  // idle timeouts; the overall request timeout below still applies.
  const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0, keepAliveTimeout: 60_000 });
  return new OpenAI({
    baseURL: cfg.llm.baseUrl,
    apiKey: cfg.llm.apiKey || 'not-needed',
    timeout: cfg.llm.requestTimeoutSeconds * 1000,
    maxRetries: 1,
    fetch: ((url: any, init: any) => undiciFetch(url, { ...init, dispatcher })) as any,
  });
}

export async function complete(client: OpenAI, cfg: Config, messages: Message[], tools: Tool[]): Promise<Completion> {
  const body: Record<string, unknown> = {
    model: cfg.llm.model,
    messages,
    tools,
    tool_choice: 'auto',
    stream: true,
    stream_options: { include_usage: true },
  };
  if (cfg.llm.temperature != null) body.temperature = cfg.llm.temperature;
  if (cfg.llm.maxTokens != null) body.max_tokens = cfg.llm.maxTokens;
  if (cfg.llm.reasoningEffort != null) body.reasoning_effort = cfg.llm.reasoningEffort;
  Object.assign(body, cfg.llm.extraBody);

  const stream = (await client.chat.completions.create(body as any)) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

  let content = '';
  let reasoning = '';
  let finishReason: string | null = null;
  let usage: Completion['usage'];
  const calls: { id: string; name: string; arguments: string }[] = [];
  let mode: 'none' | 'reasoning' | 'content' | 'tool' = 'none';

  // Heartbeat: show elapsed time whenever the server is silent for a while.
  let lastChunk = Date.now();
  const t0 = Date.now();
  const heartbeat = setInterval(() => {
    const idle = (Date.now() - lastChunk) / 1000;
    if (idle > 5) ui.status(ui.dim(`  … waiting for the model (${Math.round((Date.now() - t0) / 1000)}s elapsed, ${Math.round(idle)}s since last output)`));
  }, 1000);

  try {
  for await (const chunk of stream) {
    if (Date.now() - lastChunk > 5000) ui.clearStatus();
    lastChunk = Date.now();
    if (chunk.usage) usage = chunk.usage as any;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta as any;
    const r: string | undefined = delta.reasoning_content ?? delta.reasoning;
    if (r) {
      reasoning += r;
      if (cfg.agent.showReasoning) {
        if (mode !== 'reasoning') { ui.clearStatus(); ui.write(ui.dim('\n💭 ')); mode = 'reasoning'; }
        ui.write(ui.dim(r));
      } else {
        ui.status(ui.dim(`  thinking… ${reasoning.length.toLocaleString()} chars`));
      }
    }
    if (delta.content) {
      content += delta.content;
      if (mode !== 'content') { ui.clearStatus(); if (content.trim()) ui.write('\n'); mode = 'content'; }
      ui.write(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? 0;
      calls[i] ??= { id: '', name: '', arguments: '' };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].name += tc.function.name;
      if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
      if (mode !== 'tool') { ui.write('\n'); mode = 'tool'; }
      ui.status(ui.cyan(`  → ${calls[i].name || 'tool'} `) + ui.dim(`(${(calls[i].arguments.length / 1024).toFixed(1)} KB streamed)`));
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  } finally {
    clearInterval(heartbeat);
  }
  ui.clearStatus();
  if (mode === 'reasoning' || mode === 'content') ui.write('\n');

  let toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));
  // Some local chat templates leak tool calls into the text as <tool_call>{...}</tool_call>.
  if (toolCalls.length === 0) {
    toolCalls = [...content.matchAll(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g)].flatMap((m, i) => {
      try {
        const j = JSON.parse(m[1]);
        return [{ id: `call_text_${i}`, name: j.name, arguments: typeof j.arguments === 'string' ? j.arguments : JSON.stringify(j.arguments ?? {}) }];
      } catch { return []; }
    });
  }
  return { content, reasoning, toolCalls, finishReason, usage };
}
