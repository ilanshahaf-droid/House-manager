const CACHE_NAME = 'household-app-v29';
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

// ---- Push notifications: "someone added items to a shared list" ----
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = wins.filter((c) => c.visibilityState === 'visible');
    if (visible.length && d.row_id) {
      // the app is open on screen — let it show its own small message instead of a system notification
      visible.forEach((c) => c.postMessage({ type: 'push-added', data: d }));
      return;
    }
    await self.registration.showNotification(d.title || 'ניהול משק בית', {
      body: d.body || '',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      dir: 'rtl',
      lang: 'he',
      tag: d.tag || undefined,
      renotify: !!d.tag,
      data: { url: d.url || './', row_id: d.row_id || null, list_id: d.list_id || null }
    });
  })());
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = new URL(data.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const c = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (!c) return self.clients.openWindow(url);
    try { await c.focus(); } catch (e) {}
    if (!data.list_id) return;
    // ask the open app to show the list; if it doesn't answer (frozen in the background), load the list's address
    const answered = await new Promise((resolve) => {
      const ch = new MessageChannel();
      const t = setTimeout(() => resolve(false), 1500);
      ch.port1.onmessage = () => { clearTimeout(t); resolve(true); };
      try { c.postMessage({ type: 'open-list', row_id: data.row_id, list_id: data.list_id }, [ch.port2]); } catch (e) { clearTimeout(t); resolve(false); }
    });
    if (!answered && 'navigate' in c) { try { await c.navigate(url); } catch (e) { return self.clients.openWindow(url); } }
  })());
});
