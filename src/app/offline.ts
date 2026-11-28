// Offline support: registers the service worker (server/pwa/sw.js) and keeps a copy of every explainer in the Cache API.
// The cache follows the server's library: new or updated explainers are downloaded, deleted ones are removed.
// Everything here is best effort: without a secure context (https or localhost) there is no service worker and the app works online only.

const PAGES = 'explainers-v1'; // must match sw.js
const INDEX = '/__offline/index.json'; // slug → updatedAt of the copy we hold
const SYNC = { headers: { 'x-offline-sync': '1' } }; // tells the service worker to let the request through to the server

export interface LibraryItem { slug: string; updatedAt: string; htmlBytes?: number }

export const supported = 'serviceWorker' in navigator && 'caches' in self;

export function initOffline() {
  if (!supported) return;
  navigator.serviceWorker.register('/sw.js').catch(() => { /* e.g. private mode */ });
  // Ask the browser not to evict the library under storage pressure (it is only a few MB).
  navigator.storage?.persist?.().catch(() => {});
}

async function readIndex(cache: Cache): Promise<Record<string, string>> {
  try { return (await (await cache.match(INDEX))?.json()) ?? {}; } catch { return {}; }
}
const writeIndex = (cache: Cache, index: Record<string, string>) =>
  cache.put(INDEX, new Response(JSON.stringify(index), { headers: { 'Content-Type': 'application/json' } }));

/** Slugs available offline. */
export async function cachedSlugs(): Promise<Set<string>> {
  if (!supported) return new Set();
  try { return new Set(Object.keys(await readIndex(await caches.open(PAGES)))); } catch { return new Set(); }
}

let running: Promise<void> | null = null;
let pending: LibraryItem[] | null = null;

/** Make the cache match `library` (the authoritative list from the server). Calls made during a sync are coalesced. */
export function syncLibrary(library: LibraryItem[]): Promise<void> {
  if (!supported) return Promise.resolve();
  pending = library;
  running ??= (async () => {
    try { while (pending) { const l = pending; pending = null; await doSync(l); } } catch { /* try again on the next refresh */ } finally { running = null; }
  })();
  return running;
}

async function doSync(library: LibraryItem[]) {
  const cache = await caches.open(PAGES);
  const index = await readIndex(cache);
  const want = new Map(library.filter((e) => e.htmlBytes).map((e) => [e.slug, e.updatedAt]));
  let changed = false;
  for (const slug of Object.keys(index)) {
    if (want.has(slug)) continue;
    await cache.delete(`/e/${slug}/`);
    delete index[slug];
    changed = true;
  }
  const todo = [...want].filter(([slug, updatedAt]) => index[slug] !== updatedAt);
  for (let i = 0; i < todo.length; i += 3) {
    await Promise.all(todo.slice(i, i + 3).map(async ([slug, updatedAt]) => {
      try {
        const res = await fetch(`/e/${slug}/`, { ...SYNC, cache: 'reload' });
        if (!res.ok) return;
        await cache.put(`/e/${slug}/`, res);
        index[slug] = updatedAt;
        changed = true;
      } catch { /* offline or a build in progress: retried on the next sync */ }
    }));
  }
  if (changed) await writeIndex(cache, index);
}
