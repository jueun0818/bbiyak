import { parseCookies, clearSessionCookie, redisCmd, SESSION_COOKIE } from './_kakao.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  try {
    const sessionId = parseCookies(req)[SESSION_COOKIE];
    if (sessionId) await redisCmd(['DEL', `session:${sessionId}`]);
  } catch (e) {
    // 세션 삭제가 실패해도 쿠키는 지워서 클라이언트는 로그아웃된 것으로 취급한다.
  }
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
}
