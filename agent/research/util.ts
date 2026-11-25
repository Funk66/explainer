export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

export const matchesDomain = (host: string, domain: string) => {
  const d = domain.toLowerCase().replace(/^www\./, '');
  return host === d || host.endsWith(`.${d}`);
};

/** Canonical form used to compare URLs: no fragment, no tracking params, no trailing slash, lowercase host. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|ref_src$)/.test(k)) u.searchParams.delete(k);
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    if (u.pathname === '/' && !u.search) s = s.replace(/\/$/, '');
    return s.replace(/^http:\/\//, 'https://');
  } catch {
    return raw.trim();
  }
}

export const stripHtml = (s: string) =>
  s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

export async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs: number }): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  try {
    return await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err: any) {
    // Node's "fetch failed" hides the real reason in err.cause
    const c = err?.cause;
    const reason = err?.name === 'TimeoutError' ? `timed out after ${timeoutMs / 1000}s`
      : c?.code === 'ENOTFOUND' ? `host not found (${c.hostname ?? hostOf(url)})`
      : c?.code === 'ECONNREFUSED' || c?.errors?.[0]?.code === 'ECONNREFUSED' ? 'connection refused (is the service running?)'
      : c?.code ? (String(c.code).startsWith('ERR_SSL') ? `TLS handshake failed (${c.code})` : `${c.code}${c.message ? `: ${String(c.message).split('\n')[0].slice(0, 120)}` : ''}`)
      : err?.message ?? String(err);
    let where = url;
    try { where = new URL(url).host; } catch { /* keep raw */ }
    throw new Error(`could not reach ${where}: ${reason}`);
  }
}

/** Generic, non-identifying client name for outgoing requests. */
export const USER_AGENT = 'Mozilla/5.0 (compatible; explainer-research/1.0)';
