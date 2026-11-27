// botguard.mjs —— 大模型 Agent 边界门禁
// 质检（zj/ao回归）与 Agent自动优化（ao）仅支持大模型 Agent；
// 规则版（静态对话流 static_flow）bot 一律拦截并引导至「私有化话术包直优」模块。
import { spawnSync } from 'node:child_process';

const SKILL_SCRIPTS = process.env.VO_AGENT_SKILL_SCRIPTS
  || '/Users/zhuyanzhu/Documents/deepseek-harness/default-workspace/.agents/skills/voiceagent-evidence-driven-optimizer/scripts';
const PY = process.env.DSH_PYTHON || 'python3';

const GUARD_PY = `
import sys, json
sys.path.insert(0, ${JSON.stringify(SKILL_SCRIPTS)})
import planet
try:
    info = planet.Planet().identity(int(sys.argv[1]))
except Exception as e:
    print(json.dumps({"ok": False, "reason": "identity_failed", "detail": str(e)[:160]}, ensure_ascii=False)); raise SystemExit
flow = str(info.get("botFlowTypeCode") or "")
flowName = str(info.get("botFlowType") or "")
deleted = bool(info.get("delFlag")) or bool(info.get("gmtDeleted"))
print(json.dumps({"ok": True, "name": info.get("name"), "flow": flow, "flowName": flowName,
                  "deleted": deleted, "nlpType": info.get("nlpType")}, ensure_ascii=False))
`;

// 探测 bot 类型；返回 {ok, reason?, message?, name?, flow?}
export function checkLlmBot(botId) {
  return checkLlmBotSync(botId);
}

// 同步探测（spawnSync，路由内直接调用）
export function checkLlmBotSync(botId) {
  const id = String(botId || '').trim();
  if (!/^\d+$/.test(id)) return { ok: false, reason: 'bad_id', message: 'botId 必须是数字' };
  const r = spawnSync(PY, ['-c', GUARD_PY, id], { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  const line = (r.stdout || '').split('\n').map(s => s.trim()).filter(l => l.startsWith('{')).pop();
  let d;
  try { d = JSON.parse(line); } catch {
    return { ok: false, reason: 'probe_failed', message: 'bot 类型探测失败（星球接口异常），请稍后重试' };
  }
  if (!d.ok) return { ok: false, reason: 'identity_failed', message: `bot ${id} 无法访问：${d.detail || '星球接口异常'}` };
  if (d.deleted) return { ok: false, reason: 'deleted', message: `bot ${id}（${d.name || ''}）已删除，无法发起质检/自动优化` };
  if (d.flow === 'static_flow' || d.flowName.includes('静态')) {
    return {
      ok: false, reason: 'rule_bot', name: d.name, flow: d.flow,
      message: `bot ${id}（${d.name || ''}）是规则版（${d.flowName || '静态对话流'}），不属于大模型 Agent。质检与 Agent自动优化仅支持大模型 Agent，规则版请使用「私有化话术包直优」模块`,
    };
  }
  return { ok: true, name: d.name, flow: d.flow || 'llm_agent' };
}
