// ============================================================
// 삐약궁합 서비스 워커
// - 앱은 index.html 한 장으로 끝나므로, 그 한 장 + 아이콘만 캐시하면 완전 오프라인 동작
// - 페이지: 네트워크 우선(새 버전 즉시 반영) → 실패 시 캐시 (지하철/비행기 모드에서도 열림)
// - 정적 파일: 캐시 우선 + 백그라운드 갱신(stale-while-revalidate)
// 파일 내용을 고칠 때마다 VERSION을 올리면 기존 방문자에게 업데이트 배너가 뜬다.
// ============================================================
const VERSION = 'v1.3.1';
const CACHE_NAME = 'ppiyak-' + VERSION;
const CACHE_PREFIX = 'ppiyak-';

// 설치 시점에 미리 받아둘 파일 (하나라도 실패하면 설치 실패 → 배포 누락을 바로 알 수 있음)
const PRECACHE_URLS = [
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/og-image.jpg',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // cache: 'reload' 로 받아 브라우저 HTTP 캐시의 옛 사본이 그대로 굳어버리는 것을 방지
    await cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: 'reload' })));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 내비게이션 프리로드: 페이지 요청을 서비스 워커 부팅과 동시에 시작해 첫 진입 지연을 줄임
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

// 페이지에서 '새로고침'을 눌렀을 때 대기 중인 새 워커를 즉시 활성화
self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === 'SKIP_WAITING' || (data && data.type === 'SKIP_WAITING')) self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 외부 도메인 요청은 브라우저에 그대로 맡김

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigate(event));
    return;
  }
  event.respondWith(handleAsset(event));
});

// 페이지 요청: 네트워크 우선 → 오프라인이면 캐시된 index.html
// (start_url이 ./?source=pwa 처럼 쿼리가 붙어도 항상 index.html 사본으로 응답)
async function handleNavigate(event) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const preloaded = await event.preloadResponse;
    const res = preloaded || await fetch(event.request);
    if (res && res.ok && res.type === 'basic') {
      cache.put('./index.html', res.clone());
    }
    return res;
  } catch (e) {
    const cached = await cache.match('./index.html');
    if (cached) return cached;
    return new Response(
      '<!DOCTYPE html><html lang="ko"><meta charset="utf-8"><title>오프라인</title>' +
      '<body style="font-family:sans-serif;text-align:center;padding:60px 20px;background:#fff9db">' +
      '<p style="font-size:56px;margin:0">🐥</p><h1 style="font-size:20px">아직 오프라인이에요</h1>' +
      '<p style="color:#8a6d1a">인터넷에 한 번 연결하면 다음부터는 오프라인에서도 열려요.</p></body></html>',
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
    event.waitUntil(fromNetwork); // 응답은 캐시로 즉시, 갱신은 워커가 살아있는 동안 계속
    return cached;
  }
  const res = await fromNetwork;
  return res || new Response('오프라인 상태입니다.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
