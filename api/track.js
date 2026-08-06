const ALLOWED_TABS = new Set(['name', 'saju', 'today', 'sajuCompat', 'zodiac', 'blood', 'mbti', 'combo']);
const LOG_MAX = 200;

async function redisCmd(url, token, cmd) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return r.json();
}

function safeName(s) {
  return typeof s === 'string' ? s.trim().slice(0, 20) : '';
}

function safeVid(s) {
  return typeof s === 'string' ? s.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40) : '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    res.status(500).json({ error: 'not configured' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const event = body && body.event;
  const tab = body && body.tab;
  const n1 = safeName(body && body.name1);
  const n2 = safeName(body && body.name2);
  const v = safeVid(body && body.v);

  const today = new Date().toISOString().slice(0, 10);
  const incrKeys = [];
  const uniqueKeys = [];
  if (event === 'pageview') {
    incrKeys.push('stats:visits:total', `stats:visits:${today}`);
    // 방문 횟수(페이지뷰)와는 별개로, 같은 방문자 ID가 여러 번 봐도 한 번만 세는
    // 고유 방문자 수는 SET에 SADD해두고 SCARD로 집계한다(중복 추가는 자동 무시됨).
    if (v) uniqueKeys.push('stats:uniques:total', `stats:uniques:${today}`);
  } else if (event === 'tab_action' && ALLOWED_TABS.has(tab)) {
    incrKeys.push(`stats:tab:${tab}`, `stats:tab:${tab}:${today}`);
  } else {
    res.status(400).json({ error: 'invalid event' });
    return;
  }

  try {
    await Promise.all(incrKeys.map((key) => redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['INCR', key])));
    await Promise.all(uniqueKeys.map((key) => redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['SADD', key, v])));

    if (event === 'tab_action' && (n1 || n2)) {
      const entry = JSON.stringify({ tab, n1, n2, t: Date.now(), v });
      await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['LPUSH', 'stats:log', entry]);
      await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['LTRIM', 'stats:log', '0', String(LOG_MAX - 1)]);
    }

    // 두 사람 이름이 다 있는 궁합(이름/사주궁합/별자리/혈액형/MBTI/종합)만 "인기 조합"으로
    // 집계한다. stats:log는 최근 200건만 남기지만, 이 정렬 집합(sorted set)은 전체 누적이라
    // 서비스 오픈 이후 가장 많이 확인된 이름 조합을 언제든 순위로 조회할 수 있다.
    if (event === 'tab_action' && n1 && n2) {
      await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['ZINCRBY', 'stats:pairs', '1', `${n1}|${n2}`]);
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
}
