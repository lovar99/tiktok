const CACHE_NAME = 'tiktok-tracker-v1';
const ASSETS = [
    './index.html',
    './login.html',
    './manifest.json',
    './icon.svg'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

self.addEventListener('fetch', (e) => {
    // Network-first strategy for live dashboard to ensure fresh data
    e.respondWith(
        fetch(e.request).catch(() => caches.match(e.request))
    );
});