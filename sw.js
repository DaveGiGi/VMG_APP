// Service worker: makes the app work offline.
// - App files: network first (so updates arrive), cache as fallback.
// - Map tiles: cache first, then network (areas viewed before work offline).
const APP_CACHE = 'vmg-app-v4';
const TILE_CACHE = 'vmg-tiles-v1';
const MAX_TILES = 3000;

const APP_FILES = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/nav.js',
  'js/route.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![APP_CACHE, TILE_CACHE].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isTile = (url) => /tile\.openstreetmap\.org|tiles\.openseamap\.org/.test(url.hostname);

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.hostname.includes('nominatim')) return; // never cache search

  if (isTile(url)) {
    e.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) {
          cache.put(e.request, res.clone());
          trimTiles(cache);
        }
        return res;
      }),
    );
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(APP_CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});

async function trimTiles(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}
