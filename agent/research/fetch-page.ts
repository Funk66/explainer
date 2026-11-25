// Downloads a page and returns its main readable text (Markdown-ish: headings, lists, tables kept).
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { extractText, getDocumentProxy } from 'unpdf';
import { fetchWithTimeout, USER_AGENT } from './util.ts';
import { wikipediaText } from './wikipedia.ts';

const MAX_BYTES = 25 * 1024 * 1024;

export interface FetchedPage { url: string; title: string; text: string }

export async function fetchPage(url: string, timeoutMs: number): Promise<FetchedPage> {
  if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) URLs can be fetched');
  const wiki = await wikipediaText(url, timeoutMs);
  if (wiki) return { url, ...wiki };

  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
    redirect: 'follow',
    timeoutMs,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const type = res.headers.get('content-type') ?? '';
  const buf = await readLimited(res);
  if (/pdf/i.test(type) || isPdf(buf)) return { url: res.url || url, ...(await pdfText(buf, url)) };
  const raw = new TextDecoder(charset(type)).decode(buf);

  if (/^text\/(plain|markdown)|json|xml(?!.*html)/i.test(type) && !/html/i.test(type)) {
    return { url: res.url || url, title: url, text: raw.trim() };
  }
  const { document } = parseHTML(raw);
  const title = document.querySelector('title')?.textContent?.trim() ?? url;
  const article = new Readability(document as any, { charThreshold: 200 }).parse();
  const root = article?.content ? parseHTML(`<html><body>${article.content}</body></html>`).document.body : document.body;
  const text = toText(root).replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 200) throw new Error('the page has almost no readable text (it may require JavaScript or a login)');
  return { url: res.url || url, title: article?.title || title, text };
}

const isPdf = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF

async function pdfText(buf: Uint8Array, url: string): Promise<{ title: string; text: string }> {
  const pdf = await getDocumentProxy(buf);
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const meta: any = await pdf.getMetadata().catch(() => null);
  const title = meta?.info?.Title?.trim() || decodeURIComponent(url.split('/').pop() ?? url);
  const pages = (text as string[]).map((t, i) => `[page ${i + 1}]\n${t.replace(/[ \t]+/g, ' ').trim()}`).join('\n\n');
  if (pages.replace(/\[page \d+\]/g, '').trim().length < 200) throw new Error('the PDF has no extractable text (probably scanned images)');
  return { title: `${title} (PDF, ${totalPages} pages)`, text: pages };
}

async function readLimited(res: Response): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel(); break; }
    chunks.push(value);
  }
  const out = new Uint8Array(Math.min(size, MAX_BYTES));
  let o = 0;
  for (const c of chunks) { out.set(c.subarray(0, out.length - o), o); o += c.byteLength; if (o >= out.length) break; }
  return out;
}

function charset(type: string): string {
  const m = /charset=([\w-]+)/i.exec(type);
  try { return m ? new TextDecoder(m[1]).encoding : 'utf-8'; } catch { return 'utf-8'; }
}

/** Minimal HTML → text that keeps the structure a model needs (headings, lists, tables, code). */
function toText(node: any): string {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'NAV', 'FOOTER', 'FORM', 'BUTTON', 'IFRAME']);
  const out: string[] = [];
  const walk = (n: any, listDepth: number) => {
    if (n.nodeType === 3) { out.push(n.textContent.replace(/\s+/g, ' ')); return; }
    if (n.nodeType !== 1 || SKIP.has(n.tagName)) return;
    const tag = n.tagName;
    if (/^H[1-6]$/.test(tag)) { out.push(`\n\n${'#'.repeat(Number(tag[1]))} ${n.textContent.trim()}\n\n`); return; }
    if (tag === 'PRE') { out.push(`\n\n\`\`\`\n${n.textContent.trim()}\n\`\`\`\n\n`); return; }
    if (tag === 'TABLE') {
      const rows = [...n.querySelectorAll('tr')].map((tr: any) => [...tr.children].map((c: any) => c.textContent.replace(/\s+/g, ' ').trim()).join(' | '));
      out.push(`\n\n${rows.join('\n')}\n\n`);
      return;
    }
    if (tag === 'LI') { out.push(`\n${'  '.repeat(Math.max(0, listDepth - 1))}- `); }
    if (tag === 'BR') out.push('\n');
    const block = /^(P|DIV|SECTION|ARTICLE|BLOCKQUOTE|UL|OL|DL|DT|DD|FIGURE|FIGCAPTION|HEADER|MAIN)$/.test(tag);
    if (block) out.push('\n\n');
    for (const c of n.childNodes) walk(c, tag === 'UL' || tag === 'OL' ? listDepth + 1 : listDepth);
    if (block) out.push('\n\n');
  };
  walk(node, 0);
  return out.join('').split('\n').map((l) => l.trimEnd()).join('\n');
}

// ---------------------------------------------------------------------------------------------
// Fallback extractors, used only when the local fetch fails.

export async function fetchViaTavily(url: string, timeoutMs: number): Promise<FetchedPage> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('fallback "tavily" needs TAVILY_API_KEY');
  const res = await fetchWithTimeout('https://api.tavily.com/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ urls: [url], extract_depth: 'basic' }),
    timeoutMs,
  });
  if (!res.ok) throw new Error(`Tavily Extract HTTP ${res.status}`);
  const data: any = await res.json();
  const r = data.results?.[0];
  if (!r?.raw_content) throw new Error(`Tavily Extract could not read the page${data.failed_results?.[0]?.error ? ` (${data.failed_results[0].error})` : ''}`);
  return { url, title: r.title ?? url, text: String(r.raw_content).trim() };
}

export async function fetchViaJina(url: string, timeoutMs: number, apiKey: string | null): Promise<FetchedPage> {
  const key = apiKey || process.env.JINA_API_KEY;
  const res = await fetchWithTimeout(`https://r.jina.ai/${url}`, {
    headers: { Accept: 'text/plain', 'X-Retain-Images': 'none', ...(key && { Authorization: `Bearer ${key}` }) },
    timeoutMs,
  });
  if (!res.ok) throw new Error(`Jina Reader HTTP ${res.status}`);
  const raw = await res.text();
  const title = /^Title: (.*)$/m.exec(raw)?.[1]?.trim() ?? url;
  const text = raw.split(/^Markdown Content:\s*$/m)[1] ?? raw;
  // Drop link targets and images to save context: [text](url) -> text
  const clean = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
  if (clean.length < 200) throw new Error('Jina Reader returned almost no text');
  return { url, title, text: clean };
}
