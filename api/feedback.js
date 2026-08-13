// 건의사항 접수(POST 전용, 로그인 불필요). 게시판과 달리 다른 유저에게 공개되지
// 않고 admin.html의 "건의사항" 섹션에서 운영자만 볼 수 있다.
import { redisCmd, getSessionUser, safeText } from './_kakao.js';

const MAX_LEN = 300;

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

  const text = safeText(body && body.body, MAX_LEN);
  if (!text) {
    res.status(400).json({ error: 'empty body' });
    return;
  }

  // 로그인 여부와 무관하게 누구나 보낼 수 있어서 세션 대신 클라이언트가 만들어 보내는
  // deviceId(로컬 스토리지에 저장된 임의 문자열)로 도배 방지 쿨다운을 건다. 강한 보안
  // 장치는 아니지만, 실수로 여러 번 누르거나 짧은 시간에 연달아 보내는 것 정도는 막아준다.
  const deviceId = typeof (body && body.deviceId) === 'string' ? body.deviceId.trim().slice(0, 64) : '';
  if (!deviceId) {
    res.status(400).json({ error: 'invalid device' });
    return;
  }
  const cooldownKey = `ratelimit:feedback:${deviceId}`;
  const acquired = await redisCmd(['SET', cooldownKey, '1', 'NX', 'EX', '20']);
  if (!acquired) {
    res.status(429).json({ error: 'too fast' });
    return;
  }

  try {
    const user = await getSessionUser(req);
    const id = await redisCmd(['INCR', 'feedback:seq']);
    const createdAt = Date.now();
    const item = {
      id: String(id),
      nickname: user ? user.nickname : null,
      kakaoId: user ? user.kakaoId : null,
      body: text,
      createdAt,
    };
    await redisCmd(['SET', `feedback:item:${id}`, JSON.stringify(item)]);
    await redisCmd(['ZADD', 'feedback:ids', String(createdAt), String(id)]);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
}
