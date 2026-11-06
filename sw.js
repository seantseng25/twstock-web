// 網頁版離線快取：程式檔先抓網路（有新版就更新），沒網路時用快取。資料檔由 App 自己存在 IndexedDB，這裡不處理。
const CACHE = 'twstock-shell';
const SHELL = ['./', 'index.html', 'style.css', 'engine.js', 'app.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 資料檔、Android 安裝檔（app/）和下載頁不經過快取
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/data/') || url.pathname.includes('/app/') || url.pathname.endsWith('android.html')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
