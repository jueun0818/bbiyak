// 방문자 수 집계(stats:uniques:*)를 나중에 추가했기 때문에, 그 이전 방문에는
// 고유 방문자 SET에 반영된 기록이 없다. 이 엔드포인트는 남아있는 stats:log
// (궁합 기능을 한 번이라도 눌러본 최근 기록, 최대 200건)에서 방문자 ID를 모아
// 소급 반영한다. 궁합을 눌러본 적 없는 순수 방문은 로그 자체가 없어 복구가
// 불가능하므로, 이건 정확한 전체 값이 아니라 "복구 가능한 만큼"의 근사치다.
const LOG_KEY = 'stats:log';

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
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ADMIN_PASSWORD } = process.env;
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN || !ADMIN_PASSWORD) {
    res.status(500).json({ error: 'not configured' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  if ((body.password || '') !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const rawLogs = await redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['LRANGE', LOG_KEY, '0', '-1']);
    const entries = (rawLogs || [])
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter((e) => e && e.v && e.t);

    const totalSet = new Set();
    const byDate = new Map();
    entries.forEach((e) => {
      totalSet.add(e.v);
      const date = new Date(e.t).toISOString().slice(0, 10);
      if (!byDate.has(date)) byDate.set(date, new Set());
      byDate.get(date).add(e.v);
    });

    const cmds = [];
    totalSet.forEach((v) => cmds.push(['SADD', 'stats:uniques:total', v]));
    byDate.forEach((set, date) => {
      set.forEach((v) => cmds.push(['SADD', `stats:uniques:${date}`, v]));
    });

    await Promise.all(cmds.map((c) => redisCmd(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, c)));

    res.status(200).json({
      ok: true,
      logEntries: entries.length,
      uniqueVisitorsFound: totalSet.size,
    });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
}
