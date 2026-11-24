import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../scripts/lib/paths.ts';

export interface Config {
  llm: {
    /** OpenAI-compatible endpoint, e.g. http://localhost:1235/v1 */
    baseUrl: string;
    apiKey: string;
    model: string;
    /** Sent as `reasoning_effort`. null = don't send (server default). */
    reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | null;
    temperature: number | null;
    maxTokens: number | null;
    requestTimeoutSeconds: number;
    /** Merged verbatim into every request body (server-specific options). */
    extraBody: Record<string, unknown>;
  };
  agent: {
    maxSteps: number;
    showReasoning: boolean;
  };
  output: {
    openInBrowser: boolean;
  };
}

const DEFAULTS: Config = {
  llm: {
    baseUrl: 'http://localhost:1234/v1',
    apiKey: 'not-needed',
    model: '',
    reasoningEffort: null,
    temperature: null,
    maxTokens: null,
    requestTimeoutSeconds: 1800,
    extraBody: {},
  },
  agent: { maxSteps: 20, showReasoning: true },
  output: { openInBrowser: true },
};

export const CONFIG_PATH = process.env.EXPLAINER_CONFIG ?? path.join(ROOT, 'explainer.config.json');

export function loadConfig(): Config {
  let user: Partial<Config> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      user = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err: any) {
      throw new Error(`Could not parse ${CONFIG_PATH}: ${err.message}`);
    }
  }
  const cfg: Config = {
    llm: { ...DEFAULTS.llm, ...user.llm },
    agent: { ...DEFAULTS.agent, ...user.agent },
    output: { ...DEFAULTS.output, ...user.output },
  };
  // Environment overrides (handy for one-off runs / CI)
  if (process.env.EXPLAINER_BASE_URL) cfg.llm.baseUrl = process.env.EXPLAINER_BASE_URL;
  if (process.env.EXPLAINER_MODEL) cfg.llm.model = process.env.EXPLAINER_MODEL;
  if (process.env.EXPLAINER_API_KEY) cfg.llm.apiKey = process.env.EXPLAINER_API_KEY;
  return cfg;
}
