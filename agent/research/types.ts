export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  published?: string;
  /** Which engine/provider produced it (informational). */
  source?: string;
}

export interface SearchProvider {
  name: string;
  search(query: string, maxResults: number): Promise<SearchResult[]>;
}

export interface ResearchConfig {
  /** Web search backend, or an ordered fallback chain (e.g. ["searxng", "tavily"]): the next provider is
   *  used when one errors or returns nothing. "none" disables web_search (Wikipedia + fetch_page may stay on). */
  provider: SearchProviderName | 'none' | SearchProviderName[];
  /** Enable the search_wikipedia tool (free public API, no key). */
  wikipedia: boolean;
  /** Wikipedia language edition, e.g. "en", "es". */
  wikipediaLanguage: string;
  searxng: {
    /** Base URL of your SearXNG instance. Its settings.yml must allow the JSON format: search.formats: [html, json] */
    url: string;
    /** Optional comma-separated engines (e.g. "google,bing,wikipedia"); null = instance defaults. */
    engines: string | null;
    /** Optional comma-separated categories (e.g. "general,science,it"); null = instance defaults. */
    categories: string | null;
    language: string;
  };
  tavily: {
    /** API key; falls back to the TAVILY_API_KEY environment variable. */
    apiKey: string | null;
    searchDepth: 'basic' | 'advanced';
  };
  /** Max paid web searches per explainer run (writing + fact-check together), by depth. Repeats, cache hits and Wikipedia are free. */
  searchLimits: { overview: number; standard: number; deep: number; comprehensive: number };
  /** Results per search returned to the model. */
  maxResults: number;
  /** Results from these domains (and subdomains) are ranked first. */
  preferredDomains: string[];
  /** Results from these domains are dropped. */
  blockedDomains: string[];
  jina: {
    /** Optional; Jina Reader works without a key at low request rates. Falls back to env JINA_API_KEY. */
    apiKey: string | null;
  };
  fetch: {
    /** Characters of page text returned per fetch_page call (the model can page with `offset`). */
    maxChars: number;
    timeoutSeconds: number;
    /** Extraction service used only when the local fetch fails (JS-only pages, bot protection, odd TLS, …). */
    fallback: 'none' | 'tavily' | 'jina';
  };
}

export type SearchProviderName = 'searxng' | 'tavily';
