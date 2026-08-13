// 게시판 목록 조회(GET) / 새 글 작성(POST)
import { redisCmd, getSessionUser, safeText } from './_kakao.js';

const CATEGORIES = new Set(['free', 'result']);
const PAGE_SIZE = 20;
const MAX_BODY_LEN = 500;

async function attachMeta(ids, myKakaoId) {
  return Promise.all(
    ids.map(async (id) => {
      const raw = await redisCmd(['GET', `board:post:${id}`]);
      if (!raw) return null;
      let post;
      try { post = JSON.parse(raw); } catch { return null; }
      const [commentCount, likeCount, likedByMe] = await Promise.all([
        redisCmd(['LLEN', `board:post:${id}:comments`]),
        redisCmd(['SCARD', `board:post:${id}:likes`]),
        myKakaoId ? redisCmd(['SISMEMBER', `board:post:${id}:likes`, myKakaoId]) : Promise.resolve(0),
      ]);
      return {
        ...post,
        commentCount: Number(commentCount) || 0,
        likeCount: Number(likeCount) || 0,
        likedByMe: Boolean(likedByMe),
      };
    })
  );
}

export default async function handler(req, res) {
  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    res.status(500).json({ error: 'not configured' });
    return;
  }

  if (req.method === 'GET') {
    try {
      const category = CATEGORIES.has(req.query.category) ? req.query.category : null;
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const key = category ? `board:posts:${category}` : 'board:posts';

      const user = await getSessionUser(req);
      const ids = await redisCmd(['ZREVRANGE', key, String(offset), String(offset + PAGE_SIZE - 1)]);
      const posts = (await attachMeta(ids || [], user && user.kakaoId)).filter(Boolean);
      const total = await redisCmd(['ZCARD', key]);

      res.status(200).json({ posts, hasMore: offset + PAGE_SIZE < (Number(total) || 0) });
    } catch (e) {
      res.status(500).json({ error: 'failed' });
    }
    return;
  }

  if (req.method === 'POST') {
    try {
      const user = await getSessionUser(req);
      if (!user) {
        res.status(401).json({ error: 'login required' });
        return;
      }

      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
      }
      const category = CATEGORIES.has(body && body.category) ? body.category : 'free';
      const text = safeText(body && body.body, MAX_BODY_LEN);
      const resultData = body && body.resultData && typeof body.resultData === 'object' ? body.resultData : null;
      if (!text) {
        res.status(400).json({ error: 'empty body' });
        return;
      }

      // 도배 방지: 같은 사람이 8초 안에 다시 글을 쓰면 막는다(SET NX로 원자적 체크).
      const cooldownKey = `ratelimit:post:${user.kakaoId}`;
      const acquired = await redisCmd(['SET', cooldownKey, '1', 'NX', 'EX', '8']);
      if (!acquired) {
        res.status(429).json({ error: 'too fast' });
        return;
      }

      const id = await redisCmd(['INCR', 'board:postSeq']);
      const createdAt = Date.now();
      const post = { id: String(id), kakaoId: user.kakaoId, nickname: user.nickname, avatar: user.avatar || null, category, body: text, resultData, createdAt };

      await redisCmd(['SET', `board:post:${id}`, JSON.stringify(post)]);
      await redisCmd(['ZADD', 'board:posts', String(createdAt), String(id)]);
      await redisCmd(['ZADD', `board:posts:${category}`, String(createdAt), String(id)]);

      res.status(200).json({ ok: true, post: { ...post, commentCount: 0, likeCount: 0, likedByMe: false } });
    } catch (e) {
      res.status(500).json({ error: 'failed' });
    }
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}
