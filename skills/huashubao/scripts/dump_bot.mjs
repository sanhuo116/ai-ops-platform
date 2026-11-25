// 百应话术包一键导出（huashubao skill）
// 用法: node dump_bot.mjs <botId> [outDir]   （sceneDefId/sceneRecordId 自动从 robot/info 推导）
// 前置: 环境变量 TOKEN(x-bind-token)；BASE 可省略（默认公安SaaS测试环境 33023910.cos.byai.com）
// 步骤0: 租户归属校验 —— bot 不在公安SaaS测试环境(33023910)的 robot/list 里时，
//        自动复制过去并改用新 botId 导出（复制去向由 token 所在环境决定，已实测跨租户可行）
// 产出: raw/*.json（后续合并/渲染见 SKILL.md 第6-8步）
import fs from 'node:fs';

const SAAS_TENANT = '33023910';                 // 公安SaaS测试环境域名前缀
const [BOT_IN, OUT = './raw'] = process.argv.slice(2);
if (!BOT_IN) { console.error('用法: node dump_bot.mjs <botId> [outDir]'); process.exit(1); }

let TOKEN = process.env.TOKEN || '';
let COOKIE = process.env.COOKIE || '';
if (!TOKEN) { console.error('缺 TOKEN 环境变量（从编辑器网络请求复制 x-bind-token）。'); process.exit(1); }

const SAAS_BASE = `https://${SAAS_TENANT}.cos.byai.com/bygw`;

async function api(path, { method = 'GET', query = null, body = null, robot = null, base = SAAS_BASE } = {}) {
  const url = base + path + (query ? '?' + new URLSearchParams(query).toString() : '');
  const r = await fetch(url, {
    method,
    headers: { 'Accept': 'application/json', 'x-bind-token': TOKEN, 'x-bind-robot': `7_${robot}`,
               ...(COOKIE ? { Cookie: COOKIE } : {}),
               ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, text: t, json: j };
}

fs.mkdirSync(OUT, { recursive: true });

async function get(path, name, robot) {
  const r = await api(path, { robot: robot });
  const ok = r.json && (r.json.code === 200 || r.json.success === true);
  console.log(`${ok ? '✔' : '✘'} ${name || path}  ${r.text.length}B`);
  if (!ok) console.log('   ', r.text.slice(0, 160));
  fs.writeFileSync(`${OUT}/${(name || path.replace(/[^a-z0-9]/gi, '_')).replace(/\.json$/, '')}.json`, r.text);
  return r.json;
}

// ---- 步骤0：租户归属校验 + 必要时复制到公安SaaS测试环境 ----
async function saasBotList() {
  const r = await api(`/decision/api/robot/list`, { query: { pageNum: 1, pageSize: 100 }, robot: BOT_IN });
  return r.json?.code === 200 ? (r.json.data?.list || []) : null;   // null = token/环境不可用
}

let BOT = String(BOT_IN);
const list = await saasBotList();
if (list === null) { console.error('✘ 33023910 环境 robot/list 不可用（token 失效或无该环境权限）'); process.exit(2); }

if (list.some(x => String(x.robotDefId) === BOT)) {
  console.log(`✔ bot ${BOT} 已在公安SaaS测试环境(${SAAS_TENANT})，直接导出`);
} else {
  console.log(`⚠ bot ${BOT} 不在 ${SAAS_TENANT} 下，执行复制…`);
  // 源 bot 的 robotType / 名称：优先在公安环境查，查不到再试源环境（跨租户读可能受限）
  let robotType = '0', srcName = `bot${BOT}`;
  const probe = await api(`/decision/api/robot/info`, { query: { robotDefId: BOT }, robot: BOT });
  if (probe.json?.code === 200 && probe.json.data) {
    robotType = String(probe.json.data.robotType ?? 0);
    srcName = probe.json.data.name || srcName;
  }
  const newName = `${srcName}-副本`;
  const cp = await api(`/decision/api/robot/copy`, {
    method: 'POST', robot: BOT,
    // 注意：参数全部走 query；isCustomizeScene 必传（缺失则 500 未知错误）
    query: { sourceRobotDefId: BOT, robotType, newRobotName: newName, environment: 'dev', isCustomizeScene: 'true' },
  });
  if (cp.json?.code === 200 && cp.json?.data) {
    BOT = String(cp.json.data);
    console.log(`✔ 复制成功：源 ${BOT_IN} → 新 botId ${BOT}（${SAAS_TENANT}）`);
  } else if (/正在进行复制操作/.test(cp.text)) {
    // 上一次复制还在异步执行：轮询列表等新 bot 出现（取最新创建的一条）
    console.log('… 复制异步执行中，轮询等待…');
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 15000));
      const l = await saasBotList();
      const cands = (l || []).filter(x => String(x.robotDefId) !== BOT && (x.name || '').includes(srcName.slice(0, 6)));
      if (cands.length) {
        BOT = String(cands.sort((a, b) => (b.gmtCreate || '').localeCompare(a.gmtCreate || ''))[0].robotDefId);
        console.log(`✔ 复制完成：新 botId ${BOT}`);
        break;
      }
    }
    if (!BOT || BOT === String(BOT_IN)) { console.error('✘ 轮询超时未发现新 bot'); process.exit(3); }
  } else {
    console.error(`✘ 复制失败：${cp.text.slice(0, 200)}`);
    console.error('   提示：副本落在 token 所在环境；token 必须是公安SaaS测试账号登录态');
    process.exit(2);
  }
}

// ---- 1. robot/info：取名 + 推导 sceneDefId / sceneRecordId（副本的 record id 会变，必须重取）----
const info = await get(`/decision/api/robot/info?robotDefId=${BOT}`, 'robot_info', BOT);
if (!info?.data) { console.error('✘ 拿不到 robot/info，终止'); process.exit(4); }
const SD = info.data.sceneDefId;
const SR = (info.data.sceneRecordList || [])[0]?.sceneRecordId;
if (!SD || !SR) { console.error('✘ robot/info 缺 sceneDefId/sceneRecordList'); process.exit(4); }
console.log(`bot=${BOT} 名称=${info.data.name} sceneDefId=${SD} sceneRecordId=${SR}`);

// ---- 2. 基础配置 ----
await get(`/decision/api/sceneDeploy/info?robotDefId=${BOT}`, 'sceneDeploy_info', BOT);
await get(`/decision/api/agent/info?anchors=base%2Cllm&environment=dev&robotDefId=${BOT}`, 'agent_base_llm', BOT);
await get(`/decision/api/agent/info?anchors=tts&environment=dev&robotDefId=${BOT}`, 'agent_tts', BOT);
const nodes = await get(`/decision/api/sceneNode/list?decisionType=0&environment=dev&sceneDefId=${SD}`, 'scene_node_list', BOT);
await get(`/decision/api/scene/variable/list?environment=dev&robotDefId=${BOT}`, 'variable_list', BOT);
await get(`/decision/api/devDecision/getBranchDefaultKeywords`, 'branch_default_keywords', BOT);
await get(`/decision/api/robot/getDevResultList?environment=dev&sceneDefId=${SD}`, 'dev_result_list', BOT);
await get(`/decision/api/crm/botlab/entity/listForRobotDefId?robotDefId=${BOT}`, 'entity_list', BOT);

// ---- 3. 全部决策树（每 sceneNode 一棵）----
fs.mkdirSync(`${OUT}/trees`, { recursive: true });
const nodeList = nodes?.data || [];
for (const n of nodeList) {
  await get(`/decision/api/devDecision/decisionTree?environment=dev&sceneDefId=${SD}&sceneNodeId=${n.sceneNodeId}&sceneRecordId=${SR}`,
    `trees/${n.sceneNodeId}`, BOT);
}

// ---- 4. 知识库（必须带 categoryIds，否则 500）----
await get(`/decision/api/knowledgeBase/list?categoryIds=1%2C2%2C3&environment=dev&robotDefId=${BOT}`, 'kb_list', BOT);

// ---- 5. 外部正则集：从树里收集 answerRegexSide 引用名，逐个拉明细 ----
const refs = new Set();
for (const n of nodeList) {
  const f = `${OUT}/trees/${n.sceneNodeId}.json`;
  if (!fs.existsSync(f)) continue;
  const root = JSON.parse(fs.readFileSync(f, 'utf8'))?.data?.decisionNodeBO;
  (function walk(x) {
    const v = x.answerRegexSide;
    if (v) { try { for (const names of Object.values(JSON.parse(v))) for (const nm of names || []) refs.add(nm); } catch {} }
    for (const c of x.childrenList || []) walk(c);
  })(root);
}
console.log('外部正则集引用:', [...refs]);
// 注意：regex/side/* 接口除 token 外还需要 Cookie（INDATA-SESSIONID 等，COOKIE 环境变量传入）；
// 且跨租户集按名称搜索 total=0，搜不到时需从已知 id 直拉 getSideBySideId
for (const nm of refs) {
  const j = await get(`/api/crm/botlab/regex/side/list?pageNum=1&pageSize=50&name=${encodeURIComponent(nm)}`, `side_list_${nm}`, BOT);
  for (const h of ((j?.data?.list) || []).filter(x => x.name === nm)) {
    await get(`/api/crm/botlab/regex/side/getSideBySideId?botSideId=${h.id}`, `side_${h.id}`, BOT);
    await get(`/api/crm/botlab/regex/side/keyword/list?botSideId=${h.id}&pageNum=1&pageSize=1000`, `side_kw_${h.id}`, BOT);
    // 大集合 botReference 可能 500，失败改用 sceneReference
    await get(`/api/crm/botlab/regex/side/sceneReference?botSideId=${h.id}&pageNum=1&pageSize=200`, `side_ref_${h.id}`, BOT).catch(() => {});
  }
}

console.log(`\n完成。源 botId=${BOT_IN} → 导出用 botId=${BOT}（公安SaaS测试环境 ${SAAS_TENANT}）`);
console.log('下一步：跑合并/渲染脚本生成 话术包_完整配置.json / 话术包_完整版.md / xlsx（见 SKILL.md 第6-8步）');
