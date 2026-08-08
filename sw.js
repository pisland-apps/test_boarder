// Border Day Ledger — offline app-shell cache
// Bump CACHE_NAME (e.g. v1 -> v2) whenever index.html or any file in
// APP_SHELL changes, and upload index.html + sw.js together — otherwise
// returning visitors may keep seeing the old cached version.
//
// This does NOT sync automatically with APP_VERSION / APP_VERSION_DATE
// near the top of the inline <script> in index.html (the small version
// badge shown bottom-right, even on the lock screen) — they live in
// different files. Bump BOTH by hand on every deploy. See the deploy
// checklist in README.md.
const CACHE_NAME = 'border-day-ledger-cache-v10';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if(req.method !== 'GET') return;

  const url = new URL(req.url);

  if(url.origin === self.location.origin){
    // app shell: cache-first, refresh the cache in the background when online
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req).then((res) => {
          if(res && res.ok){
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // cross-origin (e.g. the JSZip library from cdnjs): network-first,
  // falling back to a cached copy so ZIP export/import still works offline
  // once it has been loaded successfully at least once
  event.respondWith(
    fetch(req).then((res) => {
      if(res && res.ok){
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
      }
      return res;
    }).catch(() => caches.match(req))
  );
});
