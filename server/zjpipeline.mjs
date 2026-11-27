// zjpipeline.mjs —— AI大模型质检任务管线
// 阶段：export(话术包导出·bot信息) → fetch(通话取数) → inspect(zhijian-all 引擎) → deliver(按天报告落盘) → notify(飞书推送)
// 铁律：宁可漏判不可误判（引擎内置守卫）；报告按天产出；每任务完成即推送飞书。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateZjTask, getZjTask } from './zjstore.mjs';
import { buildScenario, runZjInspect, collectIssues } from './zjengine.mjs';
import { pushZjTaskReport, loadZjConfig } from './zjnotify.mjs';
import { exportBotBundle } from './sybundle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ZJ_DIR = path.join(__dirname, '..', 'data', 'zj-tasks');
const SANHUO = path.join(process.env.HOME, '.agents', 'skills', 'data-sanhuo');
const T_OUT = 'DataLakeCatalog.byai_bigdata.dwd_call_call_instance_sh_di';
const T_IN_LOG = 'DataLakeCatalog.byai_bigdata.dwd_call_byrobotprod_inbound_instance_log_di';
const T_IN_INST = 'DataLakeCatalog.byai_bigdata.dwd_call_inbound_instance_sh_di';
const PY = process.env.DSH_PYTHON
  || path.join(process.env.HOME || '', '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3');

fs.mkdirSync(ZJ_DIR, { recursive: true });

const log5 = (io, id, m) => io?.log?.(`[zj ${id}] ${m}`);

// ---------------- DLC 取数（复用 data-sanhuo 口径） ----------------
function dlcQuery(sql, tables) {
  const args = ['scripts/tencent_query.py', '--config', 'references/config.json',
    '--operation', 'submit', '--credentials-keychain', '--sql', sql];
  for (const t of tables) args.push('--authorized-table', t);
  const r = spawnSync('python3', args, { cwd: SANHUO, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  if (r.status !== 0) throw new Error(`DLC 取数失败：${(r.stderr || r.stdout || '').slice(0, 500)}`);
  let d;
  try { d = JSON.parse(r.stdout); } catch { throw new Error(`DLC 返回非 JSON：${(r.stdout || '').slice(0, 300)}`); }
  if (!d.ok) throw new Error(`DLC 错误：${JSON.stringify(d).slice(0, 400)}`);
  return d.rows || [];
}

// ---------------- 阶段：export（话术包导出 → bot/租户名兜底材料） ----------------
// exportBotBundle(taskId, task, log) 产物固定在 data/sy-tasks/<taskId>/bundle
async function stageExport(taskId, task, io) {
  updateZjTask(taskId, { stage: 'export', stage_detail: '导出话术包（bot 信息与材料）…', progress: 8 });
  log5(io, taskId, 'export: 话术包导出开始');
  try {
    const out = await exportBotBundle(taskId, { ...task, params: task.params || {} }, m => log5(io, taskId, `export: ${m}`));
    const bundleDir = out?.bundleDir || path.join(process.cwd(), 'data', 'sy-tasks', taskId, 'bundle');
    let botName = task.params?.botName || '';
    let tenantName = task.params?.tenantName || '';
    for (const p of [path.join(bundleDir, 'robot_info.json'),
      path.join(bundleDir, `bot_${task.bot_id}`, 'dev', 'robot_info.json'),
      path.join(bundleDir, `bot_${task.bot_id}`, 'prod', 'robot_info.json')]) {
      try {
        const ri = JSON.parse(fs.readFileSync(p, 'utf8'));
        botName = botName || ri?.data?.name || ri?.data?.robotName || '';
        tenantName = tenantName || ri?.data?.companyName || '';
        if (botName && tenantName) break;
      } catch { }
    }
    updateZjTask(taskId, { bot_name: botName || `bot ${task.bot_id}`, tenant_name: tenantName, stage_detail: '话术包导出完成', progress: 25 });
    log5(io, taskId, `export: bot=${botName} tenant=${tenantName}`);
    return { bundleDir };
  } catch (e) {
    // 话术包导出失败不阻断质检（材料以用户提交为准），仅记日志
    log5(io, taskId, `export: 跳过（${String(e.message || e).slice(0, 120)}）`);
    updateZjTask(taskId, { stage_detail: '话术包导出跳过（材料以提交为准）', progress: 25 });
    return { bundleDir: null };
  }
}

// ---------------- 阶段：fetch（DLC 取数 → calls.jsonl，带 day/start_time 元数据） ----------------
async function stageFetch(taskId, task, io) {
  updateZjTask(taskId, { stage: 'fetch', stage_detail: '通话取数（DLC）…', progress: 35 });
  const uploadFile = task.params?.uploadFile;
  if (uploadFile && fs.existsSync(uploadFile)) {
    // 上传文件（xlsx/csv/jsonl）直接交给 zhijian load_calls 解析（列名别名兼容），保留开始时间等元数据
    fs.copyFileSync(uploadFile, callsPath(taskId));
    const head = fs.readFileSync(uploadFile, 'utf8').split('\n').filter(Boolean).length;
    log5(io, taskId, `fetch: 使用上传文件 ${path.basename(uploadFile)}`);
    updateZjTask(taskId, { call_count: head, stage_detail: `取数完成（上传 ${head} 通）`, progress: 55 });
    return head;
  }
  // DLC 取数口径与 saas 巡检一致（外呼/呼入），额外取 start_time 按天分组
  const companyId = task.params?.companyId;
  if (!companyId) throw new Error('任务缺少 companyId（数据租户号），无法取数');
  const days = task.params?.days ?? 7;
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  const dtFrom = fmt(new Date(Date.now() - days * 86400e3));
  const dtTo = fmt(new Date());
  const inbound = task.params?.table === 'inbound';
  updateZjTask(taskId, { stage_detail: `DLC 取数 ${dtFrom}~${dtTo}${inbound ? '（呼入）' : ''}…`, progress: 40 });
  log5(io, taskId, `fetch: DLC ${dtFrom}~${dtTo} company=${companyId}`);

  const rows = [];
  const PAGE = 2000;
  if (inbound) {
    for (let offset = 0; ; offset += PAGE) {
      const sql = `SELECT l.inbound_instance_id AS call_id, l.speaker_type AS speaker_type, l.content AS content,
        i.start_time AS start_time, i.robot_name AS robot_name, i.company_name AS company_name
        FROM ${T_IN_LOG} l
        LEFT JOIN ${T_IN_INST} i ON i.inbound_instance_id = l.inbound_instance_id AND i.dt = l.dt
        WHERE l.company_id = ${companyId} AND l.dt >= '${dtFrom}' AND l.dt <= '${dtTo}' AND i.robot_def_id = ${task.bot_id}
        ORDER BY l.inbound_instance_id, l.inbound_instance_log_id LIMIT ${PAGE} OFFSET ${offset}`;
      const batch = dlcQuery(sql, [T_IN_LOG, T_IN_INST]);
      rows.push(...batch);
      if (batch.length < PAGE) break;
    }
  } else {
    for (let offset = 0; ; offset += PAGE) {
      const cond = [`company_id = ${companyId}`, `robot_def_id = ${task.bot_id}`];
      if (task.params?.minDuration) cond.push(`duration > ${Number(task.params.minDuration)}`);
      const sql = `SELECT call_instance_id, content, start_time, robot_name, company_name FROM ${T_OUT}
        WHERE dt >= '${dtFrom}' AND dt <= '${dtTo}' AND ${cond.join(' AND ')} ORDER BY call_instance_id LIMIT ${PAGE} OFFSET ${offset}`;
      const batch = dlcQuery(sql, [T_OUT]);
      rows.push(...batch);
      if (batch.length < PAGE) break;
    }
  }

  // 统一对话格式（含 day 元数据）
  const calls = [];
  if (inbound) {
    const byCall = new Map();
    for (const row of rows) {
      const id = String(row.call_id);
      if (!byCall.has(id)) byCall.set(id, { turns: [], day: String(row.start_time || '').slice(0, 10), robot: row.robot_name || '', company: row.company_name || '' });
      const role = row.speaker_type === 'AI' ? 'AI' : 'ME';
      const text = String(row.content || '').replace(/<break[^>]*>/g, '').trim();
      if (text && text !== '条件判断-条件判断节点') byCall.get(id).turns.push({ role, text });
    }
    for (const [id, v] of byCall) calls.push({ id, turns: v.turns, day: v.day, robotName: v.robot, companyName: v.company });
  } else {
    for (const row of rows) {
      const id = String(row.call_instance_id ?? row[0]);
      let content = row.content ?? row[1];
      if (typeof content === 'string') { try { content = JSON.parse(content); } catch { content = [content]; } }
      const turns = (content || []).map(line => {
        const m = String(line).match(/^(\d+):(AI|ME|用户|人工客服):(.*)$/s);
        if (m) return { role: m[2] === 'AI' ? 'AI' : 'ME', text: m[3].replace(/<break[^>]*>/g, '').trim() };
        return { role: 'ME', text: String(line).replace(/<break[^>]*>/g, '').trim() };
      }).filter(t => t.text);
      calls.push({ id, turns, day: String(row.start_time || '').slice(0, 10), robotName: row.robot_name || '', companyName: row.company_name || '' });
    }
  }
  fs.writeFileSync(callsPath(taskId), calls.map(c => JSON.stringify(c)).join('\n'));
  // 数据侧补齐 bot/租户名
  const meta = calls.find(c => c.robotName || c.companyName);
  if (meta) {
    updateZjTask(taskId, {
      bot_name: task.bot_name && task.bot_name !== `bot ${task.bot_id}` ? task.bot_name : (meta.robotName || task.bot_name),
      tenant_name: task.tenant_name || meta.companyName || '',
    });
  }
  updateZjTask(taskId, { call_count: calls.length, stage_detail: `取数完成（${calls.length} 通）`, progress: 55 });
  log5(io, taskId, `fetch: ${calls.length} 通`);
  return calls.length;
}

// ---------------- 阶段：inspect（zhijian-all 引擎） ----------------
async function stageInspect(taskId, task, io) {
  updateZjTask(taskId, { stage: 'inspect', stage_detail: '质检引擎执行中（zhijian-all 规则注册制）…', progress: 60 });
  log5(io, taskId, 'inspect: 引擎开始');
  const scDir = buildScenario(taskDir(taskId), task, task.params || {});
  const r = runZjInspect(taskDir(taskId), scDir);
  fs.writeFileSync(path.join(taskDir(taskId), 'inspect.json'), JSON.stringify(r, null, 1));
  updateZjTask(taskId, { stage_detail: `质检完成 ${r.summary.total} 通（不合格 ${r.summary.fail}）`, progress: 80 });
  log5(io, taskId, `inspect: ${r.summary.total} 通，不合格 ${r.summary.fail}，红线 ${r.summary.redline_calls}`);
  return r;
}

// ---------------- 阶段：deliver（按天 Word 报告 + 问题清单） ----------------
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function stageDeliver(taskId, task, io) {
  updateZjTask(taskId, { stage: 'deliver', stage_detail: '生成按天质检报告…', progress: 88 });
  const dir = taskDir(taskId);
  task = { ...task, ...getZjTask(taskId) };   // 取新鲜行（bot_name/tenant_name 已回填）
  const insp = JSON.parse(fs.readFileSync(path.join(dir, 'inspect.json'), 'utf8'));
  const botLabel = task.bot_name && task.bot_name !== `bot ${task.bot_id}` ? `${task.bot_name}（bot ${task.bot_id}）` : `bot ${task.bot_id}`;
  const tenantLabel = task.tenant_name ? ` · ${task.tenant_name}` : '';
  const days = {};
  for (const [day, dd] of Object.entries(insp.days || {})) {
    const py = `
import json, sys
from docx import Document
from docx.shared import Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH

day = ${JSON.stringify(day)}
bot = ${JSON.stringify(botLabel)}
tenant = ${JSON.stringify(tenantLabel)}
task_id = ${JSON.stringify(taskId)}
data = json.loads(${JSON.stringify(JSON.stringify(dd))})
sm = data["summary"]
rules_names = json.loads(${JSON.stringify(JSON.stringify({ ...require_rule_names() }))})

doc = Document()
doc.add_heading(f"AI大模型质检报告 · {day}", 0)
p = doc.add_paragraph()
p.add_run(f"{bot}{tenant}　任务 {task_id}").bold = True

doc.add_heading("一、质检汇总", 1)
tbl = doc.add_table(rows=5, cols=2)
tbl.style = "Light Grid Accent 1"
rows = [("通话总量", f'{sm["total"]} 通'), ("合格", f'{sm["pass"]} 通'),
        ("不合格", f'{sm["fail"]} 通（{round((sm["fail_rate"] or 0)*100,1)}%）'),
        ("触碰红线", f'{sm["redline_calls"]} 通'), ("平均得分", f'{sm["avg_score"]} 分')]
for i, (k, v) in enumerate(rows):
    tbl.cell(i, 0).text = k
    tbl.cell(i, 1).text = v

doc.add_heading("二、问题类型分布", 1)
if sm.get("by_rule"):
    t2 = doc.add_table(rows=len(sm["by_rule"]) + 1, cols=3)
    t2.style = "Light Grid Accent 1"
    for j, h in enumerate(["规则", "问题名称", "命中通话数"]):
        t2.cell(0, j).text = h
    for i, (rid, n) in enumerate(sm["by_rule"].items(), start=1):
        t2.cell(i, 0).text = rid
        t2.cell(i, 1).text = rules_names.get(rid, "自定义规则")
        t2.cell(i, 2).text = str(n)
else:
    doc.add_paragraph("本日未发现问题。")

doc.add_heading("三、问题通话明细（含原话证据）", 1)
bad = [r for r in data["reports"] if r.get("redline_hits") or r.get("deductions")]
for r in bad:
    h = doc.add_heading(f'{r["call_id"]}　{r["verdict"]}　{r["score"]} 分', 2)
    for f in (r.get("redline_hits") or []) + (r.get("deductions") or []):
        p = doc.add_paragraph()
        p.add_run(f'{f["rule_id"]} {f["rule_name"]}（{f["level"]} −{f["score"]}）　轮次 {f["turn_idx"]}').bold = True
        ev = doc.add_paragraph()
        run = ev.add_run("原话：" + (f.get("evidence") or "(空)"))
        run.font.color.rgb = RGBColor(0x44, 0x44, 0x44)
        doc.add_paragraph(f'判定：{f.get("detail") or ""}')
        if f.get("suggestion"):
            doc.add_paragraph(f'建议：{f["suggestion"]}')
doc.save(sys.argv[1])
print("OK")
`;
    const pyFile = path.join(dir, `report_${day}.py`);
    fs.writeFileSync(pyFile, py);
    const outFile = path.join(dir, `AI质检报告_${day}_${taskId}.docx`);
    const r2 = spawnSync(PY, [pyFile, outFile], { encoding: 'utf8', timeout: 120000 });
    if (r2.status !== 0 || !fs.existsSync(outFile)) {
      throw new Error(`报告生成失败 ${day}: ${(r2.stderr || '').slice(-300)}`);
    }
    days[day] = { file: outFile, dayData: dd };
    log5(io, taskId, `deliver: ${day} 报告完成（${dd.reports.length} 通）`);
  }
  // 问题清单（bot 维度聚合）
  const issues = collectIssues(insp.reports, botLabel);
  fs.writeFileSync(path.join(dir, 'issues.json'), JSON.stringify(issues, null, 1));
  updateZjTask(taskId, { stage_detail: `按天报告 ${Object.keys(days).length} 份`, progress: 92 });
  return { days, issues };
}

// 规则名映射进报告脚本（与 zjnotify 一致）
import { RULE_NAMES } from './zjnotify.mjs';
function require_rule_names() { return RULE_NAMES; }

// ---------------- 阶段：notify（飞书推送，任务完成即推） ----------------
async function stageNotify(taskId, task, deliver, io) {
  updateZjTask(taskId, { stage: 'notify', stage_detail: '飞书推送质检结果…', progress: 96 });
  const cfg = loadZjConfig();
  if (cfg.feishuPush === false) {
    log5(io, taskId, 'notify: 配置关闭推送，跳过');
    return { skipped: true };
  }
  const r = await pushZjTaskReport(task, deliver.days);
  log5(io, taskId, `notify: 推送 ${r.sent}/${Object.keys(deliver.days).length} 天${r.fails.length ? `，失败 ${r.fails.join(',')}` : ''}`);
  return r;
}

// ---------------- 主流程 ----------------
const taskDir = id => path.join(ZJ_DIR, id);
const callsPath = id => path.join(taskDir(id), 'calls.jsonl');

export async function runZjTask(taskId, task, io) {
  const t0 = Date.now();
  // DB row 的 params 是 JSON 字符串，统一解析
  if (typeof task.params === 'string') {
    try { task.params = JSON.parse(task.params || '{}'); } catch { task.params = {}; }
  }
  log5(io, taskId, `开始（bot ${task.bot_id}）`);
  try {
    updateZjTask(taskId, { status: 'running' });
    await stageExport(taskId, task, io);
    const n = await stageFetch(taskId, task, io);
    if (!n) throw new Error('取数为 0 通：请检查 botId/companyId/时间段或更换通话来源');
    const insp = await stageInspect(taskId, task, io);
    const deliver = await stageDeliver(taskId, task, io);
    const notify = await stageNotify(taskId, task, deliver, io);
    const result = {
      summary: insp.summary,
      days: Object.fromEntries(Object.entries(deliver.days).map(([d, v]) =>
        [d, { file: path.basename(v.file), summary: v.dayData.summary }])),
      issues: deliver.issues,
      notify: { ok: notify.ok ?? false, sent: notify.sent ?? 0, fails: notify.fails ?? [], skipped: !!notify.skipped },
      durationMs: Date.now() - t0,
    };
    updateZjTask(taskId, {
      status: 'done', stage: 'done', stage_detail: `完成：${insp.summary.total} 通，不合格 ${insp.summary.fail}`,
      progress: 100, result,
    });
    log5(io, taskId, `完成（${Date.now() - t0}ms）`);
  } catch (e) {
    updateZjTask(taskId, { status: 'failed', stage_detail: '', error: String(e.message || e).slice(0, 800) });
    log5(io, taskId, `失败：${String(e.message || e).slice(0, 300)}`);
    throw e;
  }
}

export { ZJ_DIR as ZJ_TASK_DIR, taskDir as zjTaskDir, callsPath as zjCallsPath };
