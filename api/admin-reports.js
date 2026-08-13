// 신고된 게시글 목록 조회(GET) / 삭제・신고 무시 처리(POST). 관리자 비밀번호 필요.
async function redisCmd(url, token, cmd) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const data = await r.json();
  return data.result;
}

export default async function handler(req, res) {
  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ADMIN_PASSWORD } = process.env;
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN || !ADMIN_PASSWORD) {
    res.status(500).json({ error: 'not configured' });
    return;
  }

  const password = (req.method === 'POST' ? req.body && req.body.password : req.query.password) || '';
  if (password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (req.method === 'GET') {
    try {
      const idsWithScores = await redisCmd(
        UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
        ['ZREVRANGE', 'board:reportedPosts', '0', '49', 'WITHSCORES']
      );
      const reports = [];
      for (let i = 0; i < (idsWithScores || []).length; i += 2) {
        const id = idsWithScores[i];
        const reportCount = Number(idsWithScores[i + 1]) || 0;
        const raw = await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['GET', `board:post:${id}`]);
        if (!raw) {
          // 이미 삭제된 글이면 신고 목록에서도 정리한다.
          await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['ZREM', 'board:reportedPosts', id]);
          continue;
        }
        let post;
        try { post = JSON.parse(raw); } catch { continue; }
        reports.push({ id, reportCount, nickname: post.nickname, category: post.category, body: post.body, createdAt: post.createdAt });
      }
      res.status(200).json({ reports });
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
    const id = String((body && body.id) || '').replace(/[^0-9]/g, '');
    const action = body && body.action;
    if (!id || (action !== 'dismiss' && action !== 'delete')) {
      res.status(400).json({ error: 'invalid' });
      return;
    }

    try {
      if (action === 'dismiss') {
        await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['ZREM', 'board:reportedPosts', id]);
        await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['DEL', `board:post:${id}:reporters`]);
        res.status(200).json({ ok: true });
        return;
      }

      // action === 'delete': board-post.js의 삭제 로직과 동일하게 관련 키를 전부 정리한다.
      const raw = await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['GET', `board:post:${id}`]);
      const post = raw ? JSON.parse(raw) : null;
      await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['DEL', `board:post:${id}`]);
      await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['DEL', `board:post:${id}:comments`]);
      await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['DEL', `board:post:${id}:likes`]);
      await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['DEL', `board:post:${id}:reporters`]);
      await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['ZREM', 'board:reportedPosts', id]);
      await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['ZREM', 'board:posts', id]);
      if (post) await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['ZREM', `board:posts:${post.category}`, id]);
      res.status(200).json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'failed' });
    }
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}
