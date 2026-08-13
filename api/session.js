// GET: 현재 로그인 세션 조회. POST: 로그아웃(세션 삭제).
// Vercel Hobby 플랜의 서버리스 함수 개수 제한 때문에 예전 logout.js를 여기에 합쳤다.
import { getSessionUser, parseCookies, clearSessionCookie, redisCmd, SESSION_COOKIE } from './_kakao.js';

export default async function handler(req, res) {
  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;

  if (req.method === 'POST') {
    try {
      const sessionId = parseCookies(req)[SESSION_COOKIE];
      if (sessionId && UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) {
        await redisCmd(['DEL', `session:${sessionId}`]);
      }
    } catch (e) {
      // 세션 삭제가 실패해도 쿠키는 지워서 클라이언트는 로그아웃된 것으로 취급한다.
    }
    clearSessionCookie(res);
    res.status(200).json({ ok: true });
    return;
  }

  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    res.status(200).json({ loggedIn: false });
    return;
  }
  try {
    const user = await getSessionUser(req);
    if (!user) {
      res.status(200).json({ loggedIn: false });
      return;
    }
    res.status(200).json({ loggedIn: true, nickname: user.nickname, kakaoId: user.kakaoId, avatar: user.avatar || null });
  } catch (e) {
    res.status(200).json({ loggedIn: false });
  }
}
