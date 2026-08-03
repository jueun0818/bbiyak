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

async function getKey(baseUrl, token, key) {
  const r = await fetch(`${baseUrl}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await r.json();
  return Number(data.result) || 0;
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
    const totalVisits = await getKey(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, 'stats:visits:total');
    const dailyVisits = await Promise.all(
      days.map(async (d) => ({ date: d, count: await getKey(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, `stats:visits:${d}`) }))
    );
    const tabClicks = await Promise.all(
      TAB_KEYS.map(async (t) => ({
        tab: t,
        label: TAB_LABELS[t],
        count: await getKey(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, `stats:tab:${t}`),
      }))
    );
    tabClicks.sort((a, b) => b.count - a.count);

    res.status(200).json({ totalVisits, dailyVisits, tabClicks });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
}
