// 로그인한 사용자가 게시판에 표시될 프로필 그림(귀여운 이모지)을 고를 수 있게 한다.
// 닉네임과 마찬가지로 세션에만 저장되고, 이후 글・댓글부터 새 프로필이 붙는다.
import { parseCookies, redisCmd, SESSION_COOKIE, SESSION_TTL_SEC } from './_kakao.js';

// 클라이언트가 임의 문자열을 보내지 못하도록 서버에서도 허용 목록으로 한 번 더 검증한다.
const ALLOWED_AVATARS = new Set([
  '🐥', '🐣', '🐤', '🐰', '🐱', '🐶', '🦊', '🐻', '🐼', '🐨',
  '🐷', '🐹', '🦄', '🐢', '🦋', '🐸', '🐧', '🦁', '🐯', '🐮',
]);

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
    // avatar: null이면 기본(닉네임 이니셜) 아바타로 되돌린다.
    const avatarInput = body && body.avatar;
    const avatar = avatarInput === null ? null : (ALLOWED_AVATARS.has(avatarInput) ? avatarInput : undefined);
    if (avatar === undefined) {
      res.status(400).json({ error: 'invalid avatar' });
      return;
    }

    const updated = { ...user, avatar };
    await redisCmd(['SET', `session:${sessionId}`, JSON.stringify(updated), 'EX', String(SESSION_TTL_SEC)]);
    res.status(200).json({ ok: true, avatar });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
}
