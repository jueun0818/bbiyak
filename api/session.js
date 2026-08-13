import { getSessionUser } from './_kakao.js';

export default async function handler(req, res) {
  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
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
