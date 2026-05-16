/**
 * 勤務報告アプリ - Service Worker
 *
 * 戦略:
 *   - GAS API (script.google.com/macros): キャッシュしない (network-only)。
 *     オフライン時は { ok: false, error: 'offline' } の JSON を返してフロント側でフォールバック処理させる。
 *   - HTML ナビゲーション (index.html): network-first。
 *     最新のスクリプトタグを取りに行きたいので、必ずネットワーク優先。失敗時のみキャッシュ。
 *   - その他のアセット (script.js / style.css / icon.png 等): stale-while-revalidate。
 *     キャッシュを即返しつつバックグラウンドで更新。 修正がユーザーに自動で行き渡る。
 *
 * バージョン管理:
 *   静的アセットを変更したら CACHE_VERSION をバンプして古いキャッシュを掃除する。
 *   フロント (script.js) で controllerchange を購読しているため、
 *   新 SW がアクティブになった瞬間に自動リロードされる。
 */

const CACHE_VERSION = '2.0.2';
const CACHE_NAME = `timesheet-v${CACHE_VERSION}`;

const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './manifest.json',
    './icon.png',
];

// インストール: アセットを事前キャッシュして即時 waiting 解除
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(ASSETS_TO_CACHE))
            .then(() => self.skipWaiting())
    );
});

// アクティベート: 古いバージョンのキャッシュを掃除し、開いているクライアントを乗っ取る
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(
                names
                    .filter((n) => n !== CACHE_NAME)
                    .map((n) => caches.delete(n))
            ))
            .then(() => self.clients.claim())
    );
});

// リクエスト処理
self.addEventListener('fetch', (event) => {
    const { request } = event;

    // 1) GAS API はキャッシュしない (network-only + offline JSON fallback)
    if (request.url.includes('script.google.com/macros')) {
        event.respondWith(
            fetch(request).catch(() =>
                new Response(
                    JSON.stringify({ ok: false, error: 'offline' }),
                    {
                        status: 503,
                        statusText: 'Offline',
                        headers: { 'Content-Type': 'application/json' },
                    }
                )
            )
        );
        return;
    }

    // 2) HTML ナビゲーションは network-first
    //    バグ修正がすぐ届くようネットワーク優先で取得し、失敗時のみキャッシュにフォールバック
    if (request.mode === 'navigate' || request.destination === 'document') {
        event.respondWith((async () => {
            try {
                const fresh = await fetch(request);
                const cache = await caches.open(CACHE_NAME);
                cache.put(request, fresh.clone()); // ベストエフォートで更新
                return fresh;
            } catch (_) {
                const cached = await caches.match(request);
                return cached || new Response('Offline', { status: 503 });
            }
        })());
        return;
    }

    // 3) その他のアセットは stale-while-revalidate
    //    まずキャッシュを返して描画は速く、裏でネットワークから最新を取って更新する
    event.respondWith(caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        const fetchPromise = fetch(request)
            .then((res) => {
                if (res && res.ok) cache.put(request, res.clone());
                return res;
            })
            .catch(() => cached); // ネットワーク失敗時はキャッシュを返す
        return cached || fetchPromise;
    }));
});
