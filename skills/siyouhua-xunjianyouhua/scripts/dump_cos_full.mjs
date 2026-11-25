// 导出 5 个 bot 的话术包（dev + prod 双环境，含全局侧库），落盘 xj_calls/bundles_cos_<ts>/
import fs from 'node:fs';
const BOTS = {'2927710':2921210,'2928610':2922110,'2934010':2927510,'3138810':3132310,'2939010':2932510};
const TS = new Date().toISOString().slice(0,16).replace(/[-T:]/g,'');
const OUT = `<WORKSPACE>/xj_calls/bundles_cos_${TS}`;

const list0 = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const tab = list0.find(t=>t.type==='page' && (t.url||'').includes('sh.planet.byai.com/byplanet/botlab/bot/'));
if (!tab) { console.error('no planet tab'); process.exit(1); }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id=0; const pend=new Map();
const send=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}))});
await new Promise(r=>ws.onopen=r);
ws.onmessage=e=>{const d=JSON.parse(e.data);if(d.id&&pend.has(d.id)){pend.get(d.id)(d);pend.delete(d.id)}};
await send('Runtime.enable');
const ev = async (js) => {
  const r = await send('Runtime.evaluate',{expression:`(async()=>{${js}})()`,returnByValue:true,awaitPromise:true});
  if (r.result?.exceptionDetails) throw new Error('EXC ' + (r.result.exceptionDetails.exception?.description||'').slice(0,200));
  return r.result?.result?.value;
};
const getj = async (path) => {
  const v = await ev(`const res = await fetch('${path}', {credentials:'include'}); return await res.text();`);
  let j=null; try { j = JSON.parse(v); } catch { return {__raw:v}; }
  return j;
};
const ok = j => j && (j.code===200 || j.success===true);
const dump = async (base, path, name) => {
  const j = await getj(path);
  fs.writeFileSync(`${base}/${name}.json`, JSON.stringify(j));
  const good = ok(j);
  console.log(`${good?'OK ':'ERR'} ${name} ${JSON.stringify(j).length}B${good?'':'  '+JSON.stringify(j).slice(0,110)}`);
  return j;
};

const manifest=[];
for (const [bot, sd] of Object.entries(BOTS)) {
  console.log('=== BOT', bot);
  for (const env of ['dev','prod']) {
    const dir = `${OUT}/bot_${bot}/${env}`;
    fs.mkdirSync(`${dir}/trees`, {recursive:true});
    // 部署信息（含 sceneDefId/sceneRecordId）
    const dep = await dump(dir, `/bygw/decision/api/sceneDeploy/info?robotDefId=${bot}`, 'sceneDeploy_info');
    let SR=null;
    try { SR = (dep.data||{}).sceneRecordId; } catch {}
    // 节点清单
    const nl = await dump(dir, `/bygw/decision/api/sceneNode/list?decisionType=0&environment=${env}&sceneDefId=${sd}`, 'scene_node_list');
    const nodes = (nl && nl.data) || [];
    // 逐节点树（带 sceneRecordId）
    let tok=0, tfail=0;
    for (const n of nodes) {
      const uq = SR ? `&sceneRecordId=${SR}` : '';
      const j = await getj(`/bygw/decision/api/devDecision/decisionTree?environment=${env}&sceneDefId=${sd}&sceneNodeId=${n.sceneNodeId}${uq}`);
      fs.writeFileSync(`${dir}/trees/${n.sceneNodeId}.json`, JSON.stringify(j));
      if (ok(j)) tok++; else { tfail++; console.log('TREE-ERR', env, n.sceneNodeName, JSON.stringify(j).slice(0,90)); }
    }
    console.log(`[${env}] trees ok=${tok}/${nodes.length}`);
    if (env==='dev') {
      // robot_info / 变量 / LLM / TTS / 默认意图词 / KB
      await dump(dir, `/bygw/api/boss/robot/info?robotDefId=${bot}`, 'robot_info');
      await dump(dir, `/bygw/api/boss/robot/variable/list?robotDefId=${bot}`, 'variable_list');
      await dump(dir, `/bygw/api/boss/robot/agent/llm?robotDefId=${bot}`, 'agent_base_llm');
      await dump(dir, `/bygw/api/boss/robot/agent/tts?robotDefId=${bot}`, 'agent_tts');
      await dump(dir, `/bygw/api/boss/robot/branchDefaultKeywords?robotDefId=${bot}`, 'branch_default_keywords');
      await dump(dir, `/bygw/decision/api/knowledgeBase/list?environment=dev&robotDefId=${bot}`, 'kb_list');
    }
    manifest.push({bot, env, nodes: nodes.length, treesOk: tok, sceneRecordId: SR});
  }
}
fs.writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 1));
console.log('DONE →', OUT);
