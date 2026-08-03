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

  const incrKeys = [];
  if (event === 'pageview') {
    const today = new Date().toISOString().slice(0, 10);
    incrKeys.push('stats:visits:total', `stats:visits:${today}`);
  } else if (event === 'tab_action' && ALLOWED_TABS.has(tab)) {
    incrKeys.push(`stats:tab:${tab}`);
  } else {
    res.status(400).json({ error: 'invalid event' });
    return;
  }

  try {
    await Promise.all(incrKeys.map((key) => redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['INCR', key])));

    if (event === 'tab_action' && (n1 || n2)) {
      const entry = JSON.stringify({ tab, n1, n2, t: Date.now(), v });
      await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['LPUSH', 'stats:log', entry]);
      await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['LTRIM', 'stats:log', '0', String(LOG_MAX - 1)]);
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
}
