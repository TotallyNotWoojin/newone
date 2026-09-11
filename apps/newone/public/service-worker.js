const SHELL_CACHE = 'gist-shell-v1';
const ASSET_CACHE = 'gist-public-assets-v1';
const APPROVED_SHELL_ASSETS = new Set([
  '/offline.html',
  '/manifest.json',
  '/gist-icon-192.png',
  '/gist-icon-512.png',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(async (cache) => {
        await cache.addAll([...APPROVED_SHELL_ASSETS]);
        const shell = await fetch(new Request('/', {
          cache: 'reload',
          credentials: 'omit',
        }));
        if (
          shell.ok
          && shell.type === 'basic'
          && shell.headers.get('content-type')?.toLowerCase().includes('text/html')
        ) {
          await cache.put('/', shell);
        }
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          // The newone-* prefixes are the pre-rename caches. A returning
          // visitor still holds them, so they have to be swept here or the old
          // shell and the old icons stay on their device for good.
          .filter((name) => (
            ((name.startsWith('gist-shell-') || name.startsWith('newone-shell-')) && name !== SHELL_CACHE)
            || ((name.startsWith('gist-public-assets-') || name.startsWith('newone-public-assets-')) && name !== ASSET_CACHE)
          ))
          .map((name) => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  );
});

function networkOnlyNoStore(request) {
  return fetch(new Request(request, { cache: 'no-store' }));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // API, identity-provider, Realtime, attachment, and any other cross-origin traffic
  // is network-only and never enters the service-worker Cache API.
  if (url.origin !== self.location.origin) {
    event.respondWith(networkOnlyNoStore(request));
    return;
  }
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    event.respondWith(networkOnlyNoStore(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      networkOnlyNoStore(request).catch(async () => (
        await caches.match('/') ?? await caches.match('/offline.html')
      )),
    );
    return;
  }

  if (APPROVED_SHELL_ASSETS.has(url.pathname)) {
    event.respondWith(
      caches.match(request).then(async (cached) => {
        if (cached) return cached;
        const response = await networkOnlyNoStore(request);
        if (response.ok && response.type === 'basic') {
          const cache = await caches.open(SHELL_CACHE);
          await cache.put(request, response.clone());
        }
        return response;
      }),
    );
    return;
  }

  // Expo's hashed application code is public release material. Caching only this
  // path lets an installed client boot offline without ever caching API traffic,
  // identity responses, message data, attachments, or arbitrary same-origin URLs.
  if (
    url.pathname.startsWith('/_expo/')
    && ['script', 'style', 'font', 'image'].includes(request.destination)
  ) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await networkOnlyNoStore(request);
        if (response.ok && response.type === 'basic') {
          await cache.put(request, response.clone());
        }
        return response;
      }),
    );
    return;
  }

  // Employee data and arbitrary HTML/assets remain network-only. Offline state lives
  // only in Gist's encrypted client store, never the service-worker cache.
  event.respondWith(networkOnlyNoStore(request));
});
