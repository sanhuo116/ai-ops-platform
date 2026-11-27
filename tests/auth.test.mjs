import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { authorize, BRIDGE } from '../server/auth.mjs';

let server, origin;
const active = new Set();
before(async () => {
  server = createServer(async (req, res) => {
    const verify = async id => active.has(id) ? { name: '测试账号' } : null;
    if (await authorize(req, res, new URL(req.url, origin), verify) === true) res.end('workspace');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
});
after(() => new Promise(resolve => server.close(resolve)));
const get = (path, headers = {}, method = 'GET') => fetch(origin + path, { headers, method, redirect: 'manual' });
const cookiePair = (res, name) => res.headers.getSetCookie().find(v => v.startsWith(name + '=')).split(';')[0];

async function begin(next) {
  const start = await get('/aiops/auth/start?next=' + encodeURIComponent(next));
  assert.equal(start.status, 303);
  const oauth = new URL(start.headers.get('location'), origin);
  assert.equal(oauth.pathname, '/ga/auth/feishu');
  const callback = '/ga' + oauth.searchParams.get('next');
  assert.equal(new URL(callback, origin).pathname, BRIDGE);
  return { callback, cookie: cookiePair(start, 'aiops_login') };
}
async function signIn(next, upstream) {
  const flow = await begin(next);
  active.add(upstream);
  const res = await get(flow.callback, { cookie: flow.cookie + '; govaide_session=' + upstream });
  assert.equal(res.status, 303);
  assert.match(res.headers.getSetCookie().at(-1), /Path=\/aiops; HttpOnly; SameSite=Lax/);
  return { res, session: cookiePair(res, 'aiops_session'), flow };
}

test('登录返回原深链，回调一次有效，退出后 API 关闭', async () => {
  const next = '/aiops/ao/tasks?status=done';
  const { res, session, flow } = await signIn(next, 'user-1');
  assert.equal(res.headers.get('location'), next);
  assert.equal(await (await get(next, { cookie: session })).text(), 'workspace');
  assert.deepEqual(await (await get('/aiops/api/auth/me', { cookie: session })).json(), { name: '测试账号' });
  assert.match((await get(flow.callback, { cookie: flow.cookie })).headers.get('location'), /reason=expired/);
  assert.equal((await get('/aiops/auth/logout', { cookie: session, origin }, 'POST')).status, 303);
  assert.equal((await get('/aiops/api/tasks', { cookie: session })).status, 401);
});

test('AICRM 会话失效后关闭下载和业务页面', async () => {
  const { session } = await signIn('/aiops/', 'user-2');
  active.delete('user-2');
  assert.equal((await get('/aiops/api/xj/requests/x/download', { cookie: session })).status, 401);
  assert.match((await get('/aiops/planet/qr/callback', { cookie: session })).headers.get('location'), /^\/aiops\/login/);
});

test('登录回调绑定原浏览器，拒绝无账号、异站请求和外部回跳地址', async () => {
  const flow = await begin('/aiops/');
  assert.match((await get(flow.callback)).headers.get('location'), /reason=expired/);
  const denied = await get(flow.callback, { cookie: flow.cookie });
  assert.match(denied.headers.get('location'), /reason=account/);
  assert.ok(!denied.headers.getSetCookie().some(c => c.startsWith('aiops_session=')));
  assert.equal((await get('/aiops/api/tasks', { origin: 'http://elsewhere.invalid' }, 'POST')).status, 403);
  const { res } = await signIn('/aiops/../elsewhere', 'user-3');
  assert.equal(res.headers.get('location'), '/aiops/');
});
