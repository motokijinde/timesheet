const CACHE_VERSION = 'v1.04';
const CACHE_NAME = `timesheet-v${CACHE_VERSION}`;

const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './manifest.json',
    './icon.png'
];

// インストール処理
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(ASSETS_TO_CACHE))
            .then(() => self.skipWaiting())
    );
});

// アクティベート処理
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
        .then(() => self.clients.claim())
    );
});

// フェッチ処理
self.addEventListener('fetch', (event) => {
    // GASのAPIリクエストはキャッシュしない
    if (event.request.url.includes('script.google.com/macros')) {
        event.respondWith(
            fetch(event.request).catch(() => {
                // オフライン時は空のResponseを返す
                return new Response('', { status: 503, statusText: 'Service Unavailable' });
            })
        );
        return;
    }

    // その他のリクエストはキャッシュ優先
    event.respondWith(
        caches.match(event.request)
            .then((response) => {
                return response || fetch(event.request);
            })
    );
});
