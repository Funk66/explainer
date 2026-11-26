import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT } from '../scripts/lib/paths.ts';
import type { Depth, Rigor } from '../scripts/lib/meta.ts';
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
    /** Max model turns per agent (writer, each section writer, fact-checker, …). */
    maxSteps: number;
    showReasoning: boolean;
    /** Depth used when none is requested: overview | standard | deep | comprehensive. */
    defaultDepth: Depth;
    /**
     * Rigor used when none is requested. "quick": write from knowledge with a few optional lookups, then one
     * review pass (a handful of model turns). "thorough": research first, then a claim-by-claim fact-check.
     */
    defaultRigor: Rigor;
  };
  /** Limits for quick-rigor runs (thorough runs use agent.maxSteps, factCheck.maxSteps and the search limits). */
  quick: {
    /** Max model turns per agent (writer, each section writer, reviewer, fixer). */
    maxSteps: number;
    /** Research calls of any kind (searches + page reads) per agent; 0 = none. */
    researchCalls: number;
    /** Paid web searches per agent (within researchCalls). */
    webSearches: number;
    /** Give the writer the most relevant passages of the top Wikipedia articles up front (no model turns). */
    reference: boolean;
    /** reasoning_effort for quick runs; null = llm.reasoningEffort. "low" usually cuts rumination a lot. */
    reasoningEffort: Config['llm']['reasoningEffort'];
  };
  factCheck: {
    /** Run a fresh-context fact-check (and a fix pass) after writing. */
    enabled: boolean;
    /** Model for the fact-checker; null = same as llm.model. A different model gives an independent opinion. */
    model: string | null;
    maxSteps: number;
  };
  output: {
    openInBrowser: boolean;
  };
  research: ResearchConfig;
  server: {
    port: number;
    /** Base URL the service is reached at (e.g. http://thinkcentre:8080), used for links in notifications. */
    publicUrl: string | null;
    /** Automatic retries for a failed job (e.g. inference endpoint unreachable), with growing delays. */
    jobRetries: number;
  };
  notifications: {
    ntfy: {
      /** ntfy server, e.g. https://ntfy.sh or your self-hosted instance; null disables notifications. */
      url: string | null;
      topic: string | null;
      /** Access token for protected topics (env NTFY_TOKEN). */
      token: string | null;
    };
    /** Notify when each job finishes (otherwise only batch summaries and failures). */
    eachJob: boolean;
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
  agent: { maxSteps: 60, showReasoning: true, defaultDepth: 'standard', defaultRigor: 'quick' },
  quick: { maxSteps: 10, researchCalls: 3, webSearches: 2, reference: true, reasoningEffort: null },
  factCheck: { enabled: true, model: null, maxSteps: 40 },
  output: { openInBrowser: true },
  server: { port: 8080, publicUrl: null, jobRetries: 2 },
  notifications: { ntfy: { url: null, topic: null, token: null }, eachJob: true },
  research: {
    provider: 'none',
    wikipedia: true,
    wikipediaLanguage: 'en',
    searxng: { url: 'http://localhost:8080', engines: null, categories: null, language: 'en' },
    tavily: { apiKey: null, searchDepth: 'basic' },
    jina: { apiKey: null },
    searchLimits: { overview: 12, standard: 25, deep: 50, comprehensive: 80 },
    maxResults: 8,
    preferredDomains: [],
    blockedDomains: [],
    fetch: { maxChars: 8000, timeoutSeconds: 20, fallback: 'none' },
  },
};

// Config file: EXPLAINER_CONFIG, else <data dir>/config.json (container volume), else the repo's explainer.config.json.
export const CONFIG_PATH = process.env.EXPLAINER_CONFIG
  ?? (existsSync(path.join(DATA_DIR, 'config.json')) ? path.join(DATA_DIR, 'config.json') : path.join(ROOT, 'explainer.config.json'));

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
    quick: { ...DEFAULTS.quick, ...user.quick },
    factCheck: { ...DEFAULTS.factCheck, ...user.factCheck },
    server: { ...DEFAULTS.server, ...user.server },
    notifications: { ...DEFAULTS.notifications, ...user.notifications, ntfy: { ...DEFAULTS.notifications.ntfy, ...user.notifications?.ntfy } },
    output: { ...DEFAULTS.output, ...user.output },
    research: {
      ...DEFAULTS.research,
      ...r,
      searxng: { ...DEFAULTS.research.searxng, ...r.searxng },
      tavily: { ...DEFAULTS.research.tavily, ...r.tavily },
      jina: { ...DEFAULTS.research.jina, ...r.jina },
      searchLimits: { ...DEFAULTS.research.searchLimits, ...r.searchLimits },
      fetch: { ...DEFAULTS.research.fetch, ...r.fetch },
    },
  };
  const providers = Array.isArray(cfg.research.provider) ? cfg.research.provider : [cfg.research.provider];
  if (!providers.every((p) => ['searxng', 'tavily', 'none'].includes(p))) {
    throw new Error(`research.provider must be "searxng", "tavily", "none" or a list like ["searxng", "tavily"] (got ${JSON.stringify(cfg.research.provider)})`);
  }
  if (!['overview', 'standard', 'deep', 'comprehensive'].includes(cfg.agent.defaultDepth)) {
    throw new Error(`agent.defaultDepth must be overview, standard, deep or comprehensive (got "${cfg.agent.defaultDepth}")`);
  }
  if (!['quick', 'thorough'].includes(cfg.agent.defaultRigor)) {
    throw new Error(`agent.defaultRigor must be quick or thorough (got "${cfg.agent.defaultRigor}")`);
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
  if (process.env.PORT) cfg.server.port = Number(process.env.PORT);
  if (process.env.PUBLIC_URL) cfg.server.publicUrl = process.env.PUBLIC_URL;
  if (process.env.NTFY_URL) cfg.notifications.ntfy.url = process.env.NTFY_URL;
  if (process.env.NTFY_TOPIC) cfg.notifications.ntfy.topic = process.env.NTFY_TOPIC;
  if (process.env.NTFY_TOKEN) cfg.notifications.ntfy.token = process.env.NTFY_TOKEN;
  return cfg;
}
