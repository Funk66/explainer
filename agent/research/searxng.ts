import type { ResearchConfig, SearchProvider, SearchResult } from './types.ts';
import { fetchWithTimeout, USER_AGENT } from './util.ts';

export function searxng(cfg: ResearchConfig): SearchProvider {
  const base = cfg.searxng.url.replace(/\/+$/, '');
  return {
    name: 'searxng',
    async search(query, maxResults) {
      const params = new URLSearchParams({ q: query, format: 'json', safesearch: '0' });
      if (cfg.searxng.language) params.set('language', cfg.searxng.language);
      if (cfg.searxng.engines) params.set('engines', cfg.searxng.engines);
      if (cfg.searxng.categories) params.set('categories', cfg.searxng.categories);
      const res = await fetchWithTimeout(`${base}/search?${params}`, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        timeoutMs: cfg.fetch.timeoutSeconds * 1000,
      });
      if (res.status === 403) throw new Error(`SearXNG at ${base} refused the JSON API (HTTP 403). Enable it in settings.yml: search: formats: [html, json]`);
      if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
      const data: any = await res.json();
      const results: SearchResult[] = (data.results ?? []).map((r: any) => ({
        title: r.title ?? '',
        url: r.url,
        snippet: r.content ?? '',
        published: r.publishedDate ?? undefined,
        source: Array.isArray(r.engines) ? r.engines.join(',') : r.engine,
      }));
      return results.slice(0, maxResults * 2);
    },
  };
}
