// 이름 궁합 점수 조작(관리자 설정 오버라이드)
// - GET: 누구나 조회 가능(공개 API). index.html이 궁합 계산 전에 이 목록을 불러와
//   일치하는 규칙이 있으면 피라미드 획수 감산법 대신 이 점수를 그대로 보여준다.
// - POST/DELETE: 관리자 비밀번호 필요.
const KEY = 'overrides:list';

async function redisCmd(url, token, cmd) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const data = await r.json();
  return data.result;
}

function safeName(s) {
  return typeof s === 'string' ? s.trim().slice(0, 20) : '';
}

function safeNote(s) {
  return typeof s === 'string' ? s.trim().slice(0, 60) : '';
}

function clampScore(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(99, Math.round(n)));
}

export default async function handler(req, res) {
  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ADMIN_PASSWORD } = process.env;
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    res.status(500).json({ error: 'not configured' });
    return;
  }

  if (req.method === 'GET') {
    try {
      const raw = await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['HGETALL', KEY]);
      const rules = [];
      for (let i = 0; i < (raw || []).length; i += 2) {
        try { rules.push(JSON.parse(raw[i + 1])); } catch (e) { /* 손상된 항목은 건너뜀 */ }
      }
      res.status(200).json({ rules });
    } catch (e) {
      res.status(500).json({ error: 'failed' });
    }
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  if (!ADMIN_PASSWORD || (body.password || '') !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (req.method === 'POST') {
    const n1 = safeName(body.name1);
    const n2 = safeName(body.name2);
    const score = clampScore(body.score);
    const note = safeNote(body.note);
    if (!n1 || score === null) {
      res.status(400).json({ error: 'invalid' });
      return;
    }
    const id = safeName(body.id) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    const rule = { id, n1, n2, score, note, createdAt: Date.now() };
    try {
      await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['HSET', KEY, id, JSON.stringify(rule)]);
      res.status(200).json({ ok: true, rule });
    } catch (e) {
      res.status(500).json({ error: 'failed' });
    }
    return;
  }

  if (req.method === 'DELETE') {
    const id = safeName(body.id);
    if (!id) {
      res.status(400).json({ error: 'invalid' });
      return;
    }
    try {
      await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['HDEL', KEY, id]);
      res.status(200).json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'failed' });
    }
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}
