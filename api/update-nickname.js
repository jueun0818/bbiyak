// 로그인한 사용자가 게시판에 표시될 닉네임을 카카오 닉네임과 다르게 바꿀 수 있게 한다.
// 이미 올린 글・댓글의 닉네임은 그대로 남고, 이후 글・댓글부터 새 닉네임이 붙는다.
import { parseCookies, redisCmd, safeText, SESSION_COOKIE, SESSION_TTL_SEC } from './_kakao.js';

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

  const sessionId = parseCookies(req)[SESSION_COOKIE];
  if (!sessionId) {
    res.status(401).json({ error: 'login required' });
    return;
  }

  try {
    const raw = await redisCmd(['GET', `session:${sessionId}`]);
    if (!raw) {
      res.status(401).json({ error: 'login required' });
      return;
    }
    let user;
    try { user = JSON.parse(raw); } catch { user = null; }
    if (!user) {
      res.status(401).json({ error: 'login required' });
      return;
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    const nickname = safeText(body && body.nickname, 20);
    if (!nickname) {
      res.status(400).json({ error: 'empty nickname' });
      return;
    }

    const updated = { ...user, nickname };
    await redisCmd(['SET', `session:${sessionId}`, JSON.stringify(updated), 'EX', String(SESSION_TTL_SEC)]);
    res.status(200).json({ ok: true, nickname });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
}
