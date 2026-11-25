// 平台单点修改：2928610 开场白(48106810) 否定分支 B2 式替换（dev 环境）
// 步骤：备份平台当前树 → 替换 keyword 元素 → POST updateTree → 回读验证
import fs from 'node:fs';

const BOT='2928610', SD=2922110, SR=2921910, SN=48106810;
const OLD_B2='(?<!(什么|干嘛|啥|诈骗|骗人|是不是|电话|联系|你).{0<>15})没.{0<>5}有(?!.{0<>15}(删|卸|什么|干嘛|啥|诈骗|骗人|是不是|电话|联系|你))';
const NEW_B2=JSON.parse(fs.readFileSync('xj_calls/work/full_fix_report.json','utf8')).find(f=>f.id==='B2').new[0];

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
  if (r.result?.exceptionDetails) throw new Error('EXC ' + (r.result.exceptionDetails.exception?.description||'').slice(0,300));
  return r.result?.result?.value;
};
const treeUrl = `/bygw/decision/api/devDecision/decisionTree?environment=dev&sceneDefId=${SD}&sceneNodeId=${SN}&sceneRecordId=${SR}`;

// 0) 读页面 bind token（保存接口可能需要）
const tok = await ev(`return JSON.stringify({ls: Object.keys(localStorage).filter(k=>k.includes('bind')).map(k=>k+'='+(localStorage.getItem(k)||'').slice(0,60))})`);
console.log('bind keys:', tok);

// 1) 备份平台当前树
const before = await ev(`const r = await fetch('${treeUrl}', {credentials:'include'}); return await r.text();`);
const bj = JSON.parse(before);
if (bj.code!==200) { console.error('GET 失败', before.slice(0,200)); process.exit(1); }
fs.writeFileSync('xj_calls/backup_platform_2928610_48106810.json', before);
console.log('备份完成: xj_calls/backup_platform_2928610_48106810.json', before.length, 'bytes');

// 2) 定位并替换 keyword 元素（仅 1 处）
const root = bj.data.decisionNodeBO;
let hits=[];
(function walk(n, loc){
  const kw=n.keyword;
  if (typeof kw==='string' && kw) {
    const els=kw.split(',');
    if (els.includes(OLD_B2)) hits.push({node:n, loc, els});
  }
  for (const c of (n.childrenList||[])) walk(c, loc+'/'+((n.answerIds||[])[0]||''));
})(root, '');
console.log('定位:', hits.length, '处', hits.map(h=>h.loc+' '+(h.node.answerIds||[]).join('|')));
if (hits.length!==1) { console.error('预期恰好 1 处，实际', hits.length, '→ 中止'); process.exit(1); }
const {node, els} = hits[0];
node.keyword = els.map(e=>e===OLD_B2?NEW_B2:e).join(',');
// 同步该节点 decisionItemList 内的 keyword 字段（若有）
for (const it of (node.decisionItemList||[])) {
  if (typeof it.keyword==='string' && it.keyword.split(',').includes(OLD_B2)) {
    it.keyword = it.keyword.split(',').map(e=>e===OLD_B2?NEW_B2:e).join(',');
  }
}

// 3) POST updateTree
const payload = { decisionNodeVO: root, sceneDefId: SD, sceneNodeId: SN, unrelationDecisionList: [], hasProhibitedWords: 0 };
const postRes = await ev(`const r = await fetch('/bygw/decision/api/devDecision/updateTree', {method:'POST',credentials:'include',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(${JSON.stringify(payload)})}); return r.status+' :: '+(await r.text()).slice(0,300);`);
console.log('updateTree →', postRes);

// 4) 回读验证
await new Promise(r=>setTimeout(r,1500));
const after = await ev(`const r = await fetch('${treeUrl}', {credentials:'include'}); return await r.text();`);
const aj = JSON.parse(after);
let found=0;
(function walk(n){ const kw=n.keyword; if(typeof kw==='string'&&kw&&kw.split(',').includes(NEW_B2)) found++; for(const c of (n.childrenList||[])) walk(c); })(aj.data.decisionNodeBO);
let oldLeft=0;
(function walk(n){ const kw=n.keyword; if(typeof kw==='string'&&kw&&kw.split(',').includes(OLD_B2)) oldLeft++; for(const c of (n.childrenList||[])) walk(c); })(aj.data.decisionNodeBO);
fs.writeFileSync('xj_calls/after_platform_2928610_48106810.json', after);
console.log(`回读验证: 新式出现 ${found} 处, 旧式残留 ${oldLeft} 处 → ${found>=1&&oldLeft===0?'✓ 平台已更新':'✗ 未生效'}`);
ws.close();
