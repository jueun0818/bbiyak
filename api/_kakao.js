// 게시판 API들이 공용으로 쓰는 헬퍼(카카오 로그인 세션 + Redis).
// 파일명이 _로 시작하면 Vercel이 이 파일을 별도 라우트로 노출하지 않는다.
import crypto from 'crypto';

export const SESSION_COOKIE = 'pbsid';
export const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30일

export async function redisCmd(cmd) {
  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
  const r = await fetch(UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const data = await r.json();
  return data.result;
}

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

export function setSessionCookie(res, sessionId) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SEC}; Secure`
  );
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`);
}

export async function createSession(user) {
  const sessionId = crypto.randomBytes(24).toString('hex');
  await redisCmd(['SET', `session:${sessionId}`, JSON.stringify(user), 'EX', String(SESSION_TTL_SEC)]);
  return sessionId;
}

// req에 담긴 세션 쿠키로 로그인한 사용자를 찾는다. 클라이언트가 보낸 닉네임 등은 절대
// 신뢰하지 않고, 이 함수로 서버에서 확인한 값만 글쓴이 정보로 사용한다.
export async function getSessionUser(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) return null;
  const raw = await redisCmd(['GET', `session:${sessionId}`]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function safeText(s, maxLen) {
  return typeof s === 'string' ? s.trim().slice(0, maxLen) : '';
}
