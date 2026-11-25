// Wikipedia via its public API (no key). Search returns titles + snippets; page text comes from the
// plain-text extracts API, which is much cleaner than scraping the HTML.
import type { SearchResult } from './types.ts';
import { fetchWithTimeout, stripHtml, USER_AGENT } from './util.ts';

const api = (lang: string) => `https://${lang}.wikipedia.org/w/api.php`;

export async function searchWikipedia(query: string, lang: string, limit: number, timeoutMs: number): Promise<SearchResult[]> {
  const params = new URLSearchParams({ action: 'query', list: 'search', srsearch: query, srlimit: String(limit), format: 'json', utf8: '1', origin: '*' });
  const res = await fetchWithTimeout(`${api(lang)}?${params}`, { headers: { 'User-Agent': USER_AGENT }, timeoutMs });
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  const data: any = await res.json();
  return (data.query?.search ?? []).map((r: any) => ({
    title: r.title,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
    snippet: stripHtml(r.snippet ?? ''),
    source: 'wikipedia',
  }));
}

/** Returns { title, text } for a Wikipedia article URL, or null if the URL isn't a Wikipedia article. */
export async function wikipediaText(url: string, timeoutMs: number): Promise<{ title: string; text: string } | null> {
  const m = /^https?:\/\/([a-z-]+)\.(?:m\.)?wikipedia\.org\/wiki\/([^?#]+)/.exec(url);
  if (!m) return null;
  const [, lang, rawTitle] = m;
  const title = decodeURIComponent(rawTitle).replace(/_/g, ' ');
  const params = new URLSearchParams({ action: 'query', prop: 'extracts', explaintext: '1', exsectionformat: 'wiki', redirects: '1', titles: title, format: 'json', origin: '*' });
  const res = await fetchWithTimeout(`${api(lang)}?${params}`, { headers: { 'User-Agent': USER_AGENT }, timeoutMs });
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  const data: any = await res.json();
  const page: any = Object.values(data.query?.pages ?? {})[0];
  if (!page || page.missing !== undefined) throw new Error(`Wikipedia article "${title}" not found`);
  // "== Heading ==" → "## Heading"; drop reference-only tail sections.
  let text: string = page.extract ?? '';
  text = text.replace(/^(=+)\s*(.*?)\s*\1\s*$/gm, (_, eq: string, h: string) => `${'#'.repeat(Math.min(6, eq.length))} ${h}`);
  text = text.split(/\n## (See also|References|Notes|External links|Further reading|Bibliography)\n/)[0];
  return { title: page.title, text: text.replace(/\n{3,}/g, '\n\n').trim() };
}
