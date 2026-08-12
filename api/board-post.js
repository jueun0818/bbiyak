// 글 하나 조회(댓글 포함, GET) / 댓글 작성·좋아요 토글·삭제(POST)
import { redisCmd, getSessionUser, safeText } from './_kakao.js';

const MAX_COMMENT_LEN = 200;

export default async function handler(req, res) {
  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    res.status(500).json({ error: 'not configured' });
    return;
  }

  const postId = String((req.method === 'GET' ? req.query.id : (req.body && req.body.postId)) || '').replace(/[^0-9]/g, '');
  if (!postId) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }

  if (req.method === 'GET') {
    try {
      const raw = await redisCmd(['GET', `board:post:${postId}`]);
      if (!raw) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const post = JSON.parse(raw);
      const user = await getSessionUser(req);
      const [commentsRaw, likeCount, likedByMe] = await Promise.all([
        redisCmd(['LRANGE', `board:post:${postId}:comments`, '0', '-1']),
        redisCmd(['SCARD', `board:post:${postId}:likes`]),
        user ? redisCmd(['SISMEMBER', `board:post:${postId}:likes`, user.kakaoId]) : Promise.resolve(0),
      ]);
      const comments = (commentsRaw || [])
        .map((s) => { try { return JSON.parse(s); } catch { return null; } })
        .filter(Boolean)
        .reverse(); // LPUSH로 쌓아서 최신이 앞이니, 댓글창에는 오래된 순으로 보여준다.

      res.status(200).json({
        post: { ...post, likeCount: Number(likeCount) || 0, likedByMe: Boolean(likedByMe), commentCount: comments.length },
        comments,
      });
    } catch (e) {
      res.status(500).json({ error: 'failed' });
    }
    return;
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    const action = body && body.action;

    try {
      const exists = await redisCmd(['EXISTS', `board:post:${postId}`]);
      if (!exists) {
        res.status(404).json({ error: 'not found' });
        return;
      }

      const user = await getSessionUser(req);
      if (!user) {
        res.status(401).json({ error: 'login required' });
        return;
      }

      if (action === 'like') {
        const likeKey = `board:post:${postId}:likes`;
        const isLiked = await redisCmd(['SISMEMBER', likeKey, user.kakaoId]);
        if (isLiked) await redisCmd(['SREM', likeKey, user.kakaoId]);
        else await redisCmd(['SADD', likeKey, user.kakaoId]);
        const likeCount = await redisCmd(['SCARD', likeKey]);
        res.status(200).json({ ok: true, liked: !isLiked, likeCount: Number(likeCount) || 0 });
        return;
      }

      if (action === 'comment') {
        const text = safeText(body.body, MAX_COMMENT_LEN);
        if (!text) {
          res.status(400).json({ error: 'empty body' });
          return;
        }
        const cooldownKey = `ratelimit:comment:${user.kakaoId}`;
        const acquired = await redisCmd(['SET', cooldownKey, '1', 'NX', 'EX', '5']);
        if (!acquired) {
          res.status(429).json({ error: 'too fast' });
          return;
        }
        const comment = {
          id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`,
          kakaoId: user.kakaoId,
          nickname: user.nickname,
          body: text,
          createdAt: Date.now(),
        };
        await redisCmd(['LPUSH', `board:post:${postId}:comments`, JSON.stringify(comment)]);
        res.status(200).json({ ok: true, comment });
        return;
      }

      if (action === 'delete') {
        const raw = await redisCmd(['GET', `board:post:${postId}`]);
        const post = raw ? JSON.parse(raw) : null;
        if (!post || post.kakaoId !== user.kakaoId) {
          res.status(403).json({ error: 'forbidden' });
          return;
        }
        await redisCmd(['DEL', `board:post:${postId}`]);
        await redisCmd(['DEL', `board:post:${postId}:comments`]);
        await redisCmd(['DEL', `board:post:${postId}:likes`]);
        await redisCmd(['ZREM', 'board:posts', postId]);
        await redisCmd(['ZREM', `board:posts:${post.category}`, postId]);
        res.status(200).json({ ok: true });
        return;
      }

      res.status(400).json({ error: 'invalid action' });
    } catch (e) {
      res.status(500).json({ error: 'failed' });
    }
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}
