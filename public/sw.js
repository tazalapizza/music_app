// App-shell service worker: caches the static UI (HTML/CSS/JS/icons/manifest)
// so the app can load while offline. Everything under /api/ is left to the
// network — that's dynamic library data, not the shell.
//
// Stale-while-revalidate, not cache-first: every shell request is answered
// from the cache instantly (so offline still works and nothing waits on the
// network), but a network fetch always runs alongside it to refresh the
// cache for next time. That means a normal deploy just needs a reload (or
// even just leaving a tab open - the next navigation picks up the refreshed
// cache) to show up, without also having to remember to bump a cache-name
// constant here on every change the way cache-first would've required.
const CACHE_NAME = 'vibing-shell';

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico',
  '/favicon.svg',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/css/base.css',
  '/css/context-menu-modal.css',
  '/css/filelist.css',
  '/css/landscape-albums.css',
  '/css/lyrics.css',
  '/css/metadata-editor.css',
  '/css/player.css',
  '/css/responsive.css',
  '/css/settings.css',
  '/css/sidebar-queue-playlists.css',
  '/css/toast.css',
  '/css/topbar.css',
  '/css/uploads.css',
  '/js/albums-carousel.js',
  '/js/browse.js',
  '/js/controls.js',
  '/js/filelist.js',
  '/js/filemanagement.js',
  '/js/layout-init.js',
  '/js/metadata-editor.js',
  '/js/native-audio-adapter.js',
  '/js/offline-downloads.js',
  '/js/panel-tabs.js',
  '/js/playback.js',
  '/js/queue-playlists.js',
  '/js/selection.js',
  '/js/settings-auth-toast-lyrics.js',
  '/js/state.js',
  '/js/system-volume-adapter.js',
  '/js/uploads.js',
  '/js/vendor-signalsmith-stretch.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  // Without this, a newly-installed worker sits "waiting" behind the one
  // still controlling open tabs until every tab is fully closed and
  // reopened - a plain reload isn't enough. Activating immediately (paired
  // with the controllerchange-triggered reload in index.html) means a
  // reload alone picks up the new shell instead.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Cleans up caches left behind by the old cache-first version of this
  // file, which had to bump CACHE_NAME (vibing-shell-v1, -v2, ...) on every
  // change - harmless to keep running indefinitely since it's a no-op once
  // those are gone.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      const networkFetch = fetch(request).then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      }).catch(() => null);
      // Cached copy answers immediately when there is one (this is what
      // makes offline startup work); the network fetch above still runs in
      // the background to refresh the cache for the next load. With no
      // cached copy yet (first-ever visit, or a file added since), fall
      // back to waiting on the network fetch itself.
      return cached || (await networkFetch) || caches.match('/index.html');
    })
  );
});
