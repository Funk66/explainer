import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../scripts/lib/paths.ts';
import type { ResearchConfig } from './research/types.ts';

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
  research: ResearchConfig;
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
  agent: { maxSteps: 60, showReasoning: true },
  output: { openInBrowser: true },
  research: {
    provider: 'none',
    wikipedia: true,
    wikipediaLanguage: 'en',
    searxng: { url: 'http://localhost:8080', engines: null, categories: null, language: 'en' },
    tavily: { apiKey: null, searchDepth: 'basic' },
    jina: { apiKey: null },
    maxResults: 8,
    preferredDomains: [],
    blockedDomains: [],
    fetch: { maxChars: 8000, timeoutSeconds: 20, fallback: 'none' },
  },
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
  const r: Partial<ResearchConfig> = user.research ?? {};
  const cfg: Config = {
    llm: { ...DEFAULTS.llm, ...user.llm },
    agent: { ...DEFAULTS.agent, ...user.agent },
    output: { ...DEFAULTS.output, ...user.output },
    research: {
      ...DEFAULTS.research,
      ...r,
      searxng: { ...DEFAULTS.research.searxng, ...r.searxng },
      tavily: { ...DEFAULTS.research.tavily, ...r.tavily },
      jina: { ...DEFAULTS.research.jina, ...r.jina },
      fetch: { ...DEFAULTS.research.fetch, ...r.fetch },
    },
  };
  const providers = Array.isArray(cfg.research.provider) ? cfg.research.provider : [cfg.research.provider];
  if (!providers.every((p) => ['searxng', 'tavily', 'none'].includes(p))) {
    throw new Error(`research.provider must be "searxng", "tavily", "none" or a list like ["searxng", "tavily"] (got ${JSON.stringify(cfg.research.provider)})`);
  }
  if (!['none', 'tavily', 'jina'].includes(cfg.research.fetch.fallback)) {
    throw new Error(`research.fetch.fallback must be "none", "tavily" or "jina" (got "${cfg.research.fetch.fallback}")`);
  }
  // Environment overrides (handy for one-off runs / CI)
  if (process.env.EXPLAINER_BASE_URL) cfg.llm.baseUrl = process.env.EXPLAINER_BASE_URL;
  if (process.env.EXPLAINER_MODEL) cfg.llm.model = process.env.EXPLAINER_MODEL;
  if (process.env.EXPLAINER_API_KEY) cfg.llm.apiKey = process.env.EXPLAINER_API_KEY;
  if (process.env.EXPLAINER_SEARCH_PROVIDER) {
    const v = process.env.EXPLAINER_SEARCH_PROVIDER.split(',').map((x) => x.trim());
    cfg.research.provider = (v.length > 1 ? v : v[0]) as any;
  }
  if (process.env.SEARXNG_URL) cfg.research.searxng.url = process.env.SEARXNG_URL;
  return cfg;
}
