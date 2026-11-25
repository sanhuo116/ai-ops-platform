// syaudit.mjs —— 私有化全量巡检（v7 口径，siyouhua-xunjianyouhua 阶段③）
// 口径：逐句×分支顺序首中（first-match）；语义分支跳过正则；SYS 句/barge-in 语气词不判定；
//       版本混合通话（≥2 未定位 AI 轮且占比过半）整通剔除；无判定分支 step 与节点内顺序推进不计错
// 判定：命中分支的 target（经 jumpMap 解析） vs AI 实际下一句所在节点
//       ok / okDefault / okSemantic / errWrong（分支命中错误）/ errDefault（走默认未命中偏离）/ noBranchHit（可补样本）
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const norm = s => (s || '')
  .replace(/[（(]\s*停顿\s*\d+\s*[sS秒]?\s*[）)]/g, '')
  .replace(/[\s，。！？、,.!?…~—\-·；：""''（）()【】\[\]]/g, '');
const comp = p => {
  const q = (p || '').replace(/\{0<>\s*/g, '{0,').replace(/\{(\d+)<>\s*/g, '{1,');
  try { return new RegExp(q, 'u'); } catch { try { return new RegExp(q); } catch { return null; } }
};

const SYS = /(通话已转至语音留言|已转至语音留言|转至语音留言|请留下你的姓名和来电原因|您拨打的电话正在通话中|您拨打的用户已启用|通信助理漏|您好。?在吗|正在为您转接|录音完成后挂断|您好您能听到我的说话吗|您好在吗我这边听不见您的声音先挂了再见|近期诈骗案件高发为保护好您的财产安全请您耐心接听|条件判断|抱歉，刚才没有听清您的回答|请您再重复一遍|没听清您的回答)/;
const FILLER = /^(喂|嗯|啊|诶|哎|哦|噢|呃|哈|嘿|呀|哦哦|嗯嗯|哎哎|喂喂|好好好|嗯嗯嗯|嘿嘿|嚯|唷|呗|喽|咯|咦|唔|嗷|呦|嗯那|那行|嗯好|好嗯|好哒|行|中|好|在|在的|嗯对|对对|对的|是的|好的|OK|ok)(啊|呀|呢|嘛|吧|了|哈|哦|噢|嗯|哎)?$/;
const DEF = new Set(['默认', '兜底', '其他']);

export function buildEngine(flowTree) {
  // lib 归一化：{name:{ids,keywords}} 或 {name:[kw]} → {name:[kw]}
  const LIB = {};
  for (const [nm, v] of Object.entries(flowTree.lib || {})) {
    LIB[nm] = Array.isArray(v) ? v : (v.keywords || v.list || []);
  }
  const BOTS = {};
  for (const [bid, steps] of Object.entries(flowTree.bots || {})) {
    const byText = new Map();
    for (const s of steps) {
      const n = norm(s.text);
      if (n.length < 6) continue;
      const rec = {
        key: n, node: s.node, path: s.path, acceptBreak: s.acceptBreak,
        edges: (s.edges || []).map(e => {
          const own = (e.keywords || []).map(k => ({ raw: k, re: comp(k) })).filter(x => x.re);
          const side = (e.regex_side || []).flatMap(nm => (LIB[nm] || []).map(k => ({ raw: k, re: comp(k), lib: nm }))).filter(x => x.re);
          const semantic = e.semantic === true;
          let res = [], src = '';
          if (!semantic) {
            res = own.length ? own.concat(side) : (side.length ? side : ((LIB[e.branch] || []).map(k => ({ raw: k, re: comp(k), lib: e.branch })).filter(x => x.re)));
            src = own.length ? 'node' : (side.length ? 'lib-side' : 'lib-name');
          }
          return { branch: e.branch, target: e.target, res, src, semantic };
        }),
      };
      if (!byText.has(n)) byText.set(n, []);
      byText.get(n).push(rec);
    }
    BOTS[bid] = { byText };
  }
  const JM = flowTree.jumpMap || {};
  const resolve = n => (n && JM[n] && JM[n] !== n) ? resolve(JM[n]) : n;
  // acceptBreak 兼容两种结构：{node:v} 或 {botId:{node:v}}（参考任务为后者）
  let AB = flowTree.acceptBreak || {};
  if (AB && !Object.values(AB).some(v => typeof v === 'number')) {
    const flat = {};
    for (const m of Object.values(AB)) if (m && typeof m === 'object') Object.assign(flat, m);
    // 多 bot 同名节点取 min（更保守：任一环境不可打断即不可打断）
    AB = flat;
  }
  return { BOTS, resolve, AB };
}

export function makeLocator(bot) {
  const B = bot;
  return (aiText, prevNode) => {
    const t = norm(aiText);
    if (!t || t.length < 6 || SYS.test(aiText)) return null;
    const cands = B.byText.get(t);
    if (cands) {
      if (cands.length === 1) return cands[0];
      if (prevNode) {
        const pref = cands.filter(c => c.path.split('/')[0] === prevNode.node || prevNode.path.endsWith('/' + c.path.split('/')[0]) || c.path.startsWith(prevNode.path));
        if (pref.length) return pref[0];
      }
      return cands[0];
    }
    for (const [k, list] of B.byText)
      if (k.length >= 10 && t.length >= 10 && (t.startsWith(k.slice(0, 18)) || k.startsWith(t.slice(0, 18)))) {
        if (prevNode) { const p = list.filter(c => c.path.startsWith(prevNode.path) || c.node === prevNode.node); if (p.length) return p[0]; }
        return list[0];
      }
    if (t.length >= 16)
      for (const [k, list] of B.byText)
        for (let i = 0; i + 14 <= t.length; i += 7)
          if (k.includes(t.slice(i, i + 14))) {
            if (prevNode) { const p = list.filter(c => c.path.startsWith(prevNode.path) || c.node === prevNode.node); if (p.length) return p[0]; }
            return list[0];
          }
    return null;
  };
}

// 全量巡检主入口：calls.jsonl（{id,tpl,turns}）+ flowTree → stat/problems/gaps
// bot 归属：tpl 字段含任务模板名；多 bot 引擎时用 assign（id→bot）映射（由调用方按模板/线索规则生成）
export async function auditFull(taskDir, flowTree, assign, onProgress) {
  const { BOTS, resolve, AB } = buildEngine(flowTree);
  const locators = new Map();
  for (const bid of Object.keys(BOTS)) locators.set(bid, makeLocator(BOTS[bid]));

  const stat = {
    calls: 0, judged: 0, ok: 0, okDefault: 0, okSemantic: 0, okInternalSeq: 0,
    errWrong: 0, errDefault: 0, noBranchHit: 0,
    skipNoJudge: 0, lastTurn: 0, sysSkip: 0, fillerSkip: 0, versionMixCalls: 0, unassigned: 0, noBot: 0,
  };
  const problems = [], gaps = [];
  // pos 样本采样：判定正确的 (bot,node,path) 段，供阶段④回归「误翻转=0」校验
  const posSamples = [];
  const posCnt = new Map();
  const POS_PER_KEY = 300, POS_TOTAL = 60000;

  function processCall(id, tpl, turns) {
    const bid = assign.get(id);
    if (!bid) { stat.unassigned++; return; }
    const B = BOTS[bid];
    if (!B) { stat.noBot++; return; }
    const locate = locators.get(bid);
    stat.calls++;
    // AI 定位
    const stepOf = new Map();
    let prevNode = null;
    let unlocated = 0, aiN = 0;
    for (let i = 0; i < turns.length; i++) {
      if (turns[i].role !== 'AI') continue;
      aiN++;
      const raw = (turns[i].text || '').trim();
      if (!raw) continue;
      const s = locate(raw, prevNode);
      if (s) { stepOf.set(i, s); prevNode = s; }
      else if (!SYS.test(raw)) unlocated++;
    }
    const mix = unlocated >= 2 && unlocated * 2 >= aiN;
    if (mix) { stat.versionMixCalls++; return; }   // 版本混合整通剔除
    // 用户连续段
    const segs = []; let cur = null;
    for (let i = 0; i < turns.length; i++) {
      if (turns[i].role === 'ME') {
        if (!cur) { cur = { start: i, end: i, texts: [] }; segs.push(cur); }
        cur.end = i;
        const t = (turns[i].text || '').trim();
        if (t) cur.texts.push(t);
      } else cur = null;
    }
    for (const seg of segs) {
      const rawFull = seg.texts.join(' | ');
      const sub = seg.texts.map(t => t.trim()).filter(Boolean);
      if (!sub.length) continue;
      if (sub.every(t => FILLER.test(t) || t.length <= 2) && sub.length <= 4) { stat.fillerSkip++; continue; }
      const judged = sub.filter(t => !FILLER.test(t) && !SYS.test(t) && t.length >= 2);
      if (!judged.length) { stat.fillerSkip++; continue; }
      if (SYS.test(sub.join('，'))) { stat.sysSkip++; continue; }
      let ci = -1;
      for (let j = seg.start - 1; j >= 0; j--) if (stepOf.has(j)) { ci = j; break; }
      if (ci < 0) continue;
      const curStep = stepOf.get(ci);
      if (!curStep.edges.some(e => !DEF.has(e.branch))) { stat.skipNoJudge++; continue; }
      if ((AB[curStep.node] === 0 && (curStep.path === '(root)' || AB[curStep.node + '|默认子'] === 0))) { stat.skipNoJudge++; continue; }
      // 下一个不同话术 step
      let ni = -1;
      for (let j = seg.end + 1; j < turns.length; j++) {
        if (!stepOf.has(j)) continue;
        const nx = stepOf.get(j);
        if (nx.key === curStep.key) {
          let later = false;
          for (let k = j + 1; k < turns.length; k++) if (stepOf.has(k) && stepOf.get(k).key !== curStep.key) { later = true; break; }
          if (later) continue;
        }
        ni = j; break;
      }
      if (ni < 0) { stat.lastTurn++; continue; }
      stat.judged++;
      const next = stepOf.get(ni);
      // first-match：逐句×分支顺序
      const matched = new Map();
      for (const t of judged)
        for (const e of curStep.edges) {
          if (e.semantic) continue;
          for (const k of e.res)
            if (k.re.test(t)) {
              const key = e.branch + '|' + (e.target || '');
              if (!matched.has(key)) matched.set(key, { branch: e.branch, target: e.target, re: k.raw, src: e.src, utt: t });
              break;
            }
        }
      const mArr = [...matched.values()];
      const defEdge = curStep.edges.find(e => DEF.has(e.branch) && !e.semantic);
      const sameNodeSeq = (curStep.node === next.node) && (curStep.path !== next.path);
      const base = { id, bot: bid, tpl, node: curStep.node, path: curStep.path, text: rawFull, next: next.node, sub: judged };
      if (mArr.length === 0) {
        const semHit = curStep.edges.filter(e => e.semantic && e.target && (e.target === next.node || resolve(e.target) === next.node));
        if (semHit.length) { stat.okSemantic++; continue; }
        stat.noBranchHit++;
        gaps.push({ ...base, hasDefault: !!defEdge, defTarget: defEdge ? defEdge.target : null });
        if (defEdge && defEdge.target) {
          if (next.node === resolve(defEdge.target) || next.node === defEdge.target) stat.okDefault++;
          else {
            stat.errDefault++;
            problems.push({ ...base, kind: '分支走默认未命中(偏离)', expected: defEdge.target, actual: next.node, hitRe: '', detail: `无分支命中，【默认】本应去「${defEdge.target}」，实际去「${next.node}」` });
          }
        } else if (sameNodeSeq) stat.okInternalSeq++;
        else {
          stat.errDefault++;
          problems.push({ ...base, kind: '分支走默认未命中(偏离)', expected: '(默认=原地续说)', actual: next.node, hitRe: '', detail: `无分支命中，默认应为原地续说/兜底，实际去「${next.node}」` });
        }
        continue;
      }
      const targets = [...new Set(mArr.map(m => m.target ? resolve(m.target) : null).filter(Boolean))];
      const hitDesc = mArr.map(m => `${m.branch}[${m.src}]：「${m.utt.slice(0, 30)}」↤${m.re}`).join(' ┃ ');
      if (targets.length === 0) {
        if (sameNodeSeq || next.node === curStep.node) stat.ok++;
        else stat.okInternalSeq++;
        continue;
      }
      if (targets.includes(next.node)) {
        stat.ok++;
        const pk = bid + '|' + curStep.node + '|' + curStep.path;
        if (!posCnt.has(pk)) posCnt.set(pk, 0);
        if ((posCnt.get(pk) < POS_PER_KEY) && posSamples.length < POS_TOTAL) { posCnt.set(pk, posCnt.get(pk) + 1); posSamples.push({ ...base, expect: targets[0], hit: hitDesc }); }
        continue;
      }
      stat.errWrong++;
      const semAlt = curStep.edges.filter(e => e.semantic && e.target && (e.target === next.node || resolve(e.target) === next.node));
      const semNote = semAlt.length ? `（语义分支[${semAlt[0].branch}]接管，语义优先于正则）` : '';
      problems.push({ ...base, kind: '分支命中错误', expected: targets[0], actual: next.node, hitRe: hitDesc, detail: `命中[${mArr.map(m => `${m.branch}→${m.target || '原地'}`).join(' / ')}]，实际去「${next.node}」${semNote}` });
    }
  }

  const rl = readline.createInterface({ input: fs.createReadStream(path.join(taskDir, 'calls.jsonl')), crlfDelay: Infinity });
  let done = 0;
  // 输入 jsonl 支持两种形态：整通 {id,tpl,turns:[...]} 或逐轮 {id,tpl,role,text}
  let buf = [], curId = null, curTpl = '';
  const flush = () => { if (curId !== null && buf.length) processCall(curId, curTpl, buf); };
  for await (const line of rl) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (Array.isArray(d.turns)) {
      // 整通形态
      flush();
      stat.calls += 0;   // processCall 内自增
      processCall(String(d.id), d.tpl || '', d.turns.map(t => ({ role: t.role === 'AI' ? 'AI' : 'ME', text: t.text || '' })));
      if (++done % 20000 === 0 && onProgress) onProgress(done, stat);
      curId = null; buf = [];
      continue;
    }
    // 逐轮形态
    const id = String(d.id);
    if (id !== curId) {
      flush();
      curId = id; curTpl = d.tpl || ''; buf = [];
      if (++done % 20000 === 0 && onProgress) onProgress(done, stat);
    }
    buf.push({ role: d.role === 'AI' ? 'AI' : 'ME', text: d.text || '' });
  }
  flush();
  return { stat, problems, gaps, posSamples };
}
