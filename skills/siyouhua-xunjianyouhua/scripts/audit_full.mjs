// audit_full.mjs —— 全量巡检（v7 口径）：流式 + 通话级版本过滤 + 全量问题导出
import fs from 'node:fs';
import readline from 'node:readline';

const W='<WORKSPACE>/xj_calls/work';
const T=JSON.parse(fs.readFileSync(`${W}/flow_tree.json`,'utf8'));
const norm=s=>(s||'').replace(/[（(]\s*停顿\s*\d+\s*[sS秒]?\s*[）)]/g,'').replace(/[\s，。！？、,.!?…~—\-·；：""''（）()【】\[\]]/g,'');
const comp=p=>{const q=(p||'').replace(/\{0<>\s*/g,'{0,').replace(/\{(\d+)<>\s*/g,'{1,');try{return new RegExp(q,'u')}catch{try{return new RegExp(q)}catch{return null}}};
const libRes=b=>((T.lib[b]||{}).keywords||[]).map(k=>({raw:k,re:comp(k),lib:b})).filter(x=>x.re);
const sideRes=names=>{const out=[];for(const n of names||[])for(const k of ((T.lib[n]||{}).keywords||[])){const re=comp(k);if(re)out.push({raw:k,re,lib:n})}return out};

const BOTS={};
for(const bid of Object.keys(T.bots)){
  const byText=new Map(); const byNode=new Map();
  for(const s of T.bots[bid]){
    const n=norm(s.text);
    if(n.length<6) continue;
    const rec={key:n,node:s.node,path:s.path,
      edges:s.edges.map(e=>{
        const own=(e.keywords||[]).map(k=>({raw:k,re:comp(k)})).filter(x=>x.re);
        const side=sideRes(e.regex_side);
        const semantic=e.semantic===true;
        let res=[],src='';
        if(!semantic){
          res=own.length?own.concat(side):(side.length?side:libRes(e.branch));
          src=own.length?'node':(side.length?'lib-side':'lib-name');
        }
        return {branch:e.branch,target:e.target,res,src,semantic};
      })};
    if(!byText.has(n)) byText.set(n,[]);
    byText.get(n).push(rec);
    if(!byNode.has(s.node)) byNode.set(s.node,[]);
    byNode.get(s.node).push(rec);
  }
  BOTS[bid]={byText,byNode};
}
const JM=(T.jumpMap&&T.jumpMap['2934010'])||{};
const resolve=n=>(n&&JM[n]&&JM[n]!==n)?resolve(JM[n]):n;
const SYS=/(通话已转至语音留言|已转至语音留言|转至语音留言|请留下你的姓名和来电原因|您拨打的电话正在通话中|您拨打的用户已启用|通信助理漏|您好。?在吗|正在为您转接|录音完成后挂断|您好您能听到我的说话吗|您好在吗我这边听不见您的声音先挂了再见|近期诈骗案件高发为保护好您的财产安全请您耐心接听|条件判断|抱歉，刚才没有听清您的回答|请您再重复一遍|没听清您的回答)/;
const FILLER=/^(喂|嗯|啊|诶|哎|哦|噢|呃|哈|嘿|呀|哦哦|嗯嗯|哎哎|喂喂|好好好|嗯嗯嗯|嘿嘿|嚯|唷|呗|喽|咯|咦|唔|嗷|呦|嗯那|那行|嗯好|好嗯|好哒|行|中|好|在|在的|嗯对|对对|对的|是的|好的|OK|ok)(啊|呀|呢|嘛|吧|了|哈|哦|噢|嗯|哎)?$/;
const DEF=new Set(['默认','兜底','其他']);

function locate(bid,aiText,prevNode){
  const t=norm(aiText);
  if(!t||t.length<6||SYS.test(aiText)) return null;
  const B=BOTS[bid];
  const cands=B.byText.get(t);
  if(cands){
    if(cands.length===1) return cands[0];
    if(prevNode){const pref=cands.filter(c=>c.path.split('/')[0]===prevNode.node||prevNode.path.endsWith('/'+c.path.split('/')[0])||c.path.startsWith(prevNode.path));if(pref.length)return pref[0]}
    return cands[0];
  }
  for(const[k,list]of B.byText)
    if(k.length>=10&&t.length>=10&&(t.startsWith(k.slice(0,18))||k.startsWith(t.slice(0,18)))){
      if(prevNode){const p=list.filter(c=>c.path.startsWith(prevNode.path)||c.node===prevNode.node);if(p.length)return p[0]}
      return list[0];
    }
  if(t.length>=16)
    for(const[k,list]of B.byText)
      for(let i=0;i+14<=t.length;i+=7)
        if(k.includes(t.slice(i,i+14))){
          if(prevNode){const p=list.filter(c=>c.path.startsWith(prevNode.path)||c.node===prevNode.node);if(p.length)return p[0]}
          return list[0];
        }
  return null;
}

// 归属表
const assign=new Map();
{
  const rl=readline.createInterface({input:fs.createReadStream(`${W}/assign_all.jsonl`),crlfDelay:Infinity});
  for await(const l of rl){const d=JSON.parse(l);assign.set(d.id,d)}
}
console.error('assigned:',assign.size);

const stat={calls:0,judged:0,ok:0,okDefault:0,errWrong:0,errDefault:0,noBranchHit:0,okInternalSeq:0,
  skipNoJudge:0,lastTurn:0,sysSkip:0,fillerSkip:0,versionMixCalls:0,versionMixTurns:0,okSemantic:0};
const problems=[],gaps=[],corrective=[];
let curId=null,buf=[],assignMeta=null;

function processCall(id,turns){
  const meta=assign.get(id);
  if(!meta) return;
  const bid=meta.bot;
  stat.calls++;
  // AI 定位
  const stepOf=new Map(); let prevNode=null; let unlocated=0, aiN=0;
  for(let i=0;i<turns.length;i++){
    if(turns[i].role!=='AI') continue;
    aiN++;
    const raw=(turns[i].text||'').trim();
    if(!raw) continue;
    const s=locate(bid,raw,prevNode);
    if(s){stepOf.set(i,s);prevNode=s}
    else if(!SYS.test(raw)) unlocated++;
  }
  const mix=unlocated>=2&&unlocated*2>=aiN;
  if(mix){stat.versionMixCalls++;stat.versionMixTurns+=unlocated;}
  // 用户段
  const segs=[];let cur=null;
  for(let i=0;i<turns.length;i++){
    if(turns[i].role==='ME'){
      if(!cur){cur={start:i,end:i,texts:[]};segs.push(cur)}
      cur.end=i;
      const t=(turns[i].text||'').trim();
      if(t)cur.texts.push(t);
    } else cur=null;
  }
  for(const seg of segs){
    const rawFull=seg.texts.join(' | ');
    const sub=seg.texts.map(t=>t.trim()).filter(Boolean);
    if(!sub.length) continue;
    if(sub.every(t=>FILLER.test(t)||t.length<=2)&&sub.length<=4){stat.fillerSkip++;continue}
    const judged=sub.filter(t=>!FILLER.test(t)&&!SYS.test(t)&&t.length>=2);
    if(!judged.length){stat.fillerSkip++;continue}
    if(SYS.test(sub.join('，'))){stat.sysSkip++;continue}
    let ci=-1;
    for(let j=seg.start-1;j>=0;j--) if(stepOf.has(j)){ci=j;break}
    if(ci<0) continue;
    const curStep=stepOf.get(ci);
    if(!curStep.edges.some(e=>!DEF.has(e.branch))){stat.skipNoJudge++;continue}
    const AB=(T.acceptBreak&&T.acceptBreak[bid])||{};
    if(AB[curStep.node]===0&&(curStep.path==='(root)'||AB[curStep.node+'|默认子']===0)){stat.skipNoJudge++;continue}
    let ni=-1;
    for(let j=seg.end+1;j<turns.length;j++){
      if(!stepOf.has(j)) continue;
      const nx=stepOf.get(j);
      if(nx.key===curStep.key){
        let later=false;
        for(let k=j+1;k<turns.length;k++) if(stepOf.has(k)&&stepOf.get(k).key!==curStep.key){later=true;break}
        if(later) continue;
      }
      ni=j;break;
    }
    if(ni<0){stat.lastTurn++;continue}
    if(mix) continue;
    stat.judged++;
    const next=stepOf.get(ni);
    const matched=new Map();
    for(const t of judged)
      for(const e of curStep.edges)
        if(!e.semantic)
          for(const k of e.res)
            if(k.re.test(t)){
              const key=e.branch+'|'+(e.target||'');
              if(!matched.has(key))matched.set(key,{branch:e.branch,target:e.target,re:k.raw,src:e.src,utt:t});
              break;
            }
    const mArr=[...matched.values()];
    const defEdge=curStep.edges.find(e=>DEF.has(e.branch)&&!e.semantic);
    const sameNodeSeq=(curStep.node===next.node)&&(curStep.path!==next.path);
    const base={id,bot:bid,tpl:meta.tpl,node:curStep.node,path:curStep.path,text:rawFull,next:next.node,
      branches:curStep.edges.map(e=>`${e.branch}${e.target?'→'+e.target:''}`).join('|'),sub:judged};
    if(mArr.length===0){
      const semHit=curStep.edges.filter(e=>e.semantic&&e.target&&(e.target===next.node||resolve(e.target)===next.node));
      if(semHit.length){stat.okSemantic++;continue}
      stat.noBranchHit++;
      gaps.push({...base,hasDefault:!!defEdge,defTarget:defEdge?defEdge.target:null});
      if(defEdge&&defEdge.target){
        if(next.node===resolve(defEdge.target)||next.node===defEdge.target)stat.okDefault++;
        else{stat.errDefault++;
          problems.push({...base,kind:'分支走默认未命中(偏离)',expected:defEdge.target,actual:next.node,hitRe:'',
            detail:`无分支命中，【默认】本应去「${defEdge.target}」，实际去「${next.node}」`});}
      } else if(sameNodeSeq) stat.okInternalSeq++;
      else{stat.errDefault++;
        problems.push({...base,kind:'分支走默认未命中(偏离)',expected:'(默认=原地续说)',actual:next.node,hitRe:'',
          detail:`无分支命中，默认应为原地续说/兜底，实际去「${next.node}」`});}
      continue;
    }
    const targets=[...new Set(mArr.map(m=>m.target?resolve(m.target):null).filter(Boolean))];
    const hitDesc=mArr.map(m=>`${m.branch}[${m.src}]：「${m.utt}」↤${m.re}`).join(' ┃ ');
    if(targets.length===0){
      if(sameNodeSeq||next.node===curStep.node){stat.ok++;corrective.push({...base,ok:1,hit:hitDesc})}
      else stat.okInternalSeq++;
      continue;
    }
    if(targets.includes(next.node)){stat.ok++;corrective.push({...base,ok:1,hit:hitDesc});continue}
    stat.errWrong++;
    const semAlt=curStep.edges.filter(e=>e.semantic&&e.target&&(e.target===next.node||resolve(e.target)===next.node));
    const semNote=semAlt.length?`（语义分支[${semAlt[0].branch}]接管，语义优先于正则）`:'';
    problems.push({...base,kind:'分支命中错误',expected:targets[0],actual:next.node,hitRe:hitDesc,
      detail:`命中[${mArr.map(m=>`${m.branch}→${m.target||'原地'}`).join(' / ')}]，实际去「${next.node}」${semNote}`});
  }
}

const rl=readline.createInterface({input:fs.createReadStream(`${W}/turns.jsonl`),crlfDelay:Infinity});
let n=0;
for await(const line of rl){
  if(!line.trim()) continue;
  const d=JSON.parse(line);
  if(d.id!==curId){
    if(curId!==null&&buf.length) processCall(curId,buf);
    curId=d.id; buf=[]; 
    if(++n%100000===0) console.error('calls',n,'stat',JSON.stringify(stat));
  }
  buf.push(d);
}
if(curId!==null&&buf.length) processCall(curId,buf);

console.error('FINAL', JSON.stringify(stat,null,1));
fs.writeFileSync(`${W}/full_problems.json`,JSON.stringify(problems));
fs.writeFileSync(`${W}/full_gaps.json`,JSON.stringify(gaps));
fs.writeFileSync(`${W}/full_correct.json`,JSON.stringify(corrective));
fs.writeFileSync(`${W}/full_stat.json`,JSON.stringify(stat,null,1));
console.error('problems',problems.length,'gaps',gaps.length,'correct',corrective.length);
