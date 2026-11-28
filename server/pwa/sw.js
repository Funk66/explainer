// Service worker: makes the library usable offline. Plain JS (browsers load it directly; it is not part of the Astro build).
//   - app shell (/, manifest, icons) and the library JSON: network first, cached copy when offline or slow
//   - explainer pages (/e/<slug>/): cache first. The page keeps that cache in sync with the server (src/app/offline.ts),
//     so it holds every explainer, and deleted ones are removed.
// Cached responses keep their headers, including the sandboxing Content-Security-Policy of explainer pages.
const APP = 'app-v1';
const PAGES = 'explainers-v1'; // also used by src/app/offline.ts
const SLOW_MS = 4000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== APP && k !== PAGES) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('x-offline-sync')) return; // sync requests must reach the server
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const p = url.pathname;
  if (p === '/' || p === '/api/explainers' || p === '/api/config' || p === '/manifest.webmanifest' || p.startsWith('/icons/')) {
    event.respondWith(networkFirst(event, APP));
  } else if (/^\/e\/[a-z0-9-]+\/?$/.test(p)) {
    event.respondWith(cacheFirst(req, p.endsWith('/') ? p : `${p}/`));
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The cached copy, flagged so the UI can tell it is not live data. */
function flagged(res) {
  const headers = new Headers(res.headers);
  headers.set('X-Served-From-Cache', '1');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function networkFirst(event, cacheName) {
  const req = event.request;
  const cache = await caches.open(cacheName);
  const key = new URL(req.url).pathname;
  const cached = await cache.match(key);
  const net = fetch(req).then((res) => {
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (res.ok) event.waitUntil(cache.put(key, res.clone()));
    return res;
  });
  if (!cached) return net;
  net.catch(() => {}); // when the cache wins the race, a later failure is irrelevant
  return Promise.race([net.catch(() => flagged(cached)), sleep(SLOW_MS).then(() => flagged(cached))]);
}

async function cacheFirst(req, key) {
  const hit = await (await caches.open(PAGES)).match(key);
  return hit ?? fetch(req);
}
