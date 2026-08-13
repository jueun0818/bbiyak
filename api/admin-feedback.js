// 건의사항 목록 조회(GET) / 확인 처리・삭제(POST). 관리자 비밀번호 필요.
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

  if (req.method === 'GET') {
    try {
      const ids = await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['ZREVRANGE', 'feedback:ids', '0', '49']);
      const items = [];
      for (const id of ids || []) {
        const raw = await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['GET', `feedback:item:${id}`]);
        if (!raw) {
          await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['ZREM', 'feedback:ids', id]);
          continue;
        }
        try { items.push(JSON.parse(raw)); } catch { /* 손상된 항목은 건너뜀 */ }
      }
      res.status(200).json({ items });
    } catch (e) {
      res.status(500).json({ error: 'failed' });
    }
    return;
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    const id = String((body && body.id) || '').replace(/[^0-9]/g, '');
    if (!id) {
      res.status(400).json({ error: 'invalid' });
      return;
    }
    try {
      await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['DEL', `feedback:item:${id}`]);
      await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['ZREM', 'feedback:ids', id]);
      res.status(200).json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'failed' });
    }
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}
