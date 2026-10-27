const CACHE_NAME = 'eink-tasks-v7';
const ASSETS = [
  './',
  './index.html',
  './style.css?v=7',
  './app.js?v=7',
  './manifest.json?v=7',
  './icon.svg',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Ignora requisições de outros domínios (API Todoist, Google Fonts, etc.)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // Não intercepta /todo sem barra final para deixar o navegador seguir o redirect 301 nativo
  if (url.pathname.endsWith('/todo')) {
    return;
  }

  // Estratégia Network-First com cache: 'no-cache' para nunca ficar preso no cache antigo
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then(response => {
        if (response && response.status === 200 && !response.redirected) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
