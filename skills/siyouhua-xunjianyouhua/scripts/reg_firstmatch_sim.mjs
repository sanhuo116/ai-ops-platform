// 终版配置回归：N1 全局否定分支；N2(收紧) 仅开场白 root/默认
import fs from 'node:fs';
const W='xj_calls/work/';
const T=JSON.parse(fs.readFileSync(W+'flow_tree.json','utf8'));
const pos=JSON.parse(fs.readFileSync(W+'fix_pos_sample.json','utf8'));
const neg=JSON.parse(fs.readFileSync(W+'full_problems.json','utf8'));
const gaps=JSON.parse(fs.readFileSync(W+'full_gaps.json','utf8'));
const comp=p=>{const q=(p||'').replace(/\{0<>\s*/g,'{0,').replace(/\{(\d+)<>\s*/g,'{1,');try{return new RegExp(q,'u')}catch{try{return new RegExp(q)}catch{return null}}};
const libRes=b=>((T.lib[b]||{}).keywords||[]).map(k=>({raw:k,re:comp(k)})).filter(x=>x.re);
const sideRes=names=>{const out=[];for(const n of names||[])for(const k of ((T.lib[n]||{}).keywords||[])){const re=comp(k);if(re)out.push({raw:k,re,lib:n})}return out};
const BOTS={};
for(const bid of ['2927710','2928610']){
  const byKey=new Map();
  for(const s of T.bots[bid]){
    byKey.set(s.node+'|'+s.path, {edges:s.edges.map(e=>{
      const own=(e.keywords||[]).map(k=>({raw:k,re:comp(k)})).filter(x=>x.re);
      const side=sideRes(e.regex_side);
      let res=[]; if(e.semantic!==true) res=own.length?own.concat(side):(side.length?side:libRes(e.branch));
      return {branch:e.branch,target:e.target,res,semantic:e.semantic===true};
    })});
  }
  BOTS[bid]=byKey;
}
const N1=`^[嗯哦哎呃欸诶啊呀哈咳对好行是的呢嘛吧哦噢呦哟]{0,3}[，,。.、\\s]*没(有|呀|啊|呢|嘛|事|啥)?[。，,．.\\s!！?？~]{0,3}$`;
const N2=`(拉黑|拒接?|不接|没接|不理|不(信|相?信)|没理|没点(开|击|过)?|没(扫|装|参与|参加)|不上当|没上当)`;
function simRoute(bot,node,path,sub){
  const r=BOTS[bot]&&BOTS[bot].get(node+'|'+path);
  if(!r) return null;
  for(const t of sub){
    for(const e of r.edges){
      if(e.semantic) continue;
      let res=e.res;
      if(e.branch==='否定'){
        res=res.concat([{raw:'N1',re:comp(N1)}]);
        if(node==='开场白') res=res.concat([{raw:'N2',re:comp(N2)}]);
      }
      for(const k of res) if(k.re.test(t)) return {branch:e.branch,target:e.target,utt:t,why:k.raw};
    }
  }
  return null;
}
const ok=(m,next,node)=> m ? (m.target===next || (!m.target && next===node)) : (next===node);
let posBad=0,posGood=0,negFix=0,negBreak=0,gapGain=0; const exBad=[],exBrk=[];
for(const s of pos){
  if(!s.sub) continue;
  const o=simRoute(s.bot,s.node,s.path,s.sub);
  const n=simRoute(s.bot,s.node,s.path,s.sub);  // 同函数（已含N1/N2），需对照基线：用无补式版本
}
// 基线（无补式）
function simBase(bot,node,path,sub){
  const r=BOTS[bot]&&BOTS[bot].get(node+'|'+path);
  if(!r) return null;
  for(const t of sub){
    for(const e of r.edges){
      if(e.semantic) continue;
      for(const k of e.res) if(k.re.test(t)) return {branch:e.branch,target:e.target,utt:t};
    }
  }
  return null;
}
for(const s of pos){
  if(!s.sub) continue;
  const o=simBase(s.bot,s.node,s.path,s.sub), n=simRoute(s.bot,s.node,s.path,s.sub);
  if(ok(o,s.next,s.node)&&!ok(n,s.next,s.node)){ posBad++; if(exBad.length<5) exBad.push(s.text.slice(0,46)+' ['+(o?o.branch:'-')+'→'+(n?n.branch:'-')+'@'+(n?n.why:'')+']'); }
  if(!ok(o,s.next,s.node)&&ok(n,s.next,s.node)) posGood++;
}
for(const s of neg){
  if(!s.sub) continue;
  const o=simBase(s.bot,s.node,s.path,s.sub), n=simRoute(s.bot,s.node,s.path,s.sub);
  if(ok(o,s.next,s.node)&&!ok(n,s.next,s.node)){ negBreak++; if(exBrk.length<5) exBrk.push(s.text.slice(0,46)+' ['+(o?o.branch:'-')+'→'+(n?n.branch:'-')+']'); }
  if(!ok(o,s.next,s.node)&&ok(n,s.next,s.node)) negFix++;
}
for(const g of gaps){
  if(!g.sub) continue;
  const o=simBase(g.bot,g.node,g.path,g.sub);
  const n=simRoute(g.bot,g.node,g.path,g.sub);
  if(!o && n && n.target===g.next) gapGain++;
}
console.log(`pos: 误翻转=${posBad} 修正=${posGood} | neg: 修复=${negFix} 破坏=${negBreak} | gap增益=${gapGain}`);
exBad.forEach(e=>console.log('  ✗BAD',e));
exBrk.forEach(e=>console.log('  ✗BRK',e));
