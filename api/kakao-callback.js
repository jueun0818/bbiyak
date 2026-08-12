import { createSession, setSessionCookie } from './_kakao.js';

const REDIRECT_URI = process.env.KAKAO_REDIRECT_URI || 'https://bbiyak-6ou7.vercel.app/api/kakao-callback';

export default async function handler(req, res) {
  const { KAKAO_REST_API_KEY, KAKAO_CLIENT_SECRET } = process.env;
  const code = req.query.code;
  const back = typeof req.query.state === 'string' && req.query.state ? decodeURIComponent(req.query.state) : '/';

  if (!KAKAO_REST_API_KEY || !code) {
    res.writeHead(302, { Location: `${back}?loginError=1` });
    res.end();
    return;
  }

  try {
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: KAKAO_REST_API_KEY,
      redirect_uri: REDIRECT_URI,
      code: String(code),
    });
    if (KAKAO_CLIENT_SECRET) tokenParams.set('client_secret', KAKAO_CLIENT_SECRET);

    const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: tokenParams.toString(),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      res.writeHead(302, { Location: `${back}?loginError=1` });
      res.end();
      return;
    }

    const meRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const me = await meRes.json();
    const nickname =
      (me.kakao_account && me.kakao_account.profile && me.kakao_account.profile.nickname) ||
      (me.properties && me.properties.nickname) ||
      '삐약이';

    const sessionId = await createSession({ kakaoId: String(me.id), nickname: String(nickname).slice(0, 20) });
    setSessionCookie(res, sessionId);
    res.writeHead(302, { Location: back });
    res.end();
  } catch (e) {
    res.writeHead(302, { Location: `${back}?loginError=1` });
    res.end();
  }
}
