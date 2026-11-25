// Push notifications via ntfy (https://ntfy.sh — hosted or self-hosted; phone apps for Android/iOS).
import type { Config } from '../agent/config.ts';

export interface Notification { title: string; message: string; tags?: string[]; priority?: 1 | 2 | 3 | 4 | 5; click?: string | null }

export async function notify(cfg: Config, n: Notification): Promise<void> {
  const { url, topic, token } = cfg.notifications.ntfy;
  if (!url || !topic) return;
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        Title: encodeHeader(n.title),
        ...(n.tags?.length && { Tags: n.tags.join(',') }),
        ...(n.priority && { Priority: String(n.priority) }),
        ...(n.click && { Click: n.click }),
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      body: n.message,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.warn(`[notify] ntfy responded HTTP ${res.status}`);
  } catch (err: any) {
    console.warn(`[notify] could not reach ntfy: ${err?.message ?? err}`);
  }
}

/** HTTP headers must be latin1; ntfy accepts RFC 2047 encoded-words for anything else. */
function encodeHeader(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

export const linkTo = (cfg: Config, pathname: string) => (cfg.server.publicUrl ? `${cfg.server.publicUrl.replace(/\/+$/, '')}${pathname}` : null);
