// GovAide owns Feishu OAuth and the account directory. Its session cookie is scoped to /ga.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const BASE = '/aiops';
export const BRIDGE = '/ga/aiops-entry';
const home = BASE + '/';
const login = BASE + '/login';
const page = readFileSync(new URL('./login.html', import.meta.url), 'utf8');
const token = () => randomBytes(32).toString('base64url');
const flows = new Map();
const sessions = new Map();
const flowSeconds = 600;
const sessionSeconds = 8 * 3600;
const cleanup = setInterval(() => {
  for (const entries of [flows, sessions]) {
    for (const [key, entry] of entries) if (entry.until <= Date.now()) entries.delete(key);
  }
}, 60000);
cleanup.unref();

function safeNext(value) {
  if (!value?.startsWith(home) || value.includes('\\') || /[\r\n]/.test(value)) return home;
  const url = new URL(value, 'http://local');
  if (!url.pathname.startsWith(home) || /^\/aiops\/(?:auth|login|api|assets)(?:\/|$)/.test(url.pathname)) return home;
  return url.pathname + url.search;
}
function readCookie(req, name) {
  const entry = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return entry?.slice(name.length + 1);
}
function cookie(req, name, value, path, seconds) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return name + '=' + value + '; Path=' + path + '; HttpOnly; SameSite=Lax; Max-Age=' + seconds + secure;
}
function redirect(res, dest) {
  res.writeHead(303, { Location: dest });
  res.end();
}
function message(res, status, error) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error }));
}
function loginUrl(next, reason) {
  const q = new URLSearchParams({ next: safeNext(next) });
  if (reason) q.set('reason', reason);
  return login + '?' + q;
}
const errors = {
  expired: '本次授权已过期，请重新登录。',
  account: '当前 AICRM 账号未获准访问，请联系管理员确认账号状态。',
  service: 'AICRM 暂时无法验证身份，请稍后重试。',
};

async function verifyGovaide(session) {
  if (!session || !/^[\w-]{43}$/.test(session)) return null;
  // The production endpoint checks the database session and active account. Never use the dev port.
  const response = await fetch('http://127.0.0.1:13000/ga/api/auth/me', {
    headers: { Cookie: 'govaide_session=' + session }, redirect: 'error', signal: AbortSignal.timeout(7000),
  });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error('AICRM unavailable');
  const { user } = await response.json();
  return user?.id && user.status === 'active' && user.role !== 'ma_report_viewer' ? { name: user.name } : null;
}

// Returns true only when the business router may handle this request.
export async function authorize(req, res, url, verify = verifyGovaide) {
  const p = url.pathname;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!['GET', 'HEAD'].includes(req.method)) {
    const origin = req.headers.origin;
    if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== (req.headers['x-forwarded-proto'] || 'http') + '://' + req.headers.host)) {
      return message(res, 403, '请求来源无效');
    }
  }
  if (p === login && req.method === 'GET') {
    const notice = errors[url.searchParams.get('reason')] || '';
    const href = BASE + '/auth/start?next=' + encodeURIComponent(safeNext(url.searchParams.get('next')));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
    return res.end(page.replace('{{notice}}', Object.hasOwn(errors, url.searchParams.get('reason')) ? notice : '').replace('{{start}}', () => href));
  }
  if (p === BASE + '/auth/start' && req.method === 'GET') {
    const nonce = token();
    const state = token();
    flows.set(nonce, { state, next: safeNext(url.searchParams.get('next')), until: Date.now() + flowSeconds * 1000 });
    res.setHeader('Set-Cookie', cookie(req, 'aiops_login', nonce, BRIDGE, flowSeconds));
    return redirect(res, '/ga/auth/feishu?next=' + encodeURIComponent('/aiops-entry?state=' + state));
  }
  if (p === BRIDGE && req.method === 'GET') {
    const nonce = readCookie(req, 'aiops_login');
    const flow = flows.get(nonce);
    if (!flow || flow.until <= Date.now() || flow.state !== url.searchParams.get('state')) return redirect(res, loginUrl(home, 'expired'));
    flows.delete(nonce);
    const clear = cookie(req, 'aiops_login', '', BRIDGE, 0);
    res.setHeader('Set-Cookie', clear);
    const upstream = readCookie(req, 'govaide_session');
    let user;
    try { user = await verify(upstream); } catch { return redirect(res, loginUrl(flow.next, 'service')); }
    if (!user) return redirect(res, loginUrl(flow.next, 'account'));
    const id = token();
    sessions.set(id, { upstream, until: Date.now() + sessionSeconds * 1000 });
    res.setHeader('Set-Cookie', [clear, cookie(req, 'aiops_session', id, BASE, sessionSeconds)]);
    return redirect(res, flow.next);
  }
  if (!p.startsWith(home)) return message(res, 404, '未找到页面');
  const id = readCookie(req, 'aiops_session');
  if (p === BASE + '/auth/logout' && req.method === 'POST') {
    sessions.delete(id);
    res.setHeader('Set-Cookie', cookie(req, 'aiops_session', '', BASE, 0));
    return redirect(res, login);
  }
  if (req.method === 'GET' && /^\/aiops\/(?:assets\/[\w.-]+\.(?:js|css)|favicon(?:-\d+\.png|\.svg))$/.test(p)) return true;
  const session = sessions.get(id);
  let user;
  if (session && session.until > Date.now()) {
    try { user = await verify(session.upstream); } catch { return message(res, 503, errors.service); }
  }
  if (!user) {
    sessions.delete(id);
    if (id) res.setHeader('Set-Cookie', cookie(req, 'aiops_session', '', BASE, 0));
    if (p.startsWith(BASE + '/api/') || req.method !== 'GET') return message(res, 401, '请使用飞书登录');
    return redirect(res, loginUrl(p + url.search));
  }
  if (p === BASE + '/api/auth/me' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(user));
  }
  return true;
}
