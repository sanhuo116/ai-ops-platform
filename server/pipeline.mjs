// pipeline.mjs —— 任务流水线：话术包导出 → 通话取数 → 巡检 → 待优化库
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateTask, clearOptimizations, addOptimization, db } from './store.mjs';
import { parseBundle, parseKb, findDeadKb, auditTree, auditKb, buildOptimizations } from './stages/audit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');                    // regex-opt-platform/
const WORKSPACE = path.dirname(ROOT);                       // default-workspace/
const DATA = path.join(ROOT, 'data');
const SEED = path.join(DATA, 'seed');
const TASKS = path.join(DATA, 'tasks');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------- 话术包导出（huashubao 口径，经本机 Chrome CDP） ----------------
const CDP = 'http://127.0.0.1:9222';

async function cdpOpen(botId, tenant) {
  // 打开编辑端 iframe（无验证码）；登录态来自本机 Chrome
  const list = await (await fetch(`${CDP}/json/list`)).json();
  let pg = list.find(t => t.type === 'page' && (t.url || '').includes(`bot-gui/${botId}`));
  if (!pg) {
    tenant = tenant || await detectTenant();
    if (!tenant) throw new Error('无法确定话术租户号：请在本机 Chrome 登录百应后台（cos.byai.com），或在任务参数里填写话术租户号');
    const url = `https://${tenant}.cos.byai.com/voice-bot/bot-gui/${botId}/flow/dev`;
    const nt = await (await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
    pg = nt;
    await sleep(4000);
  }
  return pg;
}

async function detectTenant() {
  // 从已打开的 cos.byai.com 标签页推断租户号
  const list = await (await fetch(`${CDP}/json/list`)).json();
  for (const t of list) {
    const m = (t.url || '').match(/https:\/\/(\d{8})\.cos\.byai\.com/);
    if (m) return m[1];
  }
  return null;
}

async function cdpFetch(pg, url, botId, token) {
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  let id = 0;
  const p = new Map();
  const send = (m, params = {}) => new Promise(r => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params })); });
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let result;
  ws.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.id && p.has(d.id)) { p.get(d.id)(d); p.delete(d.id); }
  };
  try {
    const headers = { 'Accept': 'application/json', 'x-bind-robot': `7_${botId}` };
    if (token) headers['x-bind-token'] = token;
    const expr = `(async()=>{const r=await fetch(${JSON.stringify(url)},{credentials:'include',headers:${JSON.stringify(headers)}});const t=await r.text();return JSON.stringify({s:r.status,t:t.slice(0,2000000)});})()`;
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const v = r.result?.result?.value;
    if (!v) throw new Error('empty response');
    result = JSON.parse(v);
  } finally { try { ws.close(); } catch { } }
  if (result.s !== 200) throw new Error(`HTTP ${result.s} ${url}`);
  return JSON.parse(result.t);
}

// 从编辑器页面的真实网络请求里抓 x-bind-token（页面加载时前端 JS 请求 /bygw/ 接口自带该头）
async function captureToken(pg) {
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  let id = 0; const p = new Map();
  const send = (m, params = {}) => new Promise(r => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params })); });
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let token = null;
  ws.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.id && p.has(d.id)) { p.get(d.id)(d); p.delete(d.id); return; }
    if (d.method === 'Network.requestWillBeSent') {
      const h = d.params?.request?.headers || {};
      const t = h['x-bind-token'] || h['X-Bind-Token'];
      if (t && t.startsWith('crm_pc_bind_token_')) token = t;
    }
  };
  try {
    await send('Network.enable');
    await send('Page.enable');
    await send('Page.reload', { ignoreCache: false });
    for (let i = 0; i < 30 && !token; i++) await sleep(500);   // 最多 15s
  } catch { }
  try { ws.close(); } catch { }
  return token;
}

export async function stageExport(taskId, task) {
  updateTask(taskId, { stage: 'export', stage_detail: '连接本机 Chrome（CDP 9222）…', progress: 5 });
  let ok = false;
  try { const v = await (await fetch(`${CDP}/json/version`)).json(); ok = !!v.Browser; } catch { }
  if (!ok) throw new Error('本机 Chrome 调试端口(9222)不可用：请先启动带调试端口的 Chrome 并登录百应后台');

  updateTask(taskId, { stage_detail: '打开话术编辑器 iframe…', progress: 10 });
  const pg = await cdpOpen(task.bot_id, task.params?.botTenant);

  updateTask(taskId, { stage_detail: '抓取鉴权 token（监听页面请求）…', progress: 15 });
  const token = await captureToken(pg) || task.params?.bindToken || null;

  updateTask(taskId, { stage_detail: '拉取机器人信息…', progress: 22 });
  const tenant = task.params?.botTenant || await detectTenant();
  if (!tenant) throw new Error('无法确定话术租户号（botTenant）：请在任务参数填写，或先在 Chrome 登录 cos.byai.com');
  const base = `https://${tenant}.cos.byai.com/bygw`;
  const get = async u => {
    const d = await cdpFetch(pg, `${base}${u}`, task.bot_id, token);
    return d.data;
  };

  const robot = await get(`/decision/api/robot/info?robotDefId=${task.bot_id}`);
  const sceneDefId = robot.sceneDefId;
  updateTask(taskId, { bot_name: robot.name, stage_detail: `机器人「${robot.name}」sceneDefId=${sceneDefId}`, progress: 30 });

  const collectTrees = async (decisionType) => {
    const nodes = await get(`/decision/api/sceneNode/list?decisionType=${decisionType}&environment=dev&sceneDefId=${sceneDefId}`);
    const trees = [];
    for (const n of nodes) {
      const t = await get(`/decision/api/devDecision/decisionTree?environment=dev&sceneDefId=${sceneDefId}&sceneNodeId=${n.sceneNodeId}`);
      trees.push({ node: n, tree: t });
      await sleep(40);
    }
    return { nodes, trees };
  };

  updateTask(taskId, { stage_detail: '拉取决策树（主流程+多轮）…', progress: 38 });
  const flow = await collectTrees(0);
  const multi = await collectTrees(1);

  updateTask(taskId, { stage_detail: '拉取知识库（须带 categoryIds）…', progress: 52 });
  const kbList = await get(`/decision/api/knowledgeBase/list?categoryIds=1%2C2%2C3&environment=dev&promptType=0&robotDefId=${task.bot_id}`);
  const kb = [];
  for (const k of kbList || []) {
    try {
      kb.push(await get(`/decision/api/knowledgeBase/info?environment=dev&knowledgeBaseId=${k.knowledgeBaseId}&robotDefId=${task.bot_id}`));
    } catch { kb.push(k); }
    await sleep(30);
  }

  updateTask(taskId, { stage_detail: '拉取其余配置…', progress: 62 });
  const bundle = {
    botId: Number(task.bot_id), exportedAt: new Date().toISOString(),
    robot, sceneDefId, flow, multi, knowledgeBase: kb,
    agentBase: await get(`/decision/api/agent/info?anchors=base%2Cllm&environment=dev&robotDefId=${task.bot_id}`),
    agentTts: await get(`/decision/api/agent/info?anchors=tts&environment=dev&robotDefId=${task.bot_id}`),
    variables: await get(`/decision/api/scene/variable/list?environment=dev&robotDefId=${task.bot_id}`),
    sceneDeploy: await get(`/decision/api/sceneDeploy/info?robotDefId=${task.bot_id}`),
    sceneInfo: await get(`/decision/api/crm/botlab/scene/getByRobotId?robotDefId=${task.bot_id}`),
    branchDefaultKeywords: await get('/decision/api/devDecision/getBranchDefaultKeywords'),
  };

  const dir = path.join(TASKS, taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(bundle));
  const kbN = (bundle.knowledgeBase || []).length;
  const nodeN = (flow.nodes?.length || 0) + (multi.nodes?.length || 0);
  updateTask(taskId, {
    stage_detail: `话术包导出完成：${nodeN} 节点 / 知识库 ${kbN} 条 / ${(JSON.stringify(bundle).length / 1024).toFixed(0)}KB`,
    progress: 66,
  });
  return { bundle, robot, tenant };
}

// ---------------- 通话取数（data-sanhuo 口径，DLC 只读） ----------------
const SANHUO = path.join(process.env.HOME, '.agents', 'skills', 'data-sanhuo');
const T_OUT = 'DataLakeCatalog.byai_bigdata.dwd_call_call_instance_sh_di';
const T_IN_LOG = 'DataLakeCatalog.byai_bigdata.dwd_call_byrobotprod_inbound_instance_log_di';
const T_IN_INST = 'DataLakeCatalog.byai_bigdata.dwd_call_inbound_instance_sh_di';

function dlcQuery(sql, tables) {
  const args = ['scripts/tencent_query.py', '--config', 'references/config.json',
    '--operation', 'submit', '--credentials-keychain', '--sql', sql];
  for (const t of tables) args.push('--authorized-table', t);
  const r = spawnSync('python3', args, { cwd: SANHUO, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`DLC 取数失败：${(r.stderr || r.stdout || '').slice(0, 500)}`);
  let d;
  try { d = JSON.parse(r.stdout); } catch { throw new Error(`DLC 返回非 JSON：${(r.stdout || '').slice(0, 300)}`); }
  if (!d.ok) throw new Error(`DLC 错误：${JSON.stringify(d).slice(0, 500)}`);
  return d.rows || [];
}

// ---------------- 通话记录：三种来源 ----------------
// 1) 取数（data-sanhuo DLC）—— params.callSource = 'fetch'（默认）
// 2) 用户上传文件 —— params.callSource = 'upload'（data/tasks/<id>/calls.jsonl 已由上传接口生成）
// 3) 演示缓存 —— params.useSeed = true
// 取数与上传二选一：上传任务跳过 DLC 阶段。

export function loadUploadedCalls(taskId) {
  const f = path.join(TASKS, taskId, 'calls.jsonl');
  if (!fs.existsSync(f)) return null;
  const calls = [];
  for (const l of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    const o = JSON.parse(l);
    calls.push({ id: String(o.id), turns: (o.turns || []).map(t => ({ role: t.role === 'AI' ? 'AI' : 'ME', text: String(t.text || '') })) });
  }
  return calls;
}

export async function stageFetch(taskId, task) {
  updateTask(taskId, { stage: 'fetch', stage_detail: '检查取数凭据…', progress: 68 });
  if (!fs.existsSync(path.join(SANHUO, 'scripts', 'tencent_query.py')))
    throw new Error('未找到 data-sanhuo 取数脚本（~/.agents/skills/data-sanhuo）');

  const chk = spawnSync('python3', [path.join(SANHUO, 'scripts', 'keychain_credentials.py'), 'check'], { encoding: 'utf8' });
  if (/凭证未录入/.test((chk.stdout || '') + (chk.stderr || ''))) {
    return {
      ok: false, skipped: true,
      message: 'DLC 凭据未录入（本机钥匙串缺少腾讯云 SecretId/SecretKey/UIN）',
      howto: [
        '/usr/bin/security add-generic-password -U -a tencent-secret-id -s com.byai.tencent-business-data-query -w',
        '/usr/bin/security add-generic-password -U -a tencent-secret-key -s com.byai.tencent-business-data-query -w',
        '/usr/bin/security add-generic-password -U -a tencent-uin -s com.byai.tencent-business-data-query -w',
      ],
    };
  }

  const companyId = task.company_id || task.params?.companyId;
  if (!companyId) throw new Error('任务缺少 company_id（数据租户号），无法取数');

  const days = task.params?.days ?? 30;
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  const dtTo = fmt(new Date());
  const dtFrom = fmt(new Date(Date.now() - days * 86400e3));
  const inbound = task.params?.table === 'inbound';

  updateTask(taskId, { stage_detail: `DLC 取数 ${dtFrom}~${dtTo}（company_id=${companyId}${inbound ? '，呼入' : ''}）…`, progress: 72 });

  const rows = [];
  const PAGE = 2000;
  const whereTime = `dt >= '${dtFrom}' AND dt <= '${dtTo}'`;
  if (inbound) {
    // 呼入：log 表一行一轮，按 inbound_instance_log_id 排序才是正确对话顺序；
    // robot 过滤与状态需关联实例表（log 表无 robot_def_id）
    for (let offset = 0; ; offset += PAGE) {
      const sql = `SELECT l.inbound_instance_id AS call_id, l.speaker_type AS speaker_type, l.content AS content
        FROM ${T_IN_LOG} l
        LEFT JOIN ${T_IN_INST} i ON i.inbound_instance_id = l.inbound_instance_id AND i.dt = l.dt
        WHERE l.company_id = ${companyId} AND l.${whereTime.replace(/dt/g, 'dt')} AND i.robot_def_id = ${task.bot_id}
        ORDER BY l.inbound_instance_id, l.inbound_instance_log_id LIMIT ${PAGE} OFFSET ${offset}`;
      const batch = dlcQuery(sql, [T_IN_LOG, T_IN_INST]);
      rows.push(...batch);
      if (batch.length < PAGE) break;
    }
  } else {
    for (let offset = 0; ; offset += PAGE) {
      const cond = [`company_id = ${companyId}`, `robot_def_id = ${task.bot_id}`];
      if (task.params?.minDuration) cond.push(`duration > ${Number(task.params.minDuration)}`);
      const sql = `SELECT call_instance_id, content FROM ${T_OUT}
        WHERE ${whereTime} AND ${cond.join(' AND ')} ORDER BY call_instance_id LIMIT ${PAGE} OFFSET ${offset}`;
      const batch = dlcQuery(sql, [T_OUT]);
      rows.push(...batch);
      if (batch.length < PAGE) break;
    }
  }

  // 统一对话格式
  const calls = [];
  if (inbound) {
    const byCall = new Map();
    for (const row of rows) {
      const id = String(row.call_id);
      if (!byCall.has(id)) byCall.set(id, []);
      const role = row.speaker_type === 'AI' ? 'AI' : 'ME';
      const text = String(row.content || '').replace(/<break[^>]*>/g, '').trim();
      if (text && text !== '条件判断-条件判断节点') byCall.get(id).push({ role, text });
    }
    for (const [id, turns] of byCall) calls.push({ id, turns });
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
      calls.push({ id, turns });
    }
  }

  const dir = path.join(TASKS, taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'calls.jsonl'), calls.map(c => JSON.stringify(c)).join('\n') + '\n');
  updateTask(taskId, { stage_detail: `取数完成：${calls.length} 通电话（${dtFrom}~${dtTo}）`, progress: 78 });
  return { ok: true, calls, dtFrom, dtTo };
}

// 演示/回放：从种子数据加载
export function loadSeedCalls(botId) {
  const f = path.join(SEED, `calls_${botId}.jsonl`);
  if (!fs.existsSync(f)) return null;
  // 两种格式兼容：逐轮 {id,turn,role,text}（dialogue_turns）或整通 {id,turns:[...]}
  const byCall = new Map();
  for (const l of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    const o = JSON.parse(l);
    if (o.turns) { byCall.set(String(o.id), o.turns); continue; }
    const id = String(o.id);
    if (!byCall.has(id)) byCall.set(id, []);
    byCall.get(id).push({ role: o.role === 'AI' ? 'AI' : 'ME', text: o.text });
  }
  const calls = [];
  for (const [id, turns] of byCall) {
    turns.sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0));
    calls.push({ id, turns });
  }
  return calls;
}

export function loadSeedBundle(botId) {
  const f = path.join(WORKSPACE, 'work', 'byai-scripts', `bot_${botId}_bundle.json`);
  if (fs.existsSync(f)) return { bundle: JSON.parse(fs.readFileSync(f, 'utf8')), source: 'workspace-cache' };
  const f2 = path.join(TASKS, String(botId), 'bundle.json');
  if (fs.existsSync(f2)) return { bundle: JSON.parse(fs.readFileSync(f2, 'utf8')), source: 'task-cache' };
  return null;
}

// ---------------- 巡检用正则库 ----------------
export function listLibForAudit() {
  const rows = db.prepare(`
    SELECT l.id, l.name FROM regexlib l WHERE l.kind='branch'`).all();
  const kwStmt = db.prepare('SELECT text FROM regex_kw WHERE lib_id=?');
  return rows.map(r => ({ name: r.name, kws: kwStmt.all(r.id).map(x => x.text) }));
}

// ---------------- 主流程 ----------------
export async function runTask(taskId, task, io) {
  const log = m => io?.log?.(m);
  try {
    updateTask(taskId, { status: 'running', error: '' });
    log(`任务开始：bot=${task.bot_id}`);

    // ---- 1) 话术包（huashubao）----
    let bundle;
    const seedBundle = task.params?.useSeed ? loadSeedBundle(task.bot_id) : null;
    if (seedBundle) {
      bundle = seedBundle.bundle;
      if (bundle.robot?.name) updateTask(taskId, { bot_name: bundle.robot.name });
      if (!task.company_id && bundle.sceneInfo?.companyId) task.company_id = String(bundle.sceneInfo.companyId);
      log(`话术包：使用缓存 bot_${task.bot_id}_bundle.json（${seedBundle.source}）`);
    } else {
      const r = await stageExport(taskId, task);
      bundle = r.bundle;
    }

    // ---- 2) 通话记录（来源三选一：上传 > 演示 > 取数）----
    let calls = null;
    if (task.params?.callSource === 'upload') {
      calls = loadUploadedCalls(taskId);
      if (!calls || !calls.length) throw new Error('上传模式但未找到通话记录文件（data/tasks/' + taskId + '/calls.jsonl）');
      updateTask(taskId, { stage: 'fetch', stage_detail: `通话记录：使用上传文件 ${calls.length} 通（跳过 DLC 取数）`, progress: 78 });
      log(`通话记录：上传文件 ${calls.length} 通（跳过取数）`);
    }
    if (!calls && task.params?.useSeed) calls = loadSeedCalls(task.bot_id);
    if (calls) {
      if (task.params?.callSource !== 'upload') log(`通话记录：演示缓存 ${calls.length} 通`);
    } else {
      const r = await stageFetch(taskId, task);
      if (r.skipped) {
        log(`取数跳过：${r.message}`);
        updateTask(taskId, { stage: 'fetch', stage_detail: `取数跳过：${r.message}`, progress: 78 });
        calls = [];
      } else calls = r.calls;
    }
    if (!calls.length) throw new Error('近一个月无通话记录，无法巡检');

    // ---- 3) 巡检（guizeyouhua）----
    updateTask(taskId, { stage: 'audit', stage_detail: '解析决策树…', progress: 80 });
    const layers = parseBundle(bundle);
    const stepN = layers.flow.length + layers.multi.length;
    const edgeN = layers.flow.reduce((s, x) => s + x.edges.length, 0) + layers.multi.reduce((s, x) => s + x.edges.length, 0);
    log(`话术包解析：${stepN} 个 step / ${edgeN} 个分支`);

    const libKw = {};
    for (const r of listLibForAudit()) libKw[r.name] = r.kws;

    const okPct = st => (100 * (st.ok + st.okDefault + st.okInternalSeq + (st.okAmbig || 0)) / Math.max(1, st.steps)).toFixed(1);
    const update = (done, st) => {
      const pct = 80 + Math.round(10 * done / Math.max(1, calls.length));
      updateTask(taskId, {
        stage_detail: `巡检通话 ${done}/${calls.length}（走向正确 ${okPct(st)}%）`, progress: pct,
      });
    };

    const tree = auditTree(layers, libKw, calls, update);
    log(`巡检完成：可判定 ${tree.stat.steps} 次，走向正确 ${okPct(tree.stat)}%（走错 ${tree.stat.errWrong} / 默认偏离 ${tree.stat.errDefault} / 未命中 ${tree.stat.noMatch} / 同文歧义合法 ${tree.stat.okAmbig}）`);

    updateTask(taskId, { stage_detail: '知识库巡检…', progress: 91 });
    const kbRaw = parseKb(bundle);
    const kbAudit = auditKb(layers, kbRaw, calls);
    const deadKb = findDeadKb(kbRaw);
    log(`知识库：${kbRaw.length} 条，死条目 ${deadKb.length}，框架外意图 ${kbAudit.stat.intentNoKb} 次`);
    kbAudit.stat.deadCount = deadKb.length;

    // ---- 4) 待优化库 ----
    updateTask(taskId, { stage: 'optimize', stage_detail: '生成待优化库…', progress: 95 });
    const opt = buildOptimizations({ ...tree, layers, libKw, kbRaw, kbAudit, deadKb });
    clearOptimizations(taskId);
    for (const row of opt.rows) addOptimization(taskId, row);

    const dir = path.join(TASKS, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({
      stat: tree.stat, kbStat: kbAudit.stat, kbCount: kbRaw.length, generatedAt: new Date().toISOString(),
      counts: { problems: tree.problems.length, gaps: tree.gaps.length, opts: opt.rows.length, skipGreet: opt.skipGreet, kb: kbRaw.length },
    }, null, 1));

    updateTask(taskId, { status: 'done', stage: 'done', progress: 100, stage_detail: `完成：待优化库 ${opt.rows.length} 条` });
    log(`任务完成：待优化库 ${opt.rows.length} 条`);
    return { ok: true, rows: opt.rows.length };
  } catch (e) {
    updateTask(taskId, { status: 'failed', error: String(e.message || e).slice(0, 500) });
    log(`任务失败：${e.message || e}`);
    throw e;
  }
}
