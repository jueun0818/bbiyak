// 글 하나 조회(댓글 포함, GET) / 댓글 작성·좋아요 토글·삭제(POST)
import { redisCmd, getSessionUser, safeText } from './_kakao.js';

const MAX_COMMENT_LEN = 200;
const MAX_BODY_LEN = 500;
const MAX_TITLE_LEN = 40;

export default async function handler(req, res) {
  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    res.status(500).json({ error: 'not configured' });
    return;
  }

  // 내 댓글 모아보기: 특정 글이 아니라 로그인한 사용자 기준으로 조회하므로 postId가 없다.
  if (req.method === 'GET' && req.query.mine === '1') {
    try {
      const user = await getSessionUser(req);
      if (!user) {
        res.status(401).json({ error: 'login required' });
        return;
      }
      // 작성 시 LTRIM으로 최대 200개까지 보관하므로(아래 comment 액션 참고),
      // 여기서도 49개가 아니라 199개까지 읽어야 오래전(예: 닉네임 변경 전) 댓글도
      // "내 댓글 모아보기"에 나타나 수정・삭제할 수 있다.
      const userCommentsKey = `user:${user.kakaoId}:comments`;
      const rawList = await redisCmd(['LRANGE', userCommentsKey, '0', '199']);
      const indexed = (rawList || [])
        .map((s) => { try { return JSON.parse(s); } catch { return null; } })
        .filter(Boolean);

      // 이 인덱스 자체가 "내 댓글 모아보기" 기능이 생긴 뒤로만 채워졌기 때문에, 그 전에
      // (예: 닉네임 변경 전에) 쓴 댓글은 LRANGE 범위를 아무리 늘려도 여기 없다. 전체 글을
      // 훑어서 인덱스에 없는 내 댓글을 찾아 응답에 합치고, 다음부턴 바로 보이도록 인덱스에도
      // 채워 넣는다(글 수가 적은 서비스라 매번 훑어도 부담 없고, 이미 채워진 건 건너뛴다).
      const indexedIds = new Set(indexed.map((c) => c.id));
      const BACKFILL_SCAN_LIMIT = 300;
      const postIds = (await redisCmd(['ZREVRANGE', 'board:posts', '0', String(BACKFILL_SCAN_LIMIT - 1)])) || [];
      const scanResults = await Promise.all(postIds.map(async (postId) => {
        const [postRaw, commentsRaw] = await Promise.all([
          redisCmd(['GET', `board:post:${postId}`]),
          redisCmd(['LRANGE', `board:post:${postId}:comments`, '0', '-1']),
        ]);
        if (!commentsRaw || !commentsRaw.length) return [];
        let postTitle = '(삭제된 글)';
        if (postRaw) {
          try {
            const p = JSON.parse(postRaw);
            postTitle = p.title || (p.body ? (p.body.length > 24 ? p.body.slice(0, 24) + '…' : p.body) : '(제목 없음)');
          } catch { /* 무시 */ }
        }
        const found = [];
        for (const s of commentsRaw) {
          let c;
          try { c = JSON.parse(s); } catch { continue; }
          if (!c || c.kakaoId !== user.kakaoId || indexedIds.has(c.id)) continue;
          found.push({ id: c.id, postId, postTitle, body: c.body, createdAt: c.createdAt, ...(c.editedAt ? { editedAt: c.editedAt } : {}) });
        }
        return found;
      }));
      const backfilled = scanResults.flat();
      if (backfilled.length) {
        await Promise.all(backfilled.map((entry) => redisCmd(['RPUSH', userCommentsKey, JSON.stringify(entry)])));
        await redisCmd(['LTRIM', userCommentsKey, '0', '199']);
      }

      const comments = [...indexed, ...backfilled].sort((a, b) => b.createdAt - a.createdAt);
      res.status(200).json({ comments });
    } catch (e) {
      res.status(500).json({ error: 'failed' });
    }
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
          avatar: user.avatar || null,
          body: text,
          createdAt: Date.now(),
        };
        await redisCmd(['LPUSH', `board:post:${postId}:comments`, JSON.stringify(comment)]);

        // "내 댓글 모아보기"에서 매번 글을 다시 불러오지 않도록, 글 제목을 함께 스냅샷으로 남긴다.
        const postForTitleRaw = await redisCmd(['GET', `board:post:${postId}`]);
        let postTitle = '(삭제된 글)';
        if (postForTitleRaw) {
          try {
            const postForTitle = JSON.parse(postForTitleRaw);
            postTitle = postForTitle.title
              || (postForTitle.body ? (postForTitle.body.length > 24 ? postForTitle.body.slice(0, 24) + '…' : postForTitle.body) : '(제목 없음)');
          } catch { /* 무시 */ }
        }
        const userEntry = { id: comment.id, postId, postTitle, body: text, createdAt: comment.createdAt };
        const userCommentsKey = `user:${user.kakaoId}:comments`;
        await redisCmd(['LPUSH', userCommentsKey, JSON.stringify(userEntry)]);
        await redisCmd(['LTRIM', userCommentsKey, '0', '199']);

        res.status(200).json({ ok: true, comment });
        return;
      }

      if (action === 'editComment') {
        const commentId = String((body && body.commentId) || '');
        const text = safeText(body.body, MAX_COMMENT_LEN);
        if (!commentId || !text) {
          res.status(400).json({ error: 'invalid' });
          return;
        }

        const postCommentsKey = `board:post:${postId}:comments`;
        const rawList = (await redisCmd(['LRANGE', postCommentsKey, '0', '-1'])) || [];
        let targetRaw = null;
        let foundComment = null;
        for (const s of rawList) {
          let c;
          try { c = JSON.parse(s); } catch { continue; }
          if (c.id === commentId) { targetRaw = s; foundComment = c; break; }
        }
        if (!targetRaw || !foundComment || foundComment.kakaoId !== user.kakaoId) {
          res.status(403).json({ error: 'forbidden' });
          return;
        }
        const editedAt = Date.now();
        const updatedComment = { ...foundComment, body: text, editedAt };
        // 인덱스 기반 LSET 대신 값 기준 LINSERT+LREM으로 바꿔치기한다 — 이 사이에 새
        // 댓글이 LPUSH되어 인덱스가 밀려도 엉뚱한 자리를 덮어쓰지 않게 하기 위함이다.
        const insertResult = await redisCmd(['LINSERT', postCommentsKey, 'BEFORE', targetRaw, JSON.stringify(updatedComment)]);
        if (Number(insertResult) <= 0) {
          res.status(409).json({ error: 'comment changed, please retry' });
          return;
        }
        await redisCmd(['LREM', postCommentsKey, '1', targetRaw]);

        // 내 댓글 모아보기 인덱스도 같은 방식으로 갱신한다(실패해도 본 댓글 수정은 이미 끝났으니 무시).
        const userCommentsKey = `user:${user.kakaoId}:comments`;
        const userRawList = (await redisCmd(['LRANGE', userCommentsKey, '0', '-1'])) || [];
        const userTargetRaw = userRawList.find((s) => {
          try { return JSON.parse(s).id === commentId; } catch { return false; }
        });
        if (userTargetRaw) {
          let userEntry;
          try { userEntry = JSON.parse(userTargetRaw); } catch { userEntry = null; }
          if (userEntry) {
            const userInsertResult = await redisCmd(['LINSERT', userCommentsKey, 'BEFORE', userTargetRaw, JSON.stringify({ ...userEntry, body: text, editedAt })]);
            if (Number(userInsertResult) > 0) await redisCmd(['LREM', userCommentsKey, '1', userTargetRaw]);
          }
        }

        res.status(200).json({ ok: true, body: text, editedAt });
        return;
      }

      if (action === 'deleteComment') {
        const commentId = String((body && body.commentId) || '');
        if (!commentId) {
          res.status(400).json({ error: 'invalid' });
          return;
        }

        const postCommentsKey = `board:post:${postId}:comments`;
        const rawList = (await redisCmd(['LRANGE', postCommentsKey, '0', '-1'])) || [];
        let targetRaw = null;
        let targetComment = null;
        for (const s of rawList) {
          let c;
          try { c = JSON.parse(s); } catch { continue; }
          if (c.id === commentId) { targetRaw = s; targetComment = c; break; }
        }
        if (!targetRaw || !targetComment || targetComment.kakaoId !== user.kakaoId) {
          res.status(403).json({ error: 'forbidden' });
          return;
        }
        await redisCmd(['LREM', postCommentsKey, '1', targetRaw]);

        const userCommentsKey = `user:${user.kakaoId}:comments`;
        const userRawList = (await redisCmd(['LRANGE', userCommentsKey, '0', '-1'])) || [];
        const userTargetRaw = userRawList.find((s) => {
          try { return JSON.parse(s).id === commentId; } catch { return false; }
        });
        if (userTargetRaw) await redisCmd(['LREM', userCommentsKey, '1', userTargetRaw]);

        res.status(200).json({ ok: true });
        return;
      }

      if (action === 'edit') {
        const raw = await redisCmd(['GET', `board:post:${postId}`]);
        const post = raw ? JSON.parse(raw) : null;
        if (!post || post.kakaoId !== user.kakaoId) {
          res.status(403).json({ error: 'forbidden' });
          return;
        }
        const title = safeText(body.title, MAX_TITLE_LEN) || post.title;
        const text = safeText(body.body, MAX_BODY_LEN);
        if (!title || !text) {
          res.status(400).json({ error: 'empty body' });
          return;
        }
        const updated = { ...post, title, body: text, editedAt: Date.now() };
        await redisCmd(['SET', `board:post:${postId}`, JSON.stringify(updated)]);
        res.status(200).json({ ok: true, title, body: text, editedAt: updated.editedAt });
        return;
      }

      if (action === 'report') {
        const raw = await redisCmd(['GET', `board:post:${postId}`]);
        const post = raw ? JSON.parse(raw) : null;
        if (!post) {
          res.status(404).json({ error: 'not found' });
          return;
        }
        if (post.kakaoId === user.kakaoId) {
          res.status(400).json({ error: 'cannot report own post' });
          return;
        }
        const reportersKey = `board:post:${postId}:reporters`;
        const already = await redisCmd(['SISMEMBER', reportersKey, user.kakaoId]);
        if (!already) {
          await redisCmd(['SADD', reportersKey, user.kakaoId]);
          const reportCount = await redisCmd(['SCARD', reportersKey]);
          // 신고된 글 목록(admin.html)에서 신고 많은 순으로 보기 위해 점수를 신고 수로 유지한다.
          await redisCmd(['ZADD', 'board:reportedPosts', String(Number(reportCount) || 1), postId]);
        }
        res.status(200).json({ ok: true, alreadyReported: !!already });
        return;
      }

      if (action === 'delete') {
        const raw = await redisCmd(['GET', `board:post:${postId}`]);
        const post = raw ? JSON.parse(raw) : null;
        if (!post || post.kakaoId !== user.kakaoId) {
          res.status(403).json({ error: 'forbidden' });
          return;
        }
        // 글이 사라지면 그 밑에 달렸던 댓글들도 각 댓글 작성자의 "내 댓글 모아보기"
        // 인덱스에서 같이 지워야, 클릭했을 때 없는 글로 연결되는 걸 막을 수 있다.
        const commentsToClean = (await redisCmd(['LRANGE', `board:post:${postId}:comments`, '0', '-1'])) || [];
        for (const s of commentsToClean) {
          let c;
          try { c = JSON.parse(s); } catch { continue; }
          if (!c || !c.kakaoId || !c.id) continue;
          const key = `user:${c.kakaoId}:comments`;
          const list = (await redisCmd(['LRANGE', key, '0', '-1'])) || [];
          const match = list.find((s2) => {
            try { return JSON.parse(s2).id === c.id; } catch { return false; }
          });
          if (match) await redisCmd(['LREM', key, '1', match]);
        }

        await redisCmd(['DEL', `board:post:${postId}`]);
        await redisCmd(['DEL', `board:post:${postId}:comments`]);
        await redisCmd(['DEL', `board:post:${postId}:likes`]);
        await redisCmd(['DEL', `board:post:${postId}:reporters`]);
        await redisCmd(['ZREM', 'board:reportedPosts', postId]);
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
