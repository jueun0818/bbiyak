// 게시판 목록 조회(GET) / 새 글 작성(POST)
import { redisCmd, getSessionUser, safeText } from './_kakao.js';

const CATEGORIES = new Set(['free', 'result']);
const PAGE_SIZE = 20;
const MAX_BODY_LEN = 500;
const MAX_TITLE_LEN = 40;
// 인기순은 전체 글이 아니라 최근 이 개수 안에서만 좋아요 순으로 다시 정렬한다
// (오래된 글이 좋아요 몇 개로 상단을 영구 점거하는 걸 막고, 매 요청마다 훑는 범위도 제한).
const POPULAR_WINDOW = 200;

// 공지(고정) 글. admin.js에서 board:pinned(ZSET)에 넣고 뺀다. 목록 첫 페이지 맨 위에 항상 붙인다.
async function getPinnedPosts(myKakaoId) {
  const ids = await redisCmd(['ZREVRANGE', 'board:pinned', '0', '19']);
  return (await attachMeta(ids || [], myKakaoId)).filter((p) => p && !p.hidden);
}

function withPinnedFirst(posts, pinned) {
  if (!pinned.length) return posts;
  const pinnedIds = new Set(pinned.map((p) => p.id));
  return [...pinned, ...posts.filter((p) => !pinnedIds.has(p.id))].slice(0, PAGE_SIZE);
}

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
      const sortPopular = req.query.sort === 'popular';
      const searchQuery = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 40) : '';

      const user = await getSessionUser(req);

      // 검색: 별도 색인 없이, 최근 글 한 창(POPULAR_WINDOW)을 불러와 제목·본문에서
      // 부분일치로 걸러낸다. 글이 많지 않은 서비스라 매 요청마다 훑어도 충분히 빠르다.
      if (searchQuery) {
        const ids = await redisCmd(['ZREVRANGE', key, '0', String(POPULAR_WINDOW - 1)]);
        const windowPosts = (await attachMeta(ids || [], user && user.kakaoId)).filter((p) => p && !p.hidden);
        const q = searchQuery.toLowerCase();
        const matched = windowPosts.filter((p) => (p.title || '').toLowerCase().includes(q) || (p.body || '').toLowerCase().includes(q));
        const posts = matched.slice(offset, offset + PAGE_SIZE);
        res.status(200).json({ posts, hasMore: offset + PAGE_SIZE < matched.length });
        return;
      }

      if (sortPopular) {
        const ids = await redisCmd(['ZREVRANGE', key, '0', String(POPULAR_WINDOW - 1)]);
        const windowPosts = (await attachMeta(ids || [], user && user.kakaoId)).filter((p) => p && !p.hidden);
        windowPosts.sort((a, b) => (b.likeCount - a.likeCount) || (b.createdAt - a.createdAt));
        let posts = windowPosts.slice(offset, offset + PAGE_SIZE);
        if (offset === 0 && !category) posts = withPinnedFirst(posts, await getPinnedPosts(user && user.kakaoId));
        res.status(200).json({ posts, hasMore: offset + PAGE_SIZE < windowPosts.length });
        return;
      }

      const ids = await redisCmd(['ZREVRANGE', key, String(offset), String(offset + PAGE_SIZE - 1)]);
      let posts = (await attachMeta(ids || [], user && user.kakaoId)).filter((p) => p && !p.hidden);
      if (offset === 0 && !category) posts = withPinnedFirst(posts, await getPinnedPosts(user && user.kakaoId));
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
      const title = safeText(body && body.title, MAX_TITLE_LEN);
      const text = safeText(body && body.body, MAX_BODY_LEN);
      const resultData = body && body.resultData && typeof body.resultData === 'object' ? body.resultData : null;
      if (!title || !text) {
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
      const post = { id: String(id), kakaoId: user.kakaoId, nickname: user.nickname, avatar: user.avatar || null, category, title, body: text, resultData, createdAt };

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
