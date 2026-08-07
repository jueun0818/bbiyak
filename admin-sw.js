// ============================================================
// 삐약궁합 관리자 서비스 워커 (index.html용 sw.js와 별개, 캐시도 분리)
// - 통계는 항상 최신이어야 하므로 /api/* 요청은 절대 캐시하지 않고 네트워크로 그대로 흘려보냄
// - 페이지(admin.html)만 네트워크 우선 + 오프라인 폴백으로 캐시
// 파일 내용을 고칠 때마다 VERSION을 올리면 기존 방문자에게 업데이트 배너가 뜬다.
// ============================================================
const VERSION = 'v1.0.7';
const CACHE_NAME = 'ppiyak-admin-' + VERSION;
const CACHE_PREFIX = 'ppiyak-admin-';

const PRECACHE_URLS = [
  './admin.html',
  './admin-manifest.webmanifest',
  './icons/admin-icon-192.png',
  './icons/admin-icon-512.png',
  './icons/admin-icon-maskable-192.png',
  './icons/admin-icon-maskable-512.png',
  './icons/admin-apple-touch-icon.png',
  './icons/admin-favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: 'reload' })));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (e) { /* 미지원 브라우저는 무시 */ }
    }
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === 'SKIP_WAITING' || (data && data.type === 'SKIP_WAITING')) self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // 통계 API는 항상 최신 데이터로 (캐시하지 않음)

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigate(event));
    return;
  }
  event.respondWith(handleAsset(event));
});

// 페이지 요청: 네트워크 우선 → 오프라인이면 캐시된 admin.html
async function handleNavigate(event) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const preloaded = await event.preloadResponse;
    const res = preloaded || await fetch(event.request);
    if (res && res.ok && res.type === 'basic') {
      cache.put('./admin.html', res.clone());
    }
    return res;
  } catch (e) {
    const cached = await cache.match('./admin.html');
    if (cached) return cached;
    return new Response(
      '<!DOCTYPE html><html lang="ko"><meta charset="utf-8"><title>오프라인</title>' +
      '<body style="font-family:sans-serif;text-align:center;padding:60px 20px;background:#f6f5f2">' +
      '<p style="font-size:56px;margin:0">🐥</p><h1 style="font-size:20px">아직 오프라인이에요</h1>' +
      '<p style="color:#767686">인터넷에 한 번 연결하면 다음부터는 오프라인에서도 열려요.</p></body></html>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

// 정적 파일: 캐시를 바로 내주고, 뒤에서 조용히 새 사본을 받아둠
async function handleAsset(event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(event.request, { ignoreSearch: true });

  const fromNetwork = fetch(event.request)
    .then((res) => {
      if (res && res.ok && res.type === 'basic') cache.put(event.request, res.clone());
      return res;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(fromNetwork);
    return cached;
  }
  const res = await fromNetwork;
  return res || new Response('오프라인 상태입니다.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
