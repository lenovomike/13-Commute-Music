'use strict';

const CACHE = 'commute-music-shell-v3';
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon.svg', './icon-maskable-512.png'];
const shellUrls = new Set(SHELL.map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL.map(path => new Request(new URL(path, self.registration.scope), { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('commute-music-shell-') && key !== CACHE).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match(new URL('./index.html', self.registration.scope))));
  } else if (shellUrls.has(url.href)) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
  }
});

// Refresh only the app shell; the music library lives separately in IndexedDB.
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
  if (event.data?.type === 'REFRESH_SHELL') {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(CACHE);
        await cache.addAll(SHELL.map(path => new Request(new URL(path, self.registration.scope), { cache: 'reload' })));
        event.ports[0]?.postMessage({ ok: true });
      } catch (error) {
        event.ports[0]?.postMessage({ ok: false, error: error.message });
      }
    })());
  }
});
