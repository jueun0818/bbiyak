const TAB_KEYS = ['name', 'saju', 'today', 'sajuCompat', 'zodiac', 'blood', 'mbti', 'combo'];
const TAB_LABELS = {
  name: '이름 궁합',
  saju: '사주팔자',
  today: '오늘의 운세',
  sajuCompat: '사주 궁합',
  zodiac: '별자리 궁합',
  blood: '혈액형 궁합',
  mbti: 'MBTI 궁합',
  combo: '종합 궁합',
};
// track.js가 stats:log에 최대 200건까지만 남기므로(LOG_MAX), 그만큼 전부 가져와서
// 관리자 화면에서 "더보기"로 펼쳐볼 수 있게 한다.
const LOG_FETCH_COUNT = 200;

async function redisCmd(url, token, cmd) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const data = await r.json();
  return data.result;
}

export default async function handler(req, res) {
  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ADMIN_PASSWORD } = process.env;
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN || !ADMIN_PASSWORD) {
    res.status(500).json({ error: 'not configured' });
    return;
  }

  const password = (req.method === 'POST' ? req.body && req.body.password : req.query.password) || '';
  if (password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const TREND_DAYS = 30;
  const days = [];
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const todayKey = days[days.length - 1];
  const yesterdayKey = days[days.length - 2];

  try {
    const totalVisitsRaw = await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['GET', 'stats:visits:total']);
    const totalVisits = Number(totalVisitsRaw) || 0;

    // 방문 횟수(페이지뷰 총합)와 달리, 방문자 수는 같은 사람이 여러 번 봐도 한 번만 센다
    // (SET의 카디널리티 = SCARD).
    const totalVisitorsRaw = await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['SCARD', 'stats:uniques:total']);
    const totalVisitors = Number(totalVisitorsRaw) || 0;
    const todayVisitorsRaw = await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['SCARD', `stats:uniques:${todayKey}`]);
    const todayVisitors = Number(todayVisitorsRaw) || 0;

    // 재방문율: "오늘 방문자" 집합과 "어제 방문자" 집합의 교집합 크기를 오늘 방문자 수로
    // 나눈 값이다. 두 집합 다 pageview 때 SADD로 이미 쌓이고 있어 추가 추적 없이 계산된다.
    const returningRaw = await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['SINTER', `stats:uniques:${todayKey}`, `stats:uniques:${yesterdayKey}`]);
    const returningToday = Array.isArray(returningRaw) ? returningRaw.length : 0;
    const retentionRate = todayVisitors > 0 ? returningToday / todayVisitors : 0;

    const dailyVisits = await Promise.all(
      days.map(async (d) => {
        const v = await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['GET', `stats:visits:${d}`]);
        return { date: d, count: Number(v) || 0 };
      })
    );

    const tabClicks = await Promise.all(
      TAB_KEYS.map(async (t) => {
        const [v, todayV] = await Promise.all([
          redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['GET', `stats:tab:${t}`]),
          redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['GET', `stats:tab:${t}:${todayKey}`]),
        ]);
        return { tab: t, label: TAB_LABELS[t], count: Number(v) || 0, todayCount: Number(todayV) || 0 };
      })
    );
    tabClicks.sort((a, b) => b.count - a.count);

    // 인기 조합 랭킹: stats:log(최근 200건)와 달리 서비스 오픈 이후 전체 누적 집계라,
    // "역대 가장 많이 확인된 이름 조합" 순위를 정확히 보여준다.
    const topPairsRaw = await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['ZREVRANGE', 'stats:pairs', '0', '9', 'WITHSCORES']);
    const topPairs = [];
    for (let i = 0; i < (topPairsRaw || []).length; i += 2) {
      const member = topPairsRaw[i];
      const score = Number(topPairsRaw[i + 1]) || 0;
      const sep = member.indexOf('|');
      if (sep === -1) continue;
      topPairs.push({ n1: member.slice(0, sep), n2: member.slice(sep + 1), count: score });
    }

    const rawLogs = await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['LRANGE', 'stats:log', '0', String(LOG_FETCH_COUNT - 1)]);
    const recentLogs = (rawLogs || [])
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean)
      .map((e) => ({ tab: e.tab, label: TAB_LABELS[e.tab] || e.tab, n1: e.n1 || '', n2: e.n2 || '', t: e.t, v: e.v || '' }));

    res.status(200).json({
      totalVisits, totalVisitors, todayVisitors, retentionRate, returningToday,
      dailyVisits, tabClicks, topPairs, recentLogs,
    });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
}
