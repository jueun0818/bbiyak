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
const LOG_FETCH_COUNT = 50;

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

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  try {
    const totalVisitsRaw = await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['GET', 'stats:visits:total']);
    const totalVisits = Number(totalVisitsRaw) || 0;

    const dailyVisits = await Promise.all(
      days.map(async (d) => {
        const v = await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['GET', `stats:visits:${d}`]);
        return { date: d, count: Number(v) || 0 };
      })
    );

    const tabClicks = await Promise.all(
      TAB_KEYS.map(async (t) => {
        const v = await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['GET', `stats:tab:${t}`]);
        return { tab: t, label: TAB_LABELS[t], count: Number(v) || 0 };
      })
    );
    tabClicks.sort((a, b) => b.count - a.count);

    const rawLogs = await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['LRANGE', 'stats:log', '0', String(LOG_FETCH_COUNT - 1)]);
    const recentLogs = (rawLogs || [])
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean)
      .map((e) => ({ tab: e.tab, label: TAB_LABELS[e.tab] || e.tab, n1: e.n1 || '', n2: e.n2 || '', t: e.t, v: e.v || '' }));

    res.status(200).json({ totalVisits, dailyVisits, tabClicks, recentLogs });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
}
