// Offline support: app files are served network-first so updates show up right
// away, with the cached copy used when there's no signal (e.g. in the kitchen).
// API calls and other sites are never cached, except the Firebase SDK (versioned, so
// safe to keep), which the app needs before it can open.
const CACHE = 'recipe-book-v2';
const FILES = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/ai.js',
  'js/defaults.js',
  'js/firebase-config.js',
  'js/firebase-store.js',
  'js/importers.js',
  'js/settings.js',
  'js/store.js',
  'manifest.webmanifest',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  // Keep the version in step with SDK in js/firebase-store.js.
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const firebaseSdk = url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/');
  if (e.request.method !== 'GET' || (url.origin !== location.origin && !firebaseSdk)) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
