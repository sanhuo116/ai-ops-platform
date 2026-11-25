// sybundle.mjs —— 私有化话术包导出与引擎构建（siyouhua-xunjianyouhua 阶段①②）
// 通道：CDP 9222 中已登录的 sh.planet.byai.com/botlab 页签，所有平台交互只走该页签 fetch（credentials:'include'）
// 序列：sceneDeploy/info → sceneNode/list → devDecision/decisionTree（dev+prod 双环境，带 sceneRecordId）
//       侧库：answerRegexSide 具名库 → side/list 按 name 配 id → keyword/list 拉词
// 引擎：flow_tree.json {bots:{bid:[steps]}, lib:{name:[kw]}, acceptBreak}
//       step = {node, path, text, acceptBreak, edges:[{branch, target, keywords, regex_side, semantic}]}
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const norm = s => (s || '')
  .replace(/[（(]\s*停顿\s*\d+\s*[sS秒]?\s*[）)]/g, '')
  .replace(/[\s，。！？、,.!?…~—\-·；：""''（）()【】\[\]]/g, '');

// CDP 直连：找到 planet 页签并注入 fetch 抓手（复用 huashubao 技能通道，无 MCP 依赖）
export async function cdpPlanetFetch(paths, log = () => { }) {
  const listRes = await fetch('http://127.0.0.1:9222/json/list');
  if (!listRes.ok) throw new Error('CDP 9222 不可达：请先启动本机 Chrome（--remote-debugging-port=9222）');
  const tabs = await listRes.json();
  const tab = tabs.find(t => t.type === 'page' && (t.url || '').includes('sh.planet.byai.com'));
  if (!tab) throw new Error('未找到已登录的 sh.planet.byai.com 页签：请在 Chrome 中打开任一 bot 编辑页并登录');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('CDP WebSocket 连接失败')); });
  ws.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  const ev = async js => {
    const r = await send('Runtime.evaluate', { expression: `(async()=>{${js}})()`, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('页面执行异常: ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 300));
    return r.result?.result?.value;
  };
  try {
    const out = {};
    for (const p of paths) {
      const v = await ev(`const res = await fetch('${p}', {credentials:'include'}); return await res.text();`);
      let j = null; try { j = JSON.parse(v); } catch { }
      out[p] = (j !== null && j !== undefined) ? j : { __raw: String(v).slice(0, 500) };
    }
    return out;
  } finally {
    try { ws.close(); } catch { }
  }
}

const good = j => j && (j.code === 200 || j.success === true);
const asJson = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return undefined; } };

// 导出一个 bot 的话术包（dev+prod 双环境全量树 + 元数据 + 侧库）
// 支持本地夹具模式：params.referenceBundle = 已导出的话术包 zip 绝对路径（跳过 CDP）
export async function exportBotBundle(taskId, task, log) {
  const botId = task.bot_id;
  const dir = path.join(process.cwd(), 'data', 'sy-tasks', taskId);
  const bundleDir = path.join(dir, 'bundle');
  fs.mkdirSync(bundleDir, { recursive: true });

  // ---- 本地夹具模式 ----
  if (task.params && task.params.referenceBundle && fs.existsSync(task.params.referenceBundle)) {
    const zip = task.params.referenceBundle;
    log(`话术包导出：本地夹具 ${path.basename(zip)}（跳过 CDP）`);
    execSync(`unzip -o -q ${JSON.stringify(zip)} -d ${JSON.stringify(bundleDir)} -x "__MACOSX/*" "*.DS_Store"`, { timeout: 5 * 60 * 1000 });
    // zip 内是 manifest.json + bot_{id}/... 直接平铺
    const manifest = (() => { try { return JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8')); } catch { return []; } })();
    const botDir = path.join(bundleDir, `bot_${botId}`);
    if (!fs.existsSync(botDir)) throw new Error(`本地话术包中无 bot_${botId}（现有：${fs.readdirSync(bundleDir).filter(d => d.startsWith('bot_')).join('、')}）`);
    // 侧库：bot 目录下 global_sides/ 或 bundle 根部；或 params.referenceSides 指定目录
    const sideDir = [task.params.referenceSides, path.join(botDir, 'global_sides'), path.join(bundleDir, 'global_sides')]
      .filter(Boolean).find(d => fs.existsSync(d) && fs.statSync(d).isDirectory());
    let libKw = {};
    if (sideDir) {
      for (const f of fs.readdirSync(sideDir)) {
        const m = f.match(/^side_kw_(\d+)\.json$/);
        if (!m) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(sideDir, f), 'utf8'));
          const nm = j?.data?.name || j?.name || '';
          const kws = (j?.data?.keywordList || j?.keywordList || []).map(k => (typeof k === 'string' ? k : k.keyword)).filter(Boolean);
          if (nm && kws.length) libKw[nm] = kws;
        } catch { }
      }
      if (!Object.keys(libKw).length) {
        // 兼容破解目录结构：global_sides/side_<id>.json 是 {name, keywordList}
        for (const f of fs.readdirSync(sideDir)) {
          const m = f.match(/^side_(\d+)\.json$/);
          if (!m) continue;
          try {
            const j = JSON.parse(fs.readFileSync(path.join(sideDir, f), 'utf8'));
            const nm = j?.data?.name || j?.name || '';
            const kws = (j?.data?.keywordList || j?.keywordList || []).map(k => (typeof k === 'string' ? k : k.keyword)).filter(Boolean);
            if (nm && kws.length) libKw[nm] = kws;
          } catch { }
        }
      }
    }
    fs.writeFileSync(path.join(bundleDir, 'lib_kw.json'), JSON.stringify(libKw));
    const sceneName = `本地夹具·${botId}`;
    if (!fs.existsSync(path.join(bundleDir, 'manifest.json'))) fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
    log(`本地夹具就绪：manifest ${Array.isArray(manifest) ? manifest.length : 0} 项，侧库 ${Object.keys(libKw).length} 个`);
    return { bundleDir, sceneName, sceneDefId: 0, manifest, libNames: Object.keys(libKw) };
  }

  log(`话术包导出：bot ${botId}（CDP → planet 页签）`);

  // 1) 部署信息：sceneDefId / sceneRecordId（必须，否则拉树为空）
  const depPath = `/bygw/decision/api/sceneDeploy/info?robotDefId=${botId}`;
  const depMap = await cdpPlanetFetch([depPath], log);
  const dep = depMap[depPath];
  if (!good(dep)) throw new Error(`sceneDeploy/info 失败：${JSON.stringify(dep).slice(0, 200)}`);
  const depData = dep.data || {};
  const SD = depData.sceneDefId;
  const SR = depData.sceneRecordId || null;
  const sceneName = depData.sceneName || '';
  if (!SD) throw new Error('sceneDeploy 返回中无 sceneDefId');
  log(`部署信息：sceneDefId=${SD} sceneRecordId=${SR || '无'}「${sceneName}」`);

  // 2) 元数据（dev）
  const metaDefs = [
    ['robot_info', `/bygw/api/boss/robot/info?robotDefId=${botId}`],
    ['variable_list', `/bygw/api/boss/robot/variable/list?robotDefId=${botId}`],
    ['agent_base_llm', `/bygw/api/boss/robot/agent/base/llm?robotDefId=${botId}`],
    ['agent_tts', `/bygw/api/boss/robot/agent/tts?robotDefId=${botId}`],
    ['branch_default_keywords', `/bygw/api/crm/botlab/robot/branch/default/keywords?robotDefId=${botId}`],
    ['kb_list', `/bygw/api/crm/botlab/knowledge/list?robotDefId=${botId}&pageNo=1&pageSize=200`],
  ];
  let meta = {};
  try { meta = await cdpPlanetFetch(metaDefs.map(x => x[1]), log); } catch (e) { log(`元数据部分拉取失败（继续）：${e.message.slice(0, 120)}`); }
  for (const [name, p] of metaDefs) {
    if (meta[p]) fs.writeFileSync(path.join(bundleDir, `${name}.json`), JSON.stringify(meta[p]));
  }

  // 3) 节点清单 + 双环境全量树
  const manifest = [];
  const nodeCache = {};
  const sideNames = new Set();     // 全树 answerRegexSide 引用的具名库
  const uq = SR ? `&sceneRecordId=${SR}` : '';
  for (const env of ['dev', 'prod']) {
    const listPath = `/bygw/decision/api/sceneNode/list?decisionType=0&environment=${env}&sceneDefId=${SD}`;
    const lists = await cdpPlanetFetch([listPath], log);
    const nl = lists[listPath];
    if (!good(nl)) throw new Error(`sceneNode/list(${env}) 失败：${JSON.stringify(nl).slice(0, 200)}`);
    const nodes = nl.data || [];
    nodeCache[env] = nodes;
    const envDir = path.join(bundleDir, `bot_${botId}`, env);
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(path.join(envDir, 'scene_node_list.json'), JSON.stringify(nl));

    const treeDir = path.join(envDir, 'trees');
    fs.mkdirSync(treeDir, { recursive: true });
    let okN = 0;
    for (let i = 0; i < nodes.length; i += 5) {
      const batch = nodes.slice(i, i + 5);
      const paths = batch.map(n => `/bygw/decision/api/devDecision/decisionTree?environment=${env}&sceneDefId=${SD}&sceneNodeId=${n.sceneNodeId}${uq}`);
      const results = await cdpPlanetFetch(paths, log);
      for (const p of paths) {
        const j = results[p];
        const nid = p.match(/sceneNodeId=(\d+)/)[1];
        if (good(j)) {
          fs.writeFileSync(path.join(treeDir, `${nid}.json`), JSON.stringify(j));
          okN++;
          // 收集侧库引用
          const dnb = j?.data?.decisionNodeBO;
          collectSideNames(dnb, sideNames);
        }
      }
      log(`[${env}] 决策树 ${Math.min(i + 5, nodes.length)}/${nodes.length}（成功 ${okN}）`);
    }
    manifest.push({ bot: botId, env, nodes: nodes.length, treesOk: okN });
    log(`[${env}] 话术树完成：${okN}/${nodes.length}`);
  }

  // 4) 侧库：name → botSideId（side/list 全量拉一次，按 name 匹配）→ keyword/list 拉词
  const sidesDir = path.join(bundleDir, 'global_sides');
  fs.mkdirSync(sidesDir, { recursive: true });
  const libNames = [...sideNames];
  let libKw = {};   // name -> [kw]
  if (libNames.length) {
    try {
      const listPath = `/bygw/api/crm/botlab/regex/side/list?pageNum=1&pageSize=500`;
      const r = await cdpPlanetFetch([listPath], log);
      const sideList = (good(r[listPath]) ? (r[listPath].data?.list || r[listPath].data?.data || r[listPath].data || []) : []);
      const name2id = new Map();
      for (const s of sideList) if (s && s.name) name2id.set(s.name, s.id ?? s.botSideId);
      const needIds = new Map();
      for (const nm of libNames) if (name2id.has(nm)) needIds.set(nm, name2id.get(nm));
      log(`侧库引用 ${libNames.length} 个，平台匹配到 ${needIds.size} 个`);
      // 分批拉词
      const kwPaths = [...needIds.values()].map(id => `/bygw/api/crm/botlab/regex/side/keyword/list?botSideId=${id}&pageNum=1&pageSize=1000`);
      for (let i = 0; i < kwPaths.length; i += 5) {
        const results = await cdpPlanetFetch(kwPaths.slice(i, i + 5), log);
        for (const p of Object.keys(results)) {
          const j = results[p];
          if (!good(j)) continue;
          const id = Number(p.match(/botSideId=(\d+)/)[1]);
          const kws = (j.data?.list || j.data?.data || []).map(k => (typeof k === 'string' ? k : k.keyword)).filter(Boolean);
          fs.writeFileSync(path.join(sidesDir, `side_kw_${id}.json`), JSON.stringify(j));
          for (const [nm, sid] of needIds) if (sid === id && kws.length) libKw[nm] = kws;
        }
      }
      const miss = libNames.filter(nm => !libKw[nm]);
      if (miss.length) log(`侧库未匹配（回退本地种子库）：${miss.slice(0, 6).join('、')}${miss.length > 6 ? '…' : ''}`);
    } catch (e) {
      log(`侧库平台拉取失败（回退本地种子库）：${e.message.slice(0, 120)}`);
    }
  }
  fs.writeFileSync(path.join(bundleDir, 'lib_kw.json'), JSON.stringify(libKw));
  fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  log(`话术包落盘：${bundleDir}`);
  return { bundleDir, sceneName, sceneDefId: SD, manifest, libNames };
}

// 递归收集树里 answerRegexSide 引用的具名库
function collectSideNames(dnb, set) {
  if (!dnb || typeof dnb !== 'object') return;
  for (const k of ['answerRegexSide']) {
    const m = asJson(dnb[k]);
    if (m && typeof m === 'object') for (const arr of Object.values(m)) for (const x of arr || []) set.add(x);
  }
  for (const c of dnb.childrenList || []) collectSideNames(c, set);
}

// 解析单棵树（decisionNodeBO 递归）→ steps
// 巡检单元 = 树节点（一句固定话术 + 分支集）；分支去向在 childrenList[].actionParam.sceneNodeName
// 百应结构：root(普通节点, 含话术+分支定义) → children 每个分支一个节点（跳转/普通/挂机），
//   child.answerIds = 该 child 归属的分支名数组；child.keyword/answerKeywordDef = 分支词（root.keyword 是节点级补充词）
function parseTree(dnb, nodeName, lib, out, pathArr, depth = 0) {
  if (!dnb || typeof dnb !== 'object' || depth > 8) return;
  const nodeType = Number(dnb.nodeType ?? 0);
  const acceptBreak = Number(dnb.acceptBreak ?? 1);
  const items = asJson(dnb.decisionItemList) || [];
  const text = (Array.isArray(items) ? items : []).map(it => it.knowledge || '').filter(Boolean).join(' ');
  const sideDef = asJson(dnb.answerRegexSide) || {};
  const labels = asJson(dnb.labelInfoIds) || [];
  const kwRaw = String(dnb.keyword || '').trim();
  const akd = asJson(dnb.answerKeywordDef) || {};   // {标准问法: [正则]} —— 节点本地词
  const branchOrder = asJson(dnb.childrenAnswerIds) || [];
  const children = dnb.childrenList || [];

  // 仅普通节点（含话术 + 分支定义）产出巡检单元
  if (text && branchOrder.length) {
    const edges = [];
    for (const br of branchOrder) {
      const sideNames = sideDef[br] || [];
      // 归属该分支的 children：answerIds 含 br
      const own = children.filter(c => (Array.isArray(c.answerIds) ? c.answerIds : []).includes(br));
      let kws = [];
      let semantic = false;
      for (const c of own) {
        const ck = String(c.keyword || '').trim();
        if (ck) kws.push(...ck.split(',').filter(Boolean));
        const cakd = asJson(c.answerKeywordDef) || {};
        for (const arr of Object.values(cakd)) kws.push(...(arr || []));
      }
      // answerKeywordDef 值数组：key 本身是标准问法，通常 key 也要当词（如 "什么群？":[]）
      for (const [q, arr] of Object.entries(akd)) {
        // akd 不按分支分组（是节点级澄清词池），跳过——避免误归属
        void q; void arr;
      }
      if (labels.length > 0 && !kws.length && !sideNames.length) semantic = true;   // 语义分支（语义模型路由）
      edges.push({ branch: br, target: null, keywords: kws, regex_side: sideNames, semantic });
    }
    // 分支去向：从 children 的 actionParam.sceneNodeName 取（同分支多个 child 取第一个非空）
    for (const br of branchOrder) {
      const own = children.filter(c => (Array.isArray(c.answerIds) ? c.answerIds : []).includes(br));
      for (const c of own) {
        const cap = asJson(c.actionParam) || {};
        if (cap.sceneNodeName) { const e = edges.find(x => x.branch === br); if (e && !e.target) e.target = cap.sceneNodeName; }
      }
    }
    // root.keyword 是节点级词（如「嗯」→语气词分支）：归属 branchOrder 里 semantic 且名为语气词类的分支，否则第一个分支
    if (kwRaw) {
      const e = edges.find(x => /语气|语气词/.test(x.branch)) || edges.find(x => x.semantic) || edges[0];
      if (e) e.keywords.push(...kwRaw.split(',').filter(Boolean));
    }
    out.push({ node: nodeName, path: pathArr.join('/'), text, acceptBreak, edges });
  } else if (text && !branchOrder.length) {
    // 纯告知话术（无分支）：入引擎标记无判定（skipNoJudge 口径）
    out.push({ node: nodeName, path: pathArr.join('/'), text, acceptBreak, edges: [] });
  }
  for (const c of children) {
    const cap = asJson(c.actionParam) || {};
    const brLabel = (Array.isArray(c.answerIds) && c.answerIds[0]) || c.name || '';
    // 跳转节点（nodeType=1, actionParam 有 sceneNodeName）不深入（它的目标已作为 target 记录）
    if (c.nodeType === 1 && cap.sceneNodeName) continue;
    parseTree(c, cap.sceneNodeName || nodeName, lib, out, [...pathArr, brLabel || c.name || ''], depth + 1);
  }
}

// 引擎构建：bundle → flow_tree.json（bots/lib/acceptBreak）
export async function buildFlowTree(taskId, botId, log) {
  const dir = path.join(process.cwd(), 'data', 'sy-tasks', taskId);
  const bundleDir = path.join(dir, 'bundle');
  const steps = [];
  const acceptBreak = {};
  const treeDir = path.join(bundleDir, `bot_${botId}`, 'dev', 'trees');
  if (!fs.existsSync(treeDir)) throw new Error('话术树目录不存在（导出阶段未完成）');
  const nl = JSON.parse(fs.readFileSync(path.join(bundleDir, `bot_${botId}`, 'dev', 'scene_node_list.json'), 'utf8'));
  const nodes = nl.data || [];
  for (const n of nodes) {
    const f = path.join(treeDir, `${n.sceneNodeId}.json`);
    if (!fs.existsSync(f)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const dnb = j?.data?.decisionNodeBO;
      if (!dnb) continue;
      parseTree(dnb, n.sceneNodeName || '', {}, steps, ['(root)']);
      if (n.sceneNodeName && acceptBreak[n.sceneNodeName] === undefined) acceptBreak[n.sceneNodeName] = Number(dnb.acceptBreak ?? 1);
    } catch (e) { log(`树 ${n.sceneNodeId} 解析失败：${e.message.slice(0, 100)}`); }
  }
  // 侧库 lib：bundle/global_sides（平台拉取）+ lib_kw.json 合并；为空时回退本地种子库（67966 全局分支库）
  const lib = {};
  const libKwFile = path.join(bundleDir, 'lib_kw.json');
  if (fs.existsSync(libKwFile)) Object.assign(lib, JSON.parse(fs.readFileSync(libKwFile, 'utf8')));
  const sideDir = path.join(bundleDir, 'global_sides');
  if (fs.existsSync(sideDir)) {
    for (const f of fs.readdirSync(sideDir).filter(x => /^side_kw_\d+\.json$/.test(x))) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(sideDir, f), 'utf8'));
        const kws = (j.data?.list || j.data?.data || []).map(k => (typeof k === 'string' ? k : k.keyword)).filter(Boolean);
        if (kws.length && !Object.values(lib).some(a => a[0] === kws[0])) lib[`__side_${f.match(/(\d+)/)[1]}`] = kws;
      } catch { }
    }
  }
  // 去重（同一话术+path 可能出现在多个树里）
  const seen = new Set();
  const dedup = steps.filter(s => {
    const k = s.node + '|' + s.path + '|' + norm(s.text).slice(0, 40);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const bots = { [botId]: dedup };
  let botName = '';
  // robot_info：bundle 根部（CDP 模式）或 bot_{id}/{env}/robot_info.json（cos 导出夹具）
  for (const p of [path.join(bundleDir, 'robot_info.json'), path.join(bundleDir, `bot_${botId}`, 'dev', 'robot_info.json'), path.join(bundleDir, `bot_${botId}`, 'prod', 'robot_info.json')]) {
    try {
      if (!fs.existsSync(p)) continue;
      const ri = JSON.parse(fs.readFileSync(p, 'utf8'));
      botName = ri?.data?.name || ri?.data?.robotName || ri?.name || '';
      if (botName) break;
    } catch { }
  }
  const flowTree = { bots, lib, jumpMap: {}, acceptBreak, botNames: { [botId]: botName }, generatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'flow_tree.json'), JSON.stringify(flowTree));
  const kwTotal = Object.values(lib).reduce((s, a) => s + a.length, 0);
  log(`引擎构建：${dedup.length} 个巡检单元 / ${Object.keys(lib).length} 个侧库 ${kwTotal} 条词 / ${Object.keys(acceptBreak).length} 个节点`);
  return flowTree;
}
