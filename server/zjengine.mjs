// zjengine.mjs —— Agent质检引擎桥（调 zhijian-all skill 的 Python 引擎）
// 输入：任务目录（calls.jsonl）+ 动态场景包 → 质检明细/汇总 JSON + 按天分组
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PY = process.env.DSH_PYTHON
  || path.join(process.env.HOME || '', '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3');
const SKILL_DIR = process.env.ZHIJIAN_SKILL_DIR || path.join(process.env.HOME, '.agents', 'skills', 'zhijian-all');

// 场景包模板：通用 10 规则全启用；自定义规则经 rules_scene.py 注入
const SCENARIO_JSON = cfg => JSON.stringify({
  name: cfg.name, display_name: cfg.displayName || cfg.name,
  tenant_id: cfg.tenantId || '', bot_id: cfg.botId || '', bot_name: cfg.botName || '',
  generic_rules: ['R01', 'R02', 'R03', 'R04', 'R07', 'R08', 'R11', 'R12', 'R13', 'R14'],
  pattern_rules: [], extra_rules: [],
  review_rules: ['R01', 'R04', 'R07', 'R08', 'R12'],
  notes: '平台动态生成场景包（通用规则集 + 自定义规则）',
}, null, 1);

const LEXICON_PY = cfg => `# -*- coding: utf-8 -*-
# 动态场景词表（Agent质检 · 平台生成）
INTERNAL_TERMS = []
TONE_BAD = []
TOPICS = []
PRICE_TOPICS = []
OPEN_TOPICS = []
FALLBACK_HINTS = [${(cfg.fallbackHints || []).map(s => JSON.stringify(s)).join(', ')}]
PHONE_ALLOWLIST = [${(cfg.phoneAllowlist || []).map(s => JSON.stringify(s)).join(', ')}]
TRANSFER_ASK = []
TRANSFER_EMERGENCY = []
TRANSFER_COMPLAINT = []
SPOTS = []
GROUPS = []
REGIONS = []
BOT_NAME = ${JSON.stringify(cfg.botName || '')}
`;

// 用户自定义规则 → Python 规则文件（正则触判 + 否定语境/寒暄守卫，守卫先于判罚）
const RULES_SCENE_PY = rules => {
  if (!rules || !rules.length) return '';
  const items = rules.map((r, i) => {
    const id = `C${String(i + 1).padStart(2, '0')}`;
    const name = String(r.name || `自定义规则${i + 1}`);
    const desc = String(r.desc || '').replace(/"""/g, '”').slice(0, 200);
    const score = Number(r.score) || 25;
    const level = r.level === '红线' ? '红线' : '扣分';
    return `@register_rule("${id}", ${JSON.stringify(name)}, ${JSON.stringify(level)}, ${score}, kind="scene")
def ${id}(call, eng):
    """${desc}"""
    import re as _re
    pat = _re.compile(${JSON.stringify(String(r.pattern || ''))})
    deny = _re.compile(${JSON.stringify(String(r.denyPattern || ''))}) if ${JSON.stringify(String(r.denyPattern || ''))} else None
    out = []
    for t in call.ai_turns:
        if pat.search(t.text):
            if deny and deny.search(t.text):
                continue
            if eng._is_filler(t.text):
                continue
            out.append(eng._f("${id}", ${JSON.stringify(name)}, ${JSON.stringify(level)}, "P2", ${score}, t.idx, t.text[:160], ${JSON.stringify(desc)}, "复查命中句语境后处置"))
    return out
`;
  }).join('\n\n');
  return `# -*- coding: utf-8 -*-
from zhijian.core import register_rule

${items}
`;
};

// 生成场景包：<taskDir>/scenarios/<taskId>/（skill load_scenario 要求 scenarios/ 父目录结构）
export function buildScenario(taskDir, task, params) {
  const dir = path.join(taskDir, 'scenarios', String(task.id));
  fs.mkdirSync(dir, { recursive: true });
  const botName = params.botName || `bot_${task.bot_id}`;
  fs.writeFileSync(path.join(dir, 'scenario.json'), SCENARIO_JSON({
    name: String(task.id), displayName: botName, tenantId: params.tenantId || '',
    botId: String(task.bot_id), botName, fallbackHints: params.fallbackHints || [],
    phoneAllowlist: params.phoneAllowlist || [],
  }));
  fs.writeFileSync(path.join(dir, 'lexicon.py'), LEXICON_PY({
    botName, fallbackHints: params.fallbackHints || [], phoneAllowlist: params.phoneAllowlist || [],
  }));
  const rs = RULES_SCENE_PY(params.customRules || []);
  if (rs) fs.writeFileSync(path.join(dir, 'rules_scene.py'), rs);
  // 资产：提示词 + 知识库（落盘供 facts.py 解析依据库，R04 编造判定需要）
  const assets = path.join(dir, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  if (params.prompt) fs.writeFileSync(path.join(assets, '大模型提示词_全文.md'), String(params.prompt));
  if (params.kbBase64) fs.writeFileSync(path.join(assets, '知识库表.xlsx'), Buffer.from(params.kbBase64, 'base64'));
  return dir;
}

// 跑质检：calls.jsonl → {reports, summary, days:{day:{summary, reports}}}
export function runZjInspect(taskDir, scenarioDir) {
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(SKILL_DIR, 'scripts'))})
from pathlib import Path
import zhijian.core as core
core._SKILL_DIR = Path(${JSON.stringify(taskDir)})   # 动态场景根 = 任务目录（scenarios/ 下）
from zhijian.core import load_scenario, RuleEngine, summarize
from zhijian.transcript import load_calls, make_call
from zhijian.facts import build_factbase
from zhijian.grounding import Grounding

sc = load_scenario(${JSON.stringify(path.basename(scenarioDir))})
eng = RuleEngine(sc)
assets = Path(${JSON.stringify(scenarioDir)}) / "assets"
if (assets / "大模型提示词_全文.md").exists():
    try:
        eng.fb = build_factbase(assets)
        eng.g = Grounding.build(eng.fb, sc.lexicon)
    except Exception as e:
        print("factbase skip:", e, file=sys.stderr)
eng.lx = sc.lexicon

calls = []
for line in Path(${JSON.stringify(path.join(taskDir, 'calls.jsonl'))}).read_text(encoding="utf-8").splitlines():
    if not line.strip(): continue
    o = json.loads(line)
    turns = o.get("turns") or []
    tsv = "\\n".join(f"{i:04d}:{t.get('role','ME')}:{t.get('text','')}" for i, t in enumerate(turns))
    calls.append(make_call(str(o.get("id")), tsv, {"tpl": o.get("tpl", ""), "day": o.get("day", "")}))

reports = [eng.inspect(c).to_dict() for c in calls]
sm = summarize([type("R", (), {"verdict": r["verdict"], "score": r["score"], "redline_hits": [], "deductions": []})() for r in reports])

from collections import defaultdict
by_day = defaultdict(list)
for r in reports:
    by_day[str(r["meta"].get("day") or "unknown")].append(r)
days = {}
for day, rs in sorted(by_day.items()):
    dsm = summarize([type("R", (), {"verdict": r["verdict"], "score": r["score"], "redline_hits": [], "deductions": []})() for r in rs])
    days[day] = {"summary": dsm, "reports": rs}

print("ZJDONE" + json.dumps({"reports": reports, "summary": sm, "days": days}, ensure_ascii=False))
`;
  const r = spawnSync(PY, ['-c', script], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 30 * 60 * 1000 });
  const out = (r.stdout || '');
  const m = out.match(/ZJDONE([\s\S]*)$/);
  if (!m) {
    const tail = ((r.stderr || '') + out).slice(-600);
    throw new Error(`质检引擎执行失败：${tail}`);
  }
  return JSON.parse(m[1]);
}

// 质检问题清单（bot 维度）：规则 → 受影响通话数 + 证据样例
export function collectIssues(reports, botName) {
  const byRule = new Map();
  for (const r of reports) {
    for (const f of [...(r.redline_hits || []), ...(r.deductions || [])]) {
      if (!byRule.has(f.rule_id)) byRule.set(f.rule_id, { rule_id: f.rule_id, rule_name: f.rule_name, level: f.level, calls: 0, callIds: new Set(), samples: [] });
      const g = byRule.get(f.rule_id);
      g.callIds.add(r.call_id);
      g.calls = g.callIds.size;
      if (g.samples.length < 6) g.samples.push({ call_id: r.call_id, turn: f.turn_idx, evidence: (f.evidence || '').slice(0, 200), detail: (f.detail || '').slice(0, 200) });
    }
  }
  return {
    botName,
    issues: [...byRule.values()].map(({ callIds, ...rest }) => rest).sort((a, b) => b.calls - a.calls),
  };
}
