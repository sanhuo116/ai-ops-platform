// 按 ID 直读全局分支库（跨租户可读）+ sceneReference 重名判定
import fs from 'node:fs';
const OUT = '<WORKSPACE>/xj_calls/bundles';
const lib = JSON.parse(fs.readFileSync('<WORKSPACE>/work/byai-calls/branch_lib_kw.json','utf8'));
const list0 = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const tab = list0.find(t=>t.type==='page' && (t.url||'').includes('sh.planet.byai.com'));
if (!tab) { console.error('no planet tab'); process.exit(1); }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id=0; const pend=new Map();
const send=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}))});
await new Promise(r=>ws.onopen=r);
ws.onmessage=e=>{const d=JSON.parse(e.data);if(d.id&&pend.has(d.id)){pend.get(d.id)(d);pend.delete(d.id)}};
await send('Runtime.enable');
const ev = async (js) => {
  const r = await send('Runtime.evaluate',{expression:`(async()=>{${js}})()`,returnByValue:true,awaitPromise:true});
  if (r.result?.exceptionDetails) throw new Error('EXC ' + (r.result.exceptionDetails.exception?.description||'').slice(0,140));
  return r.result?.result?.value;
};
const getj = async (path) => {
  const v = await ev(`const res = await fetch('${path}', {credentials:'include'}); return await res.text();`, 45000);
  try { return JSON.parse(v); } catch { return {__raw:v.slice(0,100)}; }
};
fs.mkdirSync(OUT+'/global_sides', {recursive:true});
// 收集全部需要的 name→ids
const need = {};
for (const b of ['3138810','2934010','2939010','2927710','2928610']) {
  const refs = JSON.parse(fs.readFileSync(`${OUT}/bot_${b}/raw/regex_refs.json`));
  for (const nm of refs) {
    if (lib[nm]) need[nm] = lib[nm].ids || [];
  }
}
console.log('need names:', Object.keys(need).length);
const seen = new Set();
const summary = [];
for (const [nm, ids] of Object.entries(need)) {
  if (!ids.length) { summary.push({nm, note:'no cached id'}); continue; }
  for (const sid of ids) {
    if (seen.has(sid)) continue; seen.add(sid);
    const det = await getj(`/bygw/api/crm/botlab/regex/side/getSideBySideId?botSideId=${sid}`);
    const kws = await getj(`/bygw/api/crm/botlab/regex/side/keyword/list?botSideId=${sid}&pageNum=1&pageSize=1000`);
    const ref = await getj(`/bygw/api/crm/botlab/regex/side/sceneReference?botSideId=${sid}&pageNum=1&pageSize=200`);
    fs.writeFileSync(`${OUT}/global_sides/side_${sid}.json`, JSON.stringify(det));
    fs.writeFileSync(`${OUT}/global_sides/side_kw_${sid}.json`, JSON.stringify(kws));
    fs.writeFileSync(`${OUT}/global_sides/side_ref_${sid}.json`, JSON.stringify(ref));
    const n = det?.data?.name; const kwN = kws?.data?.total ?? (kws?.data?.list||[]).length;
    const sceneRefs = (ref?.data||[]).map(x=>x.sceneName||x.name||JSON.stringify(x).slice(0,30)).slice(0,6);
    summary.push({nm, sid, name:n, kwN, sceneRefs});
    console.log(`${nm} id=${sid} name=${n} kw=${kwN} refs=[${sceneRefs.join('|')}]`);
  }
}
fs.writeFileSync(OUT+'/global_sides/summary.json', JSON.stringify(summary,null,1));
console.log('DONE sides:', seen.size);
process.exit(0);
