// 관리자 전용 소소한 관리 기능 모음. Vercel Hobby 플랜의 서버리스 함수 개수 제한
// 때문에 신고 큐(admin-reports)와 건의사항(admin-feedback)을 한 파일로 합쳤다.
// ?type=reports 또는 ?type=feedback(POST는 body.type)으로 구분한다.
async function redisCmd(url, token, cmd) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const data = await r.json();
  return data.result;
}

async function getReports(url, token, res) {
  const idsWithScores = await redisCmd(url, token, ['ZREVRANGE', 'board:reportedPosts', '0', '49', 'WITHSCORES']);
  const reports = [];
  for (let i = 0; i < (idsWithScores || []).length; i += 2) {
    const id = idsWithScores[i];
    const reportCount = Number(idsWithScores[i + 1]) || 0;
    const raw = await redisCmd(url, token, ['GET', `board:post:${id}`]);
    if (!raw) {
      // 이미 삭제된 글이면 신고 목록에서도 정리한다.
      await redisCmd(url, token, ['ZREM', 'board:reportedPosts', id]);
      continue;
    }
    let post;
    try { post = JSON.parse(raw); } catch { continue; }
    reports.push({ id, reportCount, nickname: post.nickname, category: post.category, body: post.body, createdAt: post.createdAt });
  }
  res.status(200).json({ reports });
}

async function postReports(url, token, body, res) {
  const id = String((body && body.id) || '').replace(/[^0-9]/g, '');
  const action = body && body.action;
  if (!id || (action !== 'dismiss' && action !== 'delete')) {
    res.status(400).json({ error: 'invalid' });
    return;
  }

  if (action === 'dismiss') {
    await redisCmd(url, token, ['ZREM', 'board:reportedPosts', id]);
    await redisCmd(url, token, ['DEL', `board:post:${id}:reporters`]);
    // 신고 누적으로 자동 가려졌던 글이면(board-post.js REPORT_AUTO_HIDE_THRESHOLD), 다시 보이게 한다.
    const raw = await redisCmd(url, token, ['GET', `board:post:${id}`]);
    if (raw) {
      let post;
      try { post = JSON.parse(raw); } catch { post = null; }
      if (post && post.hidden) {
        await redisCmd(url, token, ['SET', `board:post:${id}`, JSON.stringify({ ...post, hidden: false })]);
      }
    }
    res.status(200).json({ ok: true });
    return;
  }

  // action === 'delete': board-post.js의 삭제 로직과 동일하게 관련 키를 전부 정리한다.
  const raw = await redisCmd(url, token, ['GET', `board:post:${id}`]);
  const post = raw ? JSON.parse(raw) : null;

  // 글이 사라지면 그 밑에 달렸던 댓글들도 각 댓글 작성자의 "내 댓글 모아보기"
  // 인덱스에서 같이 지워야, 클릭했을 때 없는 글로 연결되는 걸 막을 수 있다.
  const commentsToClean = (await redisCmd(url, token, ['LRANGE', `board:post:${id}:comments`, '0', '-1'])) || [];
  for (const s of commentsToClean) {
    let c;
    try { c = JSON.parse(s); } catch { continue; }
    if (!c || !c.kakaoId || !c.id) continue;
    const key = `user:${c.kakaoId}:comments`;
    const list = (await redisCmd(url, token, ['LRANGE', key, '0', '-1'])) || [];
    const match = list.find((s2) => {
      try { return JSON.parse(s2).id === c.id; } catch { return false; }
    });
    if (match) await redisCmd(url, token, ['LREM', key, '1', match]);
  }

  await redisCmd(url, token, ['DEL', `board:post:${id}`]);
  await redisCmd(url, token, ['DEL', `board:post:${id}:comments`]);
  await redisCmd(url, token, ['DEL', `board:post:${id}:likes`]);
  await redisCmd(url, token, ['DEL', `board:post:${id}:reporters`]);
  await redisCmd(url, token, ['ZREM', 'board:reportedPosts', id]);
  await redisCmd(url, token, ['ZREM', 'board:posts', id]);
  if (post) await redisCmd(url, token, ['ZREM', `board:posts:${post.category}`, id]);
  res.status(200).json({ ok: true });
}

async function getFeedback(url, token, res) {
  const ids = await redisCmd(url, token, ['ZREVRANGE', 'feedback:ids', '0', '49']);
  const items = [];
  for (const id of ids || []) {
    const raw = await redisCmd(url, token, ['GET', `feedback:item:${id}`]);
    if (!raw) {
      await redisCmd(url, token, ['ZREM', 'feedback:ids', id]);
      continue;
    }
    try { items.push(JSON.parse(raw)); } catch { /* 손상된 항목은 건너뜀 */ }
  }
  res.status(200).json({ items });
}

// 자유글 예시(seed) 글에 궁합 결과를 나중에 첨부할 때 쓰는 일회성 관리 기능.
// 실제 유저 글은 작성 시점에만 결과를 첨부할 수 있지만(board-post.js), seed 글은
// 유저 계정이 없어 그 경로를 못 타므로 관리자가 직접 채워 넣는다.
async function postAttachResult(url, token, body, res) {
  const items = Array.isArray(body && body.items) ? body.items : [];
  let updated = 0;
  for (const item of items) {
    const id = String((item && item.postId) || '').replace(/[^0-9]/g, '');
    const resultData = item && item.resultData && typeof item.resultData === 'object' ? item.resultData : null;
    if (!id || !resultData) continue;
    const raw = await redisCmd(url, token, ['GET', `board:post:${id}`]);
    if (!raw) continue;
    let post;
    try { post = JSON.parse(raw); } catch { continue; }
    await redisCmd(url, token, ['SET', `board:post:${id}`, JSON.stringify({ ...post, resultData })]);
    updated += 1;
  }
  res.status(200).json({ ok: true, updated });
}

// 공지(고정) 글 목록. board:pinned(ZSET, score=고정한 시각)에 담긴 id들을 최근 고정순으로 보여준다.
async function getPinned(url, token, res) {
  const idsWithScores = await redisCmd(url, token, ['ZREVRANGE', 'board:pinned', '0', '19', 'WITHSCORES']);
  const items = [];
  for (let i = 0; i < (idsWithScores || []).length; i += 2) {
    const id = idsWithScores[i];
    const pinnedAt = Number(idsWithScores[i + 1]) || 0;
    const raw = await redisCmd(url, token, ['GET', `board:post:${id}`]);
    if (!raw) {
      // 이미 삭제된 글이면 고정 목록에서도 정리한다.
      await redisCmd(url, token, ['ZREM', 'board:pinned', id]);
      continue;
    }
    let post;
    try { post = JSON.parse(raw); } catch { continue; }
    items.push({ id, pinnedAt, nickname: post.nickname, title: post.title });
  }
  res.status(200).json({ items });
}

async function postTogglePin(url, token, body, res) {
  const id = String((body && body.id) || '').replace(/[^0-9]/g, '');
  const pinned = !!(body && body.pinned);
  if (!id) {
    res.status(400).json({ error: 'invalid' });
    return;
  }
  const raw = await redisCmd(url, token, ['GET', `board:post:${id}`]);
  if (!raw) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  let post;
  try { post = JSON.parse(raw); } catch { res.status(500).json({ error: 'failed' }); return; }
  await redisCmd(url, token, ['SET', `board:post:${id}`, JSON.stringify({ ...post, pinned })]);
  if (pinned) await redisCmd(url, token, ['ZADD', 'board:pinned', String(Date.now()), id]);
  else await redisCmd(url, token, ['ZREM', 'board:pinned', id]);
  res.status(200).json({ ok: true, pinned });
}

async function postFeedback(url, token, body, res) {
  const id = String((body && body.id) || '').replace(/[^0-9]/g, '');
  if (!id) {
    res.status(400).json({ error: 'invalid' });
    return;
  }
  await redisCmd(url, token, ['DEL', `feedback:item:${id}`]);
  await redisCmd(url, token, ['ZREM', 'feedback:ids', id]);
  res.status(200).json({ ok: true });
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

  try {
    if (req.method === 'GET') {
      if (req.query.type === 'feedback') { await getFeedback(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, res); return; }
      if (req.query.type === 'reports') { await getReports(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, res); return; }
      if (req.query.type === 'pinned') { await getPinned(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, res); return; }
      res.status(400).json({ error: 'invalid type' });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
      }
      if (body && body.type === 'feedback') { await postFeedback(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, body, res); return; }
      if (body && body.type === 'reports') { await postReports(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, body, res); return; }
      if (body && body.type === 'attachResult') { await postAttachResult(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, body, res); return; }
      if (body && body.type === 'pin') { await postTogglePin(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, body, res); return; }
      res.status(400).json({ error: 'invalid type' });
      return;
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
}
