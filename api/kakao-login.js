// 카카오 로그인 시작점 — 사용자를 카카오 인증 화면으로 보낸다.
const REDIRECT_URI = process.env.KAKAO_REDIRECT_URI || 'https://bbiyak-6ou7.vercel.app/api/kakao-callback';

export default function handler(req, res) {
  const { KAKAO_REST_API_KEY } = process.env;
  if (!KAKAO_REST_API_KEY) {
    res.status(500).send('카카오 로그인이 아직 설정되지 않았어요.');
    return;
  }
  // 로그인 후 돌아갈 페이지(게시판 등)를 state로 넘겨서 콜백에서 그대로 리다이렉트한다.
  const back = typeof req.query.back === 'string' ? req.query.back : '/';
  const state = encodeURIComponent(back);
  const authorizeUrl =
    `https://kauth.kakao.com/oauth/authorize?client_id=${encodeURIComponent(KAKAO_REST_API_KEY)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&state=${state}`;
  res.writeHead(302, { Location: authorizeUrl });
  res.end();
}
