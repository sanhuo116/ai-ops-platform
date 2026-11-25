// 完成字段级收尾：answerKeywordDef[否定] 里的 B2 旧式一并替换（当前根节点）
import fs from 'node:fs';
const BOT='2928610', SD=2922110, SR=2921910, SN=48106810;
const OLD_B2='(?<!(什么|干嘛|啥|诈骗|骗人|是不是|电话|联系|你).{0<>15})没.{0<>5}有(?!.{0<>15}(删|卸|什么|干嘛|啥|诈骗|骗人|是不是|电话|联系|你))';
const NEW_B2=JSON.parse(fs.readFileSync('xj_calls/work/full_fix_report.json','utf8')).find(f=>f.id==='B2').new[0];

const list0 = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const tab = list0.find(t=>t.type==='page' && (t.url||'').includes('sh.planet.byai.com/byplanet/botlab/bot/'));
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id=0; const pend=new Map();
const send=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}))});
await new Promise(r=>ws.onopen=r);
ws.onmessage=e=>{const d=JSON.parse(e.data);if(d.id&&pend.has(d.id)){pend.get(d.id)(d);pend.delete(d.id)}};
await send('Runtime.enable');
const ev = async (js) => {
  const r = await send('Runtime.evaluate',{expression:`(async()=>{${js}})()`,returnByValue:true,awaitPromise:true});
  if (r.result?.exceptionDetails) throw new Error('EXC '+(r.result.exceptionDetails.exception?.description||'').slice(0,300));
  return r.result?.result?.value;
};
const treeUrl = `/bygw/decision/api/devDecision/decisionTree?environment=dev&sceneDefId=${SD}&sceneNodeId=${SN}&sceneRecordId=${SR}`;
const before = await ev(`const r = await fetch('${treeUrl}', {credentials:'include'}); return await r.text();`);
const bj = JSON.parse(before);
const root = bj.data.decisionNodeBO;
let n=0;
function fixAkd(node){
  let akd=node.answerKeywordDef;
  if (typeof akd==='string') { try{akd=JSON.parse(akd)}catch{akd=null} }
  if (akd && Array.isArray(akd['否定'])) {
    akd['否定']=akd['否定'].map(x=>{ if(x===OLD_B2){n++; return NEW_B2} return x });
    node.answerKeywordDef = typeof node.answerKeywordDef==='string' ? JSON.stringify(akd) : akd;
  }
  for (const c of (node.childrenList||[])) fixAkd(c);
}
fixAkd(root);
console.log('answerKeywordDef 替换:', n, '处');
if (n>0) {
  const payload = { decisionNodeVO: root, sceneDefId: SD, sceneNodeId: SN, unrelationDecisionList: [], hasProhibitedWords: 0 };
  const postRes = await ev(`const r = await fetch('/bygw/decision/api/devDecision/updateTree', {method:'POST',credentials:'include',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(${JSON.stringify(payload)})}); return r.status+' :: '+(await r.text()).slice(0,200);`);
  console.log('updateTree →', postRes);
}
// 终验
await new Promise(r=>setTimeout(r,1500));
const after = await ev(`const r = await fetch('${treeUrl}', {credentials:'include'}); return await r.text();`);
fs.writeFileSync('xj_calls/after_platform_2928610_48106810.json', after);
const hasOld = after.includes(OLD_B2);
const hasNew = after.includes(NEW_B2.slice(0,80));
console.log(`终验: 旧式全文残留=${hasOld} 新式全文存在=${hasNew} → ${(!hasOld&&hasNew)?'✓ 完成':'✗'}`);
ws.close();
