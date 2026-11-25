// Everything the agent does is reported as events. The CLI renders them to the terminal; the web
// service will stream them to the browser and persist them with the job.

export type AgentEvent =
  | { type: 'phase'; phase: string; label: string }
  | { type: 'step'; agent: string; step: number; maxSteps: number }
  | { type: 'reasoning'; text: string }
  | { type: 'content'; text: string }
  | { type: 'stream-end' }
  | { type: 'tool-progress'; name: string; bytes: number }
  | { type: 'waiting'; elapsedSeconds: number; idleSeconds: number }
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'tool-call'; agent: string; name: string; summary: string }
  | { type: 'tool-result'; agent: string; name: string; ok: boolean; summary: string }
  | { type: 'build'; ok: boolean; issues: number; warnings: number; detail?: string }
  | { type: 'status'; text: string }
  | { type: 'note'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'done'; ok: boolean; summary: string };

export type Emit = (e: AgentEvent) => void;

export const silent: Emit = () => {};
