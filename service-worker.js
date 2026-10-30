const CACHE_NAME = 'household-app-v7';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './data.js',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './quick-add.html',
  './quickadd-manifest.json',
  './quickadd-icon-192.png',
  './quickadd-icon-512.png',
  './quickadd-icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch(() => { /* optional asset missing is fine */ })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Network-first for same-origin GET so updates land quickly when online.
// {cache:'no-store'} bypasses the browser HTTP cache (important on GitHub Pages).
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => {
          if (cached) return cached;
          // SPA-style fallback for navigation
          if (event.request.mode === 'navigate') return caches.match('./index.html');
          return undefined;
        })
      )
  );
});
