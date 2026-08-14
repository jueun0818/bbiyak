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

// 방문자 수 집계(stats:uniques:*)와 기능별 "오늘" 집계(stats:tab:{tab}:{date})를
// 나중에 추가했기 때문에, 그 이전 활동에는 반영된 기록이 없다. stats:log(궁합 기능을
// 한 번이라도 눌러본 최근 기록, 최대 200건)에서 방문자 ID와 오늘 치 기능별 클릭 수를
// 모아 소급 반영한다. 궁합을 눌러본 적 없는 순수 방문은 로그 자체가 없어 복구가
// 불가능하므로, 이건 정확한 전체 값이 아니라 "복구 가능한 만큼"의 근사치다.
async function backfillVisitors(url, token, res) {
  const LOG_KEY = 'stats:log';
  try {
    const rawLogs = await redisCmd(url, token, ['LRANGE', LOG_KEY, '0', '-1']);
    const entries = (rawLogs || [])
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter((e) => e && e.t);

    const totalSet = new Set();
    const byDate = new Map();
    entries.forEach((e) => {
      if (!e.v) return;
      totalSet.add(e.v);
      const date = new Date(e.t).toISOString().slice(0, 10);
      if (!byDate.has(date)) byDate.set(date, new Set());
      byDate.get(date).add(e.v);
    });

    const cmds = [];
    totalSet.forEach((v) => cmds.push(['SADD', 'stats:uniques:total', v]));
    byDate.forEach((set, date) => {
      set.forEach((v) => cmds.push(['SADD', `stats:uniques:${date}`, v]));
    });

    // 오늘 치 "기능별 조회수"도 오늘 새로 도입됐으므로, 배포 전에 이미 있었던
    // 오늘의 클릭은 stats:tab:{tab}:{date} 카운터에 반영이 안 되어 있다. 로그에서
    // 오늘 날짜분만 세어 채워 넣되, SET ... NX로 "키가 아직 없을 때만" 채워서
    // 실시간 카운트를 덮어쓰거나 버튼을 여러 번 눌러 중복 집계되는 일을 막는다.
    const todayKey = new Date().toISOString().slice(0, 10);
    const todayTabCounts = new Map();
    entries.forEach((e) => {
      const date = new Date(e.t).toISOString().slice(0, 10);
      if (date !== todayKey || !e.tab) return;
      todayTabCounts.set(e.tab, (todayTabCounts.get(e.tab) || 0) + 1);
    });
    await Promise.all(
      [...todayTabCounts.entries()].map(([tab, count]) =>
        redisCmd(url, token, ['SET', `stats:tab:${tab}:${todayKey}`, String(count), 'NX'])
      )
    );

    await Promise.all(cmds.map((c) => redisCmd(url, token, c)));

    res.status(200).json({
      ok: true,
      logEntries: entries.length,
      uniqueVisitorsFound: totalSet.size,
    });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
}

export default async function handler(req, res) {
  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ADMIN_PASSWORD } = process.env;
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN || !ADMIN_PASSWORD) {
    res.status(500).json({ error: 'not configured' });
    return;
  }

  let postBody = req.body;
  if (req.method === 'POST' && typeof postBody === 'string') {
    try { postBody = JSON.parse(postBody); } catch { postBody = {}; }
  }

  const password = (req.method === 'POST' ? postBody && postBody.password : req.query.password) || '';
  if (password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  // Vercel Hobby 플랜의 서버리스 함수 개수 제한 때문에 예전 backfill-visitors.js를
  // 이 파일의 POST 액션으로 합쳤다. 대시보드 읽기(GET)와는 무관한 일회성 관리 기능이다.
  if (req.method === 'POST' && postBody && postBody.action === 'backfill') {
    await backfillVisitors(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, res);
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

    const rawLogs = await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['LRANGE', 'stats:log', '0', String(LOG_FETCH_COUNT - 1)]);
    const recentLogs = (rawLogs || [])
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean)
      .map((e) => ({ tab: e.tab, label: TAB_LABELS[e.tab] || e.tab, n1: e.n1 || '', n2: e.n2 || '', t: e.t, v: e.v || '' }));

    res.status(200).json({
      totalVisits, totalVisitors, todayVisitors, retentionRate, returningToday,
      dailyVisits, tabClicks, recentLogs,
    });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
}
