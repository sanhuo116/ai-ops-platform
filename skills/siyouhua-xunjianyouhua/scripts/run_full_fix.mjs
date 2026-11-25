// run_full_fix.mjs —— 全量 FIX 驱动（在 audit_full 完成后运行）
import fs from 'node:fs';
const W='<WORKSPACE>/xj_calls/work';
const T=JSON.parse(fs.readFileSync(`${W}/flow_tree.json`,'utf8'));
const pos=JSON.parse(fs.readFileSync(`${W}/fix_pos_sample.json`,'utf8'));
const neg=JSON.parse(fs.readFileSync(`${W}/fix_neg_all.json`,'utf8'));
console.log('pos',pos.length,'neg',neg.length);
const comp=p=>{const q=(p||'').replace(/\{0<>\s*/g,'{0,').replace(/\{(\d+)<>\s*/g,'{1,');try{return new RegExp(q,'u')}catch{try{return new RegExp(q)}catch{return null}}};
const libRes=b=>((T.lib[b]||{}).keywords||[]).map(k=>({raw:k,re:comp(k),lib:b})).filter(x=>x.re);
const sideRes=names=>{const out=[];for(const n of names||[])for(const k of ((T.lib[n]||{}).keywords||[])){const re=comp(k);if(re)out.push({raw:k,re,lib:n})}return out};
const BOTS={};
for(const bid of Object.keys(T.bots)){
  const byKey=new Map();
  for(const s of T.bots[bid]){
    const rec={key:s.node+'|'+s.path,node:s.node,path:s.path,
      edges:s.edges.map(e=>{
        const own=(e.keywords||[]).map(k=>({raw:k,re:comp(k)})).filter(x=>x.re);
        const side=sideRes(e.regex_side);
        const semantic=e.semantic===true;
        let res=[],src='';
        if(!semantic){res=own.length?own.concat(side):(side.length?side:libRes(e.branch));src=own.length?'node':(side.length?'lib-side':'lib-name')}
        return {branch:e.branch,target:e.target,res,src,semantic};
      })};
    byKey.set(rec.key,rec);
  }
  BOTS[bid]=byKey;
}
function simSeg(seg,fixes){
  const r=BOTS[seg.bot].get(seg.node+'|'+seg.path);
  if(!r) return null;
  const eff=r.edges.map(e=>{
    if(e.semantic) return e;
    const res=[];
    for(const k of e.res){
      let rep=false;
      for(const f of fixes){
        if(f.find===k.raw){
          if(f.bot&&f.bot!==seg.bot){continue}
          if(f.node&&(f.node!==seg.node||f.path!==seg.path)){continue}
          for(const nq of f.new){const re=comp(nq);if(re)res.push({raw:nq,re,lib:'NEW'})}
          rep=true;break;
        }
      }
      if(!rep) res.push(k);
    }
    return {...e,res};
  });
  const out=[];
  for(const e of eff){ if(e.semantic) continue;
    for(const t of seg.sub){ for(const k of e.res){ if(k.re.test(t)){out.push({branch:e.branch,target:e.target});break} } }
  }
  const seen=new Set();const u=[];
  for(const m of out){const key=m.branch+'|'+(m.target||'');if(!seen.has(key)){seen.add(key);u.push(m)}}
  return u;
}
const okT=(m,next)=>{if(!m)return true;const ts=[...new Set(m.map(x=>x.target).filter(Boolean))];return ts.length===0?true:ts.includes(next)};
// ===== FIX 清单（沿用预检 11 条 + 全量驱动微调） =====
const FIX=[
 {id:'A1', lib:'否定（中性）', find:'^.?没(呢|有)(?!.{0,15}(什么|问一下|什么|干嘛|啥|是不是|有工作了?))',
  new:[`^.?没(呢|有)(?!.{0,15}(什么|问一下|什么|干嘛|啥|是不是|有工作了?|(被|受|遭)(骗|骗了|骗过|害)|损失|转[了账]?|汇款|贷[款过]?|投资|买|交|付|充|下载|点|接|做任务|刷单|理解|听懂|问题|需要|时间|空|事|办|弄|搞|碰到|遇到|其他|别的|还|完|钱|存款|印象|感觉|影响|关系|办法|结果|消息|短信|电话|链接|APP|app|软件|平台|客服|人|陌生|号码|微信|QQ|qq|来|给|说|提|问|管|理|信|干|东西|一分|块|百|千|万))`,
       `^.?没(呢|有)(?=.?.{0,24}((被|受|遭)(骗|骗了|骗过|害)|损失|转[了账]|汇款|贷[款过]|投资|买[了过]|交[了过]|付[了过]|充值|充过|下载|下过|点[击过]|接过|做任务|刷单|遇到|碰到))`]},
 {id:'A2', lib:'否定（中性）', find:'(没|无|不|未).{0,10}(关注|留意|记得|注意|想到|认知|知道|接触|遇到|碰到|弄过|搞过)',
  new:[`(没|无|不|未).{0,10}(关注|留意|记得|注意|想到|认知|知道|接触|遇到|碰到|弄过|搞过)(?!.{0,8}(什么|怎么|怎么回事|哪[里个]))`]},
 {id:'A3', lib:'否定（中性）', find:'(肯定)?没有.{0,8}不.{0,5}(?!.{0,15}(什么|干嘛|啥|诈骗|骗人|是不是))',
  new:[`(肯定)?没有.{0,8}不.{0,5}(?!.{0,15}(什么|干嘛|啥|诈骗|骗人|是不是|信|相信|会信))`]},
 {id:'B1', bot:'2928610', node:'开场白', path:'(root)', find:'(?<!(有|对|浏览|到了|可能|知道|操作|是|损失|反馈).{0<>9})[不](?!.{0<>8}([遇到这种情况吗]|有吧))',
  new:[`(?<!(有|对|浏览|到了|可能|知道|操作|是|损失|反馈|拦截|设置|接|烦|行|错|好|说|要|用|理|管|信|问|听|懂|回|办|遇|做|给|让|来|去|能|会|想|在|没|不).{0<>9})[不](?!.{0<>8}([遇到这种情况吗]|有吧|烦|错|好|行|是|要|用|理|管|信|问|听|懂|回|办|遇|做|能|会|想|在|没|客|服|销|售|贷|款|理|财|投|资|安|装|下|载|点|开|扫|码|群|友|钱|账|户|身份|证|信|息|泄|露|接|收|看|见|说|法|时|间|空|需|处|意|思|会))`]},
 {id:'B1b', bot:'2927710', node:'开场白', path:'(root)', find:'(?<!(有|对|浏览|到了|可能|知道|操作|是|损失|反馈).{0<>9})[不](?!.{0<>8}([遇到这种情况吗]|有吧))',
  new:[`(?<!(有|对|浏览|到了|可能|知道|操作|是|损失|反馈|拦截|设置|接|烦|行|错|好|说|要|用|理|管|信|问|听|懂|回|办|遇|做|给|让|来|去|能|会|想|在|没|不).{0<>9})[不](?!.{0<>8}([遇到这种情况吗]|有吧|烦|错|好|行|是|要|用|理|管|信|问|听|懂|回|办|遇|做|能|会|想|在|没|客|服|销|售|贷|款|理|财|投|资|安|装|下|载|点|开|扫|码|群|友|钱|账|户|身份|证|信|息|泄|露|接|收|看|见|说|法|时|间|空|需|处|意|思|会))`]},
 {id:'B2', bot:'2928610', node:'开场白', path:'(root)', find:'(?<!(什么|干嘛|啥|诈骗|骗人|是不是|电话|联系|你).{0<>15})没.{0<>5}有(?!.{0<>15}(删|卸|什么|干嘛|啥|诈骗|骗人|是不是|电话|联系|你))',
  new:[`(?<!(什么|干嘛|啥|诈骗|骗人|是不是|电话|联系|你|我们|人|老|年|最近|这|都|啊|呀|呢|吧|了).{0<>15})没.{0<>5}有(?!.{0<>15}(删|卸|什么|干嘛|啥|诈骗|骗人|是不是|电话|联系|你|(被|受|遭)(骗|骗了|骗过|害)|损失|转|汇|贷|投|资|买|交|付|充|下|载|点|接|刷|任务|碰到|遇到|其他|别的|还|完|钱|存款|印象|感觉|影响|关系|办法|结果|消息|短信|链接|APP|app|软件|平台|客服|陌生|号码|微信|QQ|qq|来|给|说|提|问|管|理|信|干|东西|分|块|千|万))`]},
 {id:'B3', bot:'2927710', node:'开场白', path:'(root)', find:'^.?没(呢|有)(?!.{0<>15}(删|卸|什么|干嘛|啥|是不是|联系|电话|打过|给我|和我|你))',
  new:[`^.?没(呢|有)(?!.{0<>15}(删|卸|什么|干嘛|啥|是不是|联系|电话|打过|给我|和我|你|(被|受|遭)(骗|骗了|骗过|害)|损失|转|汇|贷|投|资|买|交|付|充|下载|点|接|做任务|刷单|碰到|遇到|其他|别的|还|完|钱|存款|印象|感觉|影响|关系|办法|结果|消息|短信|链接|APP|app|软件|平台|客服|陌生|号码|微信|QQ|qq|来|给|说|提|问|管|理|信|干|东西|分|块|千|万|刷|单|子|老|年))`]},
 {id:'C1', lib:'肯定(已接到电话或信息)', find:'(?<!(没|无|不|未|检测).{0,20})(有|损失?|转[了账]|付)(?!.{0,5}(什么|啥|事|点击|点开|点进))',
  new:[`(?<!(没|无|不|未|检测|哪里|怎么|哪|钱|还).{0,20})(有|损失?|转[了账]|付)(?!.{0,5}(什么|啥|事|点击|点开|点进))`]},
 {id:'D1', lib:'省厅-肯定（中性）', find:'^嗯。$', new:[`^嗯(?!。?$)`]},
 {id:'D2', lib:'省厅-肯定（中性）', find:'^对((?![没不]).){0,5}$', new:[`^对(?!。?$)((?![没不]).){0,5}$`]},
 {id:'E1', lib:'已卸载', find:'[删卸]', new:[`(?<![没不].{0,4})[删卸]`]},
 {id:'E2', lib:'未受骗', find:'(没|无|不|未).{0,2}(被骗|损失|转账|转钱|汇款|转过|骗过|上当|损失|充钱|回款)',
  new:[`(没|无|不|未).{0,2}(被骗|损失|转账|转钱|汇款|转过|骗过|上当|损失|充钱|回款)(?!.{0,8}(但|但是|然后|后来|今天|昨天|最近|前几|上个月|100|一百|两|三|四|五|几|千|万|块))`]},
];
// ===== 全量 A/B 回归（corrective=must-keep + problems=want-flip） =====
const report=[];
for(const fix of FIX){
  let lostGood=0,gainGood=0,flipBad=0,keepBad=0,changedSeg=0;
  const lostEx=[],flipEx=[];
  const check=(seg)=>{
    const o=simSeg(seg,[]),n=simSeg(seg,[fix]);
    const ok=(m)=>{const ts=[...new Set((m||[]).map(x=>x.target).filter(Boolean))];return ts.length===0?true:ts.includes(seg.next)};
    const og=ok(o),ng=ok(n);
    const oKey=(o||[]).map(m=>m.branch).sort().join(','),nKey=(n||[]).map(m=>m.branch).sort().join(',');
    if(oKey!==nKey){
      changedSeg++;
      if(og&&!ng){lostGood++;if(lostEx.length<3)lostEx.push(seg.text.slice(0,44))}
      if(!og&&ng){flipBad++;if(flipEx.length<3)flipEx.push(seg.text.slice(0,44))}
      if(og&&ng){} if(!og&&!ng){}
    }
  };
  // 预筛：hit/hitRe 字符串含 FIX.find 才需模拟（find 里 {0<>N} 在 hitRe 中可能已转换，双口径都试）
  const findVariants=[fix.find, fix.find.replace(/<>/g, ',')];
  const filt=(arr)=>arr.filter(s=>{
    const h=s.hit||s.hitRe;
    if(!h) return false;
    return findVariants.some(v=>h.includes(v));
  });
  const posF=filt(pos), negF=filt(neg);
  console.log(`   prefilter: pos=${posF.length} neg=${negF.length}`);
  for(const seg of posF) check({...seg, sub:seg.sub});
  for(const seg of negF) if(seg.sub) check({...seg, sub:seg.sub, next:seg.next||seg.actual});
  report.push({id:fix.id,lib:fix.lib||`${fix.bot} ${fix.node}`,find:fix.find,new:fix.new,changedSeg,lostGood,flipBad,lostEx,flipEx});
  console.log(`${fix.id} changed=${changedSeg} lostGood=${lostGood} flipBad→good=${flipBad}`);
  lostEx.forEach(e=>console.log('   LOST',e));
  flipEx.forEach(e=>console.log('   FIXES',e));
}
fs.writeFileSync(`${W}/full_fix_report.json`,JSON.stringify(report,null,1));
