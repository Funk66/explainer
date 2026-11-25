import type { ResearchConfig, SearchProvider } from './types.ts';
import { fetchWithTimeout } from './util.ts';

export function tavily(cfg: ResearchConfig): SearchProvider {
  const key = cfg.tavily.apiKey || process.env.TAVILY_API_KEY;
  if (!key) throw new Error('research.provider is "tavily" but no API key is set (research.tavily.apiKey or the TAVILY_API_KEY environment variable).');
  return {
    name: 'tavily',
    async search(query, maxResults) {
      const res = await fetchWithTimeout('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          query,
          max_results: Math.min(20, maxResults * 2),
          search_depth: cfg.tavily.searchDepth,
          include_answer: false,
          include_raw_content: false,
          ...(cfg.blockedDomains.length && { exclude_domains: cfg.blockedDomains }),
        }),
        timeoutMs: cfg.fetch.timeoutSeconds * 1000,
      });
      if (res.status === 401 || res.status === 403) throw new Error('Tavily rejected the API key (HTTP ' + res.status + ').');
      if (res.status === 429 || res.status === 432) throw new Error('Tavily rate/usage limit reached (HTTP ' + res.status + ').');
      if (!res.ok) throw new Error(`Tavily HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data: any = await res.json();
      return (data.results ?? []).map((r: any) => ({
        title: r.title ?? '',
        url: r.url,
        snippet: r.content ?? '',
        published: r.published_date ?? undefined,
        source: 'tavily',
      }));
    },
  };
}
