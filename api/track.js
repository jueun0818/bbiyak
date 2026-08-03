const ALLOWED_TABS = new Set(['name', 'saju', 'today', 'sajuCompat', 'zodiac', 'blood', 'mbti', 'combo']);

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

  const keys = [];
  if (event === 'pageview') {
    const today = new Date().toISOString().slice(0, 10);
    keys.push('stats:visits:total', `stats:visits:${today}`);
  } else if (event === 'tab_action' && ALLOWED_TABS.has(tab)) {
    keys.push(`stats:tab:${tab}`);
  } else {
    res.status(400).json({ error: 'invalid event' });
    return;
  }

  try {
    await Promise.all(keys.map((key) =>
      fetch(`${UPSTASH_REDIS_REST_URL}/incr/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
      })
    ));
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
}
