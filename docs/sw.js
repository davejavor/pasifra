// Minimální service worker: network-first pro vše ze stejného originu, cache jen jako záloha při výpadku.
// 20261113205756 doplní build.mjs (docs/sw.js), takže se název cache změní s každým buildem a stará cache se smaže.
const CACHE = 'pasifra-20261113205756';
const TIMEOUT_MS = 4000;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

const HOME = () => new URL('./', self.registration.scope).href;

async function fromCache(req) {
  try {
    // Odkaz týmu má jiné ?t=, ale HTML je pořád stejné.
    return (await caches.match(req.url)) || (req.mode === 'navigate' && (await caches.match(HOME()))) || Response.error();
  } catch {
    return Response.error();
  }
}

async function networkFirst(req) {
  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    // no-cache: vždy revalidace, ať se oprava nezasekne v HTTP cache (Pages: max-age 10 min)
    res = await fetch(req.url, { cache: 'no-cache', signal: ctrl.signal });
    clearTimeout(timer);
  } catch {
    return fromCache(req);
  }
  if (res.ok) {
    // Selhání cache nesmí pokazit odpověď ze sítě.
    try {
      const c = await caches.open(CACHE);
      await c.put(req.url, res.clone());
      if (req.mode === 'navigate') await c.put(HOME(), res.clone());
    } catch { /* bez zálohy */ }
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(networkFirst(req));
});
