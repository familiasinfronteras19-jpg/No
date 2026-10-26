// Service worker mínimo para que la versión web se pueda instalar y abrir sin conexión (solo archivos de la app)
const CACHE = 'tareas-v1';
const ARCHIVOS = ['index.html', 'style.css', 'app.js', 'icon.png', 'manifest.json'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS)));
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    // La hoja de cálculo siempre se pide a la red
    if (url.origin !== location.origin) return;
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
