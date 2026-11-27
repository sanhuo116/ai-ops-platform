// planetqr.mjs —— 星球扫码验证（飞书 SSO）平台托管
// 流程：页面内嵌飞书 QRLogin（同 client_id cli_a6f7d833b67c5013）→ 用户飞书 App 扫码 →
// passport 重定向回平台 /planet/qr/callback?code=xxx → 后端代理 POST /apiUser/common/feiShu/login
// → 拿到 Set-Cookie 会话 → 写入 ~/.local/share/byai-planet-cli/session.json（planet CLI 直接可用）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const ORIGIN = 'https://sh.planet.byai.com';
const CLIENT_ID = 'cli_a6f7d833b67c5013';
const STATE_DIR = path.join(os.homedir(), '.local/share/byai-planet-cli');
const SESSION_FILE = path.join(STATE_DIR, 'session.json');

export function planetQrAuthorizeUrl(redirectUri) {
  return `https://passport.feishu.cn/suite/passport/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=STATE`;
}

// 探测 planet 会话是否有效（跑 planet CLI 的轻量 identity 请求）
export function planetSessionStatus() {
  const SKILL = process.env.VO_AGENT_SKILL_SCRIPTS
    || '/Users/zhuyanzhu/Documents/deepseek-harness/default-workspace/.agents/skills/voiceagent-evidence-driven-optimizer/scripts';
  const PY = process.env.DSH_PYTHON || 'python3';
  const probe = `
import sys, json
sys.path.insert(0, ${JSON.stringify(SKILL)})
import planet
try:
    p = planet.Planet()
    p.identity(2927710)
    print(json.dumps({"valid": True}))
except planet.PlanetError as e:
    msg = str(e)
    auth = msg.startswith("AUTH_REQUIRED") or "login session expired" in msg or "login required" in msg
    print(json.dumps({"valid": False, "auth_required": auth, "detail": msg[:120]}))
except Exception as e:
    print(json.dumps({"valid": False, "auth_required": False, "detail": str(e)[:120]}))
`;
  const r = spawnSync(PY, ['-c', probe], { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  const line = (r.stdout || '').split('\n').map(s => s.trim()).filter(l => l.startsWith('{')).pop();
  try { return JSON.parse(line); } catch { return { valid: false, auth_required: false, detail: '探测失败（脚本异常）' }; }
}

// code → 星球会话 cookie → 写 session.json。返回 {ok, message?}
export async function planetQrExchange(code) {
  if (!code || !/^[A-Za-z0-9._-]{4,}$/.test(code)) return { ok: false, message: 'code 无效' };
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  // ① feiShu/login：code → 会话（Set-Cookie 在响应头）
  const resp = await fetch(`${ORIGIN}/bygw/apiUser/common/feiShu/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': ORIGIN, 'Referer': `${ORIGIN}/login-loading`, 'User-Agent': ua },
    body: JSON.stringify({ code: String(code).slice(0, 128) }),
    redirect: 'manual',
  });
  const setCookies = (resp.headers.getSetCookie?.() || []).filter(Boolean);
  let body = {};
  try { body = await resp.json(); } catch { }
  if (body.code !== 200 || !setCookies.length) {
    const msg = body.resultMsg || `HTTP ${resp.status}`;
    // 一次性 code 不可重放：区分提示
    const hint = /二维码|过期|失效|invalid|expired/i.test(msg) ? '（二维码/code 已过期，请刷新重扫）' : '';
    return { ok: false, message: `飞书登录失败：${msg}${hint}` };
  }
  const cookie = setCookies.map(c => c.split(';')[0]).join('; ');
  // ② 校验 cookie 可用（userrole 有用户 id）
  let user = null;
  try {
    const v = await fetch(`${ORIGIN}/bygw/apiUser/common/user/userrole`, {
      headers: { 'Cookie': cookie, 'User-Agent': ua, 'Referer': ORIGIN },
      redirect: 'manual',
    });
    const j = await v.json().catch(() => null);
    user = j?.result?.id ? j.result : (j?.data?.id ? j.data : null);
  } catch { }
  if (!user) return { ok: false, message: '会话校验未通过（cookie 未取得用户身份），请重扫' };
  // ③ 写 planet CLI 会话（600 权限）
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const payload = JSON.stringify({ origin: ORIGIN, cookie, saved_via: 'platform-qr', user_id: user.id, saved_at: new Date().toISOString() });
  fs.writeFileSync(SESSION_FILE, payload, { mode: 0o600 });
  try { fs.chmodSync(SESSION_FILE, 0o600); } catch { }
  return { ok: true, userId: user.id, name: user.userName || user.name || '' };
}
