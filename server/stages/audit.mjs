// audit.mjs —— 巡检引擎（guizeyouhua 口径的 JS 移植）
//
// 输入：话术包 bundle（huashubao 导出格式）+ 通话对话 JSONL + 平台正则库（名称→正则列表）
// 输出：stat / problems / gaps / kbProblems / optimizationRows（待优化库行）
//
// 判定口径（与技能一致，勿改）：
//   step = 一句固定话术 + 它的分支集合（巡检最小单元）
//   走向正确 = ok + okDefault + okInternalSeq
//   排除三类正常行为：无判定分支的 step、节点内顺序推进、开场白纯接听
//   正则方言：{0<>N} → {0,N}；变长 lookbehind 用 V8 编译

const DEF = new Set(['默认', '兜底', '其他']);
const GREET_NODES = new Set(['开场白']);

export const norm = s => (s || '')
  .replace(/[（(]\s*停顿\s*\d+\s*[sS秒]?\s*[）)]/g, '')
  .replace(/[\s，。！？、,.!?…~—\-·；：""''（）()【】\[\]]/g, '');

export function comp(p) {
  const q = (p || '').replace(/\{0<>\s*/g, '{0,').replace(/\{(\d+)<>\s*/g, '{1,');
  try { return new RegExp(q, 'u'); } catch { }
  try { return new RegExp(q); } catch { }
  return null;
}

// ---------------- 话术包解析（决策树 → steps） ----------------
export function parseBundle(bundle) {
  const layers = {};
  for (const layer of ['flow', 'multi']) {
    const L = bundle[layer];
    if (!L) { layers[layer] = []; continue; }
    const id2name = {};
    for (const n of L.nodes || []) id2name[n.sceneNodeId] = n.sceneNodeName;
    const steps = [];
    for (const t of L.trees || []) {
      const nd = t.node || {};
      const tr = t.tree || {};
      const dnb = tr.decisionNodeBO || {};
      const nid = nd.sceneNodeId || dnb.sceneNodeId;
      const name = id2name[nid];
      if (!name) continue;
      parseDnb(dnb, name, [], steps);
    }
    layers[layer] = steps;
  }
  return layers;
}

function parseDnb(dnb, node, path, steps) {
  const txts = (dnb.decisionItemList || [])
    .map(it => (it.knowledge || '').trim()).filter(Boolean);
  let nk = {};
  try { nk = JSON.parse(dnb.answerKeywordDef || '{}') || {}; } catch { }
  let sideMap = {};
  const s = dnb.answerRegexSide;
  if (s && s !== '{}' && s !== '') { try { sideMap = JSON.parse(s) || {}; } catch { } }

  const edges = [];
  for (const ch of dnb.childrenList || []) {
    const br = (ch.answerIds || [null])[0];
    if (!br) continue;
    let tgt = null;
    if (ch.actionParam) {
      try { tgt = JSON.parse(ch.actionParam).sceneNodeName; } catch { tgt = ch.actionParam; }
    }
    let kws = [];
    try {
      const own = JSON.parse(ch.answerKeywordDef || '{}') || {};
      if (own[br]) kws = [...own[br]];
    } catch { }
    if (!kws.length && nk[br]) kws = [...nk[br]];
    edges.push({
      branch: br, target: tgt, keywords: kws,
      regex_side: [...(sideMap[br] || [])], child: ch,
    });
  }

  for (const t of txts) {
    steps.push({
      id: `${node}|${path.join('/') || '(root)'}|${steps.length}`,
      node, path: path.join('/') || '(root)', text: t,
      edges: edges.map(e => ({ branch: e.branch, target: e.target, keywords: e.keywords, regex_side: e.regex_side })),
    });
  }
  for (const e of edges) parseDnb(e.child, node, [...path, e.branch], steps);
}

// ---------------- 知识库解析 ----------------
export function parseKb(bundle) {
  const out = [];
  for (const k of bundle.knowledgeBase || []) {
    const std = (k.standardQuestion || '').trim();
    let sims = [];
    const sim = k.similarityQuestion ?? k.similarQuestionList;
    const simArr = typeof sim === 'string'
      ? (['', '[]', 'null', 'None'].includes(sim.trim()) ? [] : safeParseOrSplit(sim))
      : Array.isArray(sim) ? sim : [];
    for (const x of simArr) { const v = String(x).trim(); if (v && v !== '[]' && v !== 'null') sims.push(v); }

    let tgt = null;
    if (k.actionParam) { try { tgt = JSON.parse(k.actionParam).sceneNodeName; } catch { } }
    const answers = (k.knowledgeBaseAnswerList || [])
      .map(a => (a.answer || a.knowledge || '').trim()).filter(Boolean);
    out.push({
      id: k.knowledgeBaseId,
      title: (k.title || '').trim(),
      standard: std,
      similars: sims,
      keywords: parseKwList(k.keyword),
      action: k.action,
      target: tgt,
      answers,
    });
  }
  return out;
}

function safeParseOrSplit(s) {
  const t = (s || '').trim();
  if (t.startsWith('[')) {
    try { return JSON.parse(t); } catch { return t.split(/[,，]/); }
  }
  return t.split(/[,，]/);
}

export function parseKwList(kw) {
  if (!kw) return [];
  if (typeof kw === 'string') {
    const t = kw.trim();
    if (!t || t === '[]' || t === 'null' || t === 'None') return [];
    return t.split(/[,，]/).map(x => x.trim()).filter(Boolean);
  }
  if (Array.isArray(kw)) {
    const out = [];
    for (const x of kw) {
      if (typeof x === 'string') out.push(...x.split(/[,，]/).map(v => v.trim()).filter(Boolean));
      else if (x && typeof x === 'object' && x.keyword) out.push(String(x.keyword).trim());
    }
    return out.filter(Boolean);
  }
  return [];
}

// ---------------- step 索引与定位 ----------------
const SYS = /^(您好。?在吗|您好[，,]?您能听到我(的)?说话吗|条件判断|系统|请稍等|正在为您转接)/;

function buildStepIndex(layers, libKw) {
  const stepByText = new Map();
  const textAll = new Map();   // 同文话术的全部 step（用于歧义消除）
  const steps = [];
  const libRes = b => (libKw[b] || []).map(k => ({ raw: k, re: comp(k) })).filter(x => x.re);
  const sideRes = names => {
    const out = [];
    for (const n of names || [])
      for (const k of (libKw[n] || [])) {
        const re = comp(k);
        if (re) out.push({ raw: k, re, lib: n });
      }
    return out;
  };
  for (const lay of ['flow', 'multi']) {
    for (const s of layers[lay]) {
      const n = norm(s.text);
      if (n.length < 6) continue;
      const rec = {
        key: n, node: s.node, path: s.path, layer: lay,
        edges: s.edges.map(e => {
          const own = (e.keywords || []).map(k => ({ raw: k, re: comp(k) })).filter(x => x.re);
          const side = sideRes(e.regex_side);
          // 本地自写优先；无本地则用 regex_side 指定的全局分支；再退化为同名分支
          const res = own.length ? own.concat(side) : (side.length ? side : libRes(e.branch));
          const src = own.length ? 'node' : (side.length ? 'lib-side' : 'lib-name');
          return { branch: e.branch, target: e.target, res, src };
        }),
      };
      if (!stepByText.has(n) || stepByText.get(n).edges.length < rec.edges.length) stepByText.set(n, rec);
      if (!textAll.has(n)) textAll.set(n, []);
      textAll.get(n).push(rec);
      steps.push(rec);
    }
  }
  return { stepByText, textAll, steps };
}

function makeLocator(stepByText) {
  return aiText => {
    const t = norm(aiText);
    if (!t || t.length < 6) return null;
    if (stepByText.has(t)) return stepByText.get(t);
    for (const [k, v] of stepByText)
      if (k.length >= 10 && t.length >= 10 && (t.startsWith(k.slice(0, 18)) || k.startsWith(t.slice(0, 18)))) return v;
    if (t.length >= 16)
      for (const [k, v] of stepByText)
        for (let i = 0; i + 14 <= t.length; i += 7) if (k.includes(t.slice(i, i + 14))) return v;
    return null;
  };
}

// ---------------- 主巡检（分支走向判定） ----------------
const GREET_RE = /^(喂|你好|喂喂|哎|诶|啊|哦|嗯|嗯嗯)+$/;
const isGreet = t => { const s = norm(t); return !!s && s.length <= 8 && GREET_RE.test(s); };
const WEAK_UTT = /^(嗯+|哦+|啊+|呃+|诶+|哎+|噢+|喔+|呣|唔|喂+|好|行|对|是|好的?|嗯好|好嘞)$/;
const WEAK_ATOMS = new Set(['嗯', '哦', '啊', '呃', '诶', '哎', '噢', '喔', '呣', '唔', '喂']);

export function auditTree(layers, libKw, calls, onProgress) {
  const { stepByText, textAll } = buildStepIndex(layers, libKw);
  const locate = makeLocator(stepByText);
  // 同文歧义消除：同名话术出现于多个节点时，AI 落在其中任一节点都算合法
  const sameTextNodes = new Map();
  for (const [k, arr] of textAll) {
    const nodes = [...new Set(arr.map(x => x.node))];
    if (nodes.length > 1) sameTextNodes.set(k, new Set(nodes));
  }
  const stat = {
    calls: 0, steps: 0, exact: 0, exactPct: 0, ok: 0, okDefault: 0,
    errWrong: 0, errDefault: 0, noMatch: 0, noMatchNoDef: 0, okInternalSeq: 0,
    skipNoJudge: 0, noStep: 0, lastTurn: 0, sysLike: 0, okAmbig: 0,
  };
  const problems = [];
  const gaps = [];
  const weakMatch = [];   // 弱语气词命中肯定类分支的明细（弱肯定误判证据，含肇事正则原文）
  const nodeTexts = new Map();   // node -> Map(normText -> 句次)，供参考正则回测
  let done = 0;

  for (const call of calls) {
    const turns = call.turns;
    stat.calls++;
    const stepOf = new Map();
    for (let i = 0; i < turns.length; i++) {
      if (turns[i].role !== 'AI') continue;
      const raw = (turns[i].text || '').trim();
      if (!raw) continue;
      if (SYS.test(raw)) { stat.sysLike++; continue; }
      const s = locate(raw);
      if (s) { stepOf.set(i, s); stat.exact++; }
    }
    for (let i = 0; i < turns.length; i++) {
      const tr = turns[i];
      if (tr.role !== 'ME') continue;
      const text = (tr.text || '').trim();
      if (!text) continue;
      let ci = -1;
      for (let j = i - 1; j >= 0; j--) if (stepOf.has(j)) { ci = j; break; }
      if (ci >= 0) {
        const cn = stepOf.get(ci).node;
        if (!nodeTexts.has(cn)) nodeTexts.set(cn, new Map());
        const m = nodeTexts.get(cn);
        const c = norm(text);
        if (c) m.set(c, (m.get(c) || 0) + 1);
      }
      if (ci < 0) { stat.noStep++; continue; }
      const cur = stepOf.get(ci);
      if (!cur.edges.some(e => !DEF.has(e.branch))) { stat.skipNoJudge++; continue; }

      // 下一个"不同话术"的 step 才是真正的跳转
      let ni = -1;
      for (let j = i + 1; j < turns.length; j++) {
        if (!stepOf.has(j)) continue;
        const nx = stepOf.get(j);
        if (nx.key === cur.key) {
          let later = false;
          for (let k = j + 1; k < turns.length; k++)
            if (stepOf.has(k) && stepOf.get(k).key !== cur.key) { later = true; break; }
          if (later) continue;
        }
        ni = j; break;
      }
      if (ni < 0) { stat.lastTurn++; continue; }
      stat.steps++;
      const next = stepOf.get(ni);

      const matched = [];
      for (const e of cur.edges)
        for (const k of e.res) if (k.re.test(text)) { matched.push({ branch: e.branch, target: e.target, re: k.raw, src: e.src }); break; }

      // 弱语气词（嗯/哦/啊…）被肯定类分支命中：这是正则过宽的客观证据，无论走向对错都记录
      const s0 = norm(text);
      if (matched.length && s0.length <= 4 && WEAK_UTT.test(s0)) {
        for (const m of matched) weakMatch.push({ id: call.id, node: cur.node, text: s0, branch: m.branch, pat: m.re, patSrc: m.src });
      }

      const defEdge = cur.edges.find(e => DEF.has(e.branch));
      const sameNodeSeq = cur.node === next.node && cur.path !== next.path;

      // 同文歧义合法化：同名话术存在于多个节点时，AI 落到其中任一节点都算合法（统计单列）
      const amb = sameTextNodes.get(cur.key);
      if (amb && amb.size > 1) {
        if (amb.has(next.node) || next.node === cur.node) { stat.okAmbig++; continue; }
      }

      if (matched.length === 0) {
        stat.noMatch++;
        const cands = cur.edges.filter(e => e.target && next.node === e.target).map(e => e.branch);
        gaps.push({ id: call.id, node: cur.node, path: cur.path, text, next: next.node, cands: cands.join(',') });
        if (defEdge && defEdge.target) {
          // AI 仍在原节点内顺序推进（原地续说）不算偏离默认
          if (next.node === defEdge.target) stat.okDefault++;
          else if (next.node === cur.node) stat.okInternalSeq++;
          else {
            stat.errDefault++;
            problems.push({ id: call.id, node: cur.node, path: cur.path, text, kind: '2-该走默认却偏离', expected: defEdge.target, actual: next.node, branches: '' });
          }
        } else if (sameNodeSeq) stat.okInternalSeq++;
        else stat.noMatchNoDef++;
        continue;
      }
      const targets = [...new Set(matched.map(m => m.target).filter(Boolean))];
      if (targets.length === 0) {
        if (sameNodeSeq || next.node === cur.node) stat.ok++;
        else stat.okInternalSeq++;
        continue;
      }
      if (targets.includes(next.node)) { stat.ok++; continue; }
      // 命中分支但 AI 仍在原节点原地续说：合法（树内推进）
      if (next.node === cur.node) { stat.okInternalSeq++; continue; }
      stat.errWrong++;
      problems.push({
        id: call.id, node: cur.node, path: cur.path, text, kind: '1-命中分支却走错去向',
        expected: targets[0], actual: next.node,
        branches: matched.map(m => m.branch).join(','),
        matched,   // 保留命中明细，供定位肇事正则
      });
    }
    done++;
    if (onProgress && done % 500 === 0) onProgress(done, stat);
  }
  stat.exactPct = stat.exact ? +(100 * stat.exact / (stat.exact + stat.sysLike)).toFixed(1) : 0;
  return { stat, problems, gaps, weakMatch, nodeTexts };
}

// ---------------- 知识库巡检（框架内未命中 / 框架外意图） ----------------
const ASK = /(什么|啥|哪位|谁呀|谁啊|是谁|怎么了|怎么啦|干啥|干嘛|什么事|咋回事|为什么|咋办|如何)/;
const INTENT = /(怎么办|怎么弄|怎么处理|为什么|为什么呀|什么意思|啥意思|什么情况|真的假的|是不是真的|是不是骗子|你们是谁|你是哪|你是干什么|哪里来的|怎么知道|谁告诉你|我的钱|能不能|可不可以|我要报|我想报|帮我|告诉我|我要查|查一下|我该怎么办|钱能|能追回|退回来|退钱|抓到了|报警|举报|投诉|冻结|银行卡|账号被|已经转了|我转了|我被骗|转钱了|扣钱了|扣费|我不同意|我要求|必须|凭什么|你有证件|证件|工号|派出所|公安局|你说什么|再说一遍|听不清|听不到)/;
const FILLER = /^(喂|你好|喂喂|哎|诶|啊|哦|嗯|嗯嗯|哦哦|好好|行|对|是的|好的|好|可以|谢谢|谢谢啊|拜拜|再见|我|你|他|那个|这个|呃|哼|明白|知道|清楚|了解|懂了)/;
const isFiller = t => { const s = norm(t); return !s || (s.length <= 8 && FILLER.test(s)); };

export function auditKb(layers, kbRaw, calls, onProgress) {
  const entries = kbRaw.map(e => ({
    ...e,
    res: (e.keywords || []).map(k => ({ raw: k, re: comp(k) })).filter(x => x.re),
    norms: [e.standard, ...(e.similars || [])].map(x => norm(x)).filter(x => x.length >= 2),
  }));
  const { stepByText } = buildStepIndex(layers, {});
  const locate = makeLocator(stepByText);

  const kbMatch = text => {
    const t = norm(text);
    if (!t) return null;
    for (const e of entries)
      for (const k of e.res) if (k.re.test(text)) return { e, how: 'regex', pat: k.raw };
    for (const e of entries)
      for (const n of e.norms) {
        if (!n || n.length < 2) continue;
        if (t === n || t.includes(n)) return { e, how: 'similar', pat: n };
      }
    return null;
  };

  const inFrame = [];
  const outFrame = [];
  const stat = { calls: 0, meTurns: 0, filler: 0, intentMarked: 0, intentNoKb: 0, kbHit: 0, kbHitNoRedirect: 0 };
  let done = 0;
  for (const call of calls) {
    const turns = call.turns;
    stat.calls++;
    for (let i = 0; i < turns.length; i++) {
      const tr = turns[i];
      if (tr.role !== 'ME') continue;
      const text = (tr.text || '').trim();
      if (!text) continue;
      stat.meTurns++;
      if (isFiller(text)) { stat.filler++; continue; }
      let cur = null;
      for (let j = i - 1; j >= 0; j--)
        if (turns[j].role === 'AI' && (turns[j].text || '').trim()) { cur = locate(turns[j].text); if (cur) break; }
      let nxt = null;
      for (let j = i + 1; j < turns.length; j++)
        if (turns[j].role === 'AI' && (turns[j].text || '').trim()) { nxt = turns[j]; break; }
      const hit = kbMatch(text);
      if (hit) {
        stat.kbHit++;
        if (hit.e.target && cur && nxt) {
          const after = locate(nxt.text);
          if (after && after.node !== hit.e.target && after.node === cur.node) {
            stat.kbHitNoRedirect++;
            inFrame.push({ id: call.id, node: cur.node, text, kb: hit.e.title || hit.e.standard, how: hit.how, pat: hit.pat, kbTarget: hit.e.target, actual: after.node });
          }
        }
        continue;
      }
      const t2 = norm(text);
      if (INTENT.test(text) || (ASK.test(text) && t2.length <= 14)) {
        stat.intentMarked++;
        stat.intentNoKb++;
        if (nxt) outFrame.push({ id: call.id, node: cur ? cur.node : '(未知)', text, aiReply: (nxt.text || '').slice(0, 90), tag: INTENT.test(text) ? '诉求/质疑' : '主动发问' });
      }
    }
    done++;
    if (onProgress && done % 1000 === 0) onProgress(done, stat);
  }
  return { stat, inFrame, outFrame };
}

// ---------------- 死条目（结构上永不可能命中） ----------------
export function findDeadKb(kbRaw) {
  return (kbRaw || []).filter(e => !e.keywords.length && !e.similars.length);
}

// ---------------- 待优化库生成 ----------------
const SEM = [
  ['接听', /^(喂|你好|哎|诶|啊|哦|嗯|呣|唔)[。！!，,]?$/],
  ['否定', /^(没|不|无|未|也没|没有|并没有)/],
  ['肯定', /^(对|是|好|行|可以|嗯对|没错|ok|OK)/],
  ['知晓', /^(明白|知道|清楚|了解|懂了|记住|晓得了)/],
  ['礼貌', /^(谢谢|感谢|辛苦了)/],
];
const semOf = t => {
  const s = norm(t);
  for (const [name, pat] of SEM) if (pat.test(s)) return name;
  return '其他';
};
const ALLOW = { '肯定': ['肯定', '接听'], '否定': ['否定', '接听'], '未受骗': ['否定', '接听'], '拒绝': ['否定'], '有收益': ['肯定'] };
const SEM_TMPL = {
  '否定': ['^(没有|没|不用|不需要|没兴趣|不感兴趣|不考虑)[。！!，,]?$', '^(没有|没)[，,]?(没有|没)+[。！!]?$'],
  '肯定': ['^(对|是|对呀|是的|对啊)[。！!，,]?$', '^(好|行|可以|好的|好呀|行吧)[。！!，,]?$'],
  '知晓': ['^(明白|知道了|清楚了|了解了|懂了|晓得了)(了|啊|呀)?[。！!，,]?$'],
  '礼貌': ['^(谢谢|感谢|辛苦了|好的?谢谢)[。！!，,]?$'],
  '接听': ['^(喂|喂喂|你好|哎|诶|啊|哦|嗯)[。！!，,]?$'],
};
const PURE = /^(嗯|哦|啊|呃|诶|哎|喂|嗯嗯|哦哦|啊啊|喂喂|嗯嗯嗯)?$/;
const punc = t => norm(t);
const WEAK = /^(嗯|哦|啊|呃|诶|哎|喂|好|行|对|是)$/;
const clean = (t, n = 60) => (t || '').replace(/\s+/g, ' ').trim().slice(0, n);
const topN = (counter, n = 6) => [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
  .map(([t, c]) => `${t}（${c}次）`).join(' ｜ ') || '—';

export function buildOptimizations({ problems, gaps, stat, layers, libKw, kbRaw, kbAudit, deadKb, weakMatch, nodeTexts }) {
  const rows = [];
  const stepIndex = new Map();
  for (const lay of ['flow', 'multi'])
    for (const s of layers[lay]) {
      const k = norm(s.text);
      if (k.length >= 6 && !stepIndex.has(k)) stepIndex.set(k, s);
    }

  // ---- 类型1/2：走向错误 → 肇事正则定位 ----
  const g12 = new Map();
  for (const r of problems) {
    const k = `${r.kind}|${r.node}|${r.expected}|${r.actual}`;
    if (!g12.has(k)) g12.set(k, { r, n: 0, texts: new Map(), msets: [] });
    const g = g12.get(k);
    g.n++;
    const c = clean(r.text);
    g.texts.set(c, (g.texts.get(c) || 0) + 1);
    if (r.matched) g.msets.push({ matched: r.matched, text: r.text });
  }
  const g12arr = [...g12.entries()].sort((a, b) => b[1].n - a[1].n);

  // ---- 类型3：该命中却未命中 → 补词候选（带验证） ----
  const gap = new Map();     // key -> texts counter
  const gapSem = new Map();
  let skipGreet = 0;
  for (const r of gaps) {
    if (!r.cands) continue;
    if (isGreet(r.text) && GREET_NODES.has(r.node)) { skipGreet++; continue; }
    for (const br of r.cands.split(',')) {
      if (!br || DEF.has(br)) continue;
      const k = `${r.node}|${br}`;
      if (!gap.has(k)) { gap.set(k, new Map()); gapSem.set(k, new Map()); }
      const c = clean(r.text);
      const m = gap.get(k);
      m.set(c, (m.get(c) || 0) + 1);
      const sm = gapSem.get(k);
      const s = semOf(r.text);
      sm.set(s, (sm.get(s) || 0) + 1);
    }
  }

  const kwRows = [];
  for (const [k, cnt] of [...gap.entries()].sort((a, b) => sum(b[1]) - sum(a[1]))) {
    const [node, br] = k.split('|');
    const n = sum(cnt);
    if (n < 30) continue;
    const pure = [...cnt.entries()].filter(([t]) => PURE.test(punc(t))).reduce((s, [, c]) => s + c, 0);
    if (pure / n > 0.55) continue;
    const semd = gapSem.get(k);
    const allowed = ALLOW[br] || ['肯定', '否定'];
    const matchShare = [...semd.entries()].filter(([sm]) => allowed.includes(sm)).reduce((s, [, c]) => s + c, 0) / n;
    if (matchShare < 0.35) continue;

    const texts = [...cnt.entries()];   // [原始句, 句次]

    // 候选一：语义模板
    const candidates = [];
    for (const [sem, c] of [...semd.entries()].sort((a, b) => b[1] - a[1])) {
      if (c / n < 0.05 || !allowed.includes(sem)) continue;
      if (sem === '接听' && node !== '开场白') continue;
      for (const p of SEM_TMPL[sem] || []) if (!candidates.includes(p)) candidates.push(p);
    }

    // 候选二：高频核心句挖掘（去语气填充词 → 抽核心 → 泛化为锚定正则）
    const cores = new Map();
    for (const [t, c] of texts) {
      let s = (t || '').trim().replace(/^[（(]\s*停顿[^）)]*[）)]/, '');
      s = s.replace(/^((嗯+|哦+|啊+|呃+|诶+|哎+|喂+|嗨+|噢+|喔+|呣|唔|那|那个|就是|然后|反正|是)[，,、\s]*)+/g, '');
      s = s.replace(/[，,、\s~—·。！!？?]+/g, '');
      const stripped = s.replace(/(呢|吧|啊|呀|嘛|哈|咯|喽|哦|噢)+$/g, '').trim();
      s = stripped.length >= 2 ? stripped : s;   // 「干嘛」不能截成「干」
      if (!s || s.length > 12) continue;
      if (PURE.test(s)) continue;
      cores.set(s, (cores.get(s) || 0) + c);
    }
    for (const [core, c] of [...cores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      if (c / n < 0.12) continue;
      const esc = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const p = `^(嗯|哦|啊|呃|诶|哎|喂|嗯嗯|那个|就是|是)*[，,、\\s]*${esc}([呢吧啊呀嘛了哈哦噢]|$)`;
      if (!candidates.includes(p)) candidates.push(p);
    }

    // 验证：按句次加权命中率 ≥40%，否则剔除（宁缺毋滥）
    const validated = [];
    for (const p of candidates) {
      const re = comp(p);
      if (!re) continue;
      let hit = 0;
      for (const [t, c] of texts) if (re.test(t.replace(/[。！!？?，,\s]+$/, ''))) hit += c;
      if (hit / n >= 0.4) validated.push({ p, rate: +(100 * hit / n).toFixed(0) });
      if (validated.length >= 4) break;
    }
    if (!validated.length) continue;

    const { own, ownKws, tgt, sideNames } = branchDef(layers, libKw, node, br);
    kwRows.push({
      node, branch: br, target: tgt || '（原地）',
      old: describeOld(own, ownKws, sideNames, libKw, br),
      addPatterns: validated.map(v => v.p),
      rates: validated.map(v => v.rate),
      evidence: topN(cnt, 6),
      hits: n,
      semDesc: [...semd.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s2, c]) => `${s2}${c}句`).join('、'),
    });
  }
  kwRows.sort((a, b) => b.hits - a.hits);

  // 组装待优化库行
  let seq = 0;
  const push = row => { row.seq = ++seq; rows.push(row); };

  // a) 分支补词（add）
  for (const r of kwRows) {
    const rates = r.rates || [];
    push({
      source: 'branch',
      question: nodeQuestion(layers, r.node),
      branch: r.branch,
      old_regex: r.old,
      new_regex: r.addPatterns.map((p, i) => `${p}（回测命中 ${rates[i] ?? '--'}%）`).join(' ｜ '),
      action: 'add',
      evidence: `${r.evidence}；语义构成 ${r.semDesc}；目标节点「${r.target}」`,
      hits: r.hits,
      node: r.node,
      problem_type: '3-该命中分支却未命中',
    });
  }

  // b) 走向错误 → 一律给出参考正则（禁只复核）
  for (const [k, g] of g12arr.slice(0, 40)) {
    if (g.n < 20) break;
    const { kind, node, expected, actual } = g.r;
    const isT1 = kind.startsWith('1');
    const question = nodeQuestion(layers, node);
    const nt = (nodeTexts && nodeTexts.get(node)) || new Map();
    const ntTotal = [...nt.values()].reduce((s, c) => s + c, 0);

    if (isT1 && g.msets.length) {
      // 统计每条命中正则在走错样本里的触发次数 → 定位肇事正则
      const patCnt = new Map();
      for (const ms of g.msets)
        for (const m of ms.matched) {
          const e = patCnt.get(m.re) || { n: 0, branch: m.branch, src: m.src };
          e.n++; patCnt.set(m.re, e);
        }
      const culprit = [...patCnt.entries()].sort((a, b) => b[1].n - a[1].n)[0];
      const [pat, info] = culprit;

      const weakHits = [...g.texts.entries()].filter(([t]) => WEAK_UTT.test(punc(t))).reduce((s, [, c]) => s + c, 0);
      if (weakHits / g.n >= 0.6) {
        // 纯语气误伤 → 参考写法：去除语气词命中或收紧为含实义的肯定表达
        const pats = [];
        const tightened = tightenPattern(pat);
        if (tightened && tightened !== pat) pats.push(tightened);
        if (!pats.length) pats.push(`移除「${pat}」（${info.src === 'node' ? '节点本地规则' : `全局库「${info.branch}」`}）`);
        push({
          source: 'branch', question, branch: info.branch,
          old_regex: pat,
          new_regex: pats.join(' ｜ '),
          action: 'modify',
          evidence: `${topN(g.texts)}；命中它后本应走「${expected}」，实际走向「${actual}」，${weakHits}/${g.n} 为纯语气应答`,
          hits: g.n, node,
          problem_type: '1-命中分支却走错去向（肇事规则已定位）',
        });
        continue;
      }

      const narrowed = narrowSuggest(pat);
      if (narrowed) {
        const re2 = comp(narrowed);
        let stillOk = 0, wrong = 0;
        for (const ms of g.msets)
          for (const m of ms.matched) {
            if (m.re !== pat) continue;
            wrong++;
            if (re2 && re2.test(ms.text)) stillOk++;
          }
        const keepRate = wrong ? Math.round(100 * stillOk / wrong) : 0;
        push({
          source: 'branch', question, branch: info.branch,
          old_regex: pat,
          new_regex: `${narrowed}（收窄后走错样本仍命中 ${100 - keepRate}%，需再收紧或移除）`,
          action: 'modify',
          evidence: `${topN(g.texts)}；该规则触发后本应走「${expected}」实际走「${actual}」`,
          hits: g.n, node,
          problem_type: '1-命中分支却走错去向（肇事规则已定位）',
        });
        continue;
      }
      // 无法收窄：给「收紧为含实义锚定」参考正则（按该节点语料构造）
      const p = anchorPatternFromSamples(g.texts, WEAK_UTT);
      if (p) {
        const re2 = comp(p);
        let hit = 0;
        for (const [t, c] of nt) if (re2.test(t)) hit += c;
        const lr = ntTotal ? Math.round(100 * hit / ntTotal) : 0;
        // 肇事正则本身只匹配纯语气（如 ^嗯。$）→ 它没有存在价值，给「移除+替换写法」而非弱锚定
        const reP = comp(pat);
        let patNonUtt = 0, patTotal = 0;
        if (reP) {
          for (const [t, c] of nt) { if (reP.test(t)) { patTotal += c; if (!WEAK_UTT.test(t)) patNonUtt += c; } }
          if (patTotal === 0)   // norm 语料无标点测不到（如 ^嗯。$），用走错样本原文补测
            for (const [t, c] of g.texts) { if (reP.test(t)) { patTotal += c; if (!WEAK_UTT.test(t.replace(/[。！!？?，,\s]/g, ''))) patNonUtt += c; } }
        }
        if (reP && patTotal > 0 && patNonUtt / patTotal < 0.05) {
          push({
            source: 'branch', question, branch: info.branch,
            old_regex: pat,
            new_regex: `移除「${pat}」（${info.src === 'node' ? '节点本地规则' : `全局库「${info.branch}」`}）——该规则几乎只命中纯语气应答（实义占比 ${Math.round(100 * patNonUtt / patTotal)}%）；如需保留实义肯定，用「^((好的?|对|是|行|嗯是的|对对)[，,、\\s]*)+[呢吧啊呀嘛]{0,2}[。，,！!？?\\s]*$」`,
            action: 'remove',
            evidence: `${topN(g.texts)}；肇事规则触发后本应走「${expected}」实际走「${actual}」，${weakHits||'100%'} 为纯语气样本`,
            hits: g.n, node,
            problem_type: '1-命中分支却走错去向（肇事规则已定位）',
          });
          continue;
        }
        push({
          source: 'branch', question, branch: info.branch,
          old_regex: pat,
          new_regex: `${p}（节点语料回测：命中 ${lr}%，参考；建议业务确认后采纳）`,
          action: 'modify',
          evidence: `${topN(g.texts)}；肇事规则「${pat}」触发后本应走「${expected}」实际走「${actual}」`,
          hits: g.n, node,
          problem_type: '1-命中分支却走错去向（肇事规则已定位）',
        });
        continue;
      }
      // 最终兜底：建议直接移除肇事规则（仍是明确建议）
      push({
        source: 'branch', question, branch: info.branch,
        old_regex: pat,
        new_regex: `移除「${pat}」（${info.src === 'node' ? '节点本地规则' : `全局库「${info.branch}」`}），恢复默认兜底`,
        action: 'remove',
        evidence: `${topN(g.texts)}；肇事规则触发后本应走「${expected}」实际走「${actual}」`,
        hits: g.n, node,
        problem_type: '1-命中分支却走错去向（肇事规则已定位）',
      });
      continue;
    }

    // ---- 类型2（默认偏离）：给默认分支补语气兜底参考正则 ----
    // 取前 3 个高频语气句的字符合集 → 一条兜底正则覆盖整组
    const atomSet = new Set();
    const uttTop = [...g.texts.entries()].sort((a, b) => b[1] - a[1]);
    let uttCovered = 0;
    for (const [t, c] of uttTop.slice(0, 6)) {
      const core = punc(t).replace(/[。！!？?，,]/g, '');
      if (!core || !WEAK_UTT.test(core)) continue;
      for (const ch of core) if (WEAK_ATOMS.has(ch)) atomSet.add(ch);
      uttCovered += c;
    }
    const seg = [];
    if (atomSet.size) {
      const atoms = [...atomSet].join('|');
      const cand = `^(${atoms}){1,3}[。，,！!？?\\s]*$`;
      const re2 = comp(cand);
      // 回测1：守准率——该节点全部 ME 语料中被它命中的比例（=交由默认处理的比例）
      let hit = 0;
      for (const [t, c] of nt) if (re2.test(t)) hit += c;
      const lr = ntTotal ? Math.round(100 * hit / ntTotal) : 0;
      // 回测2：抓取率——本组纯语气部分命中率
      let grab = 0;
      for (const [t, c] of g.texts) if (re2.test(punc(t))) grab += c;
      const gr = g.n ? Math.round(100 * grab / g.n) : 0;
      seg.push(`${cand}（节点语料 ${lr}% · 本组走错样本 ${gr}%）`);
    }
    push({
      source: 'branch', question, branch: '默认',
      old_regex: '（默认分支，当前无关键词）',
      new_regex: seg.length ? `默认分支新增兜底正则：${seg.join(' ｜ ')}` : `默认分支新增兜底正则：覆盖「${punc(uttTop[0] ? uttTop[0][0] : '')}」类纯语气应答（参考写法：^(嗯|哦|啊){1,3}[。，,！!？?\\s]*$，人工复核采纳）`,
      action: 'add',
      evidence: `${topN(g.texts)}；这些纯语气应答未命中任何规则，线上 AI 却导航去了「${actual}」（快照中无匹配规则，疑似线上配置含过宽规则或已更新；补充该兜底正则后「嗯」类应答将稳定走「${expected}」）`,
      hits: g.n, node,
      problem_type: '2-该走默认却偏离（默认分支补兜底正则）',
    });
  }
  // c) 弱肯定误判 → 按肇事正则精确分组（不靠分支名猜）
  if (weakMatch && weakMatch.length) {
    const wk = new Map();   // node|branch|pat -> {n, texts}
    for (const r of weakMatch) {
      const k = `${r.node}|${r.branch}|${r.pat}`;
      if (!wk.has(k)) wk.set(k, { n: 0, texts: new Map() });
      const g = wk.get(k);
      g.n++;
      const c = punc(r.text);
      g.texts.set(c, (g.texts.get(c) || 0) + 1);
    }
    for (const [k, g] of [...wk.entries()].filter(([, v]) => v.n >= 20).sort((a, b) => b[1].n - a[1].n).slice(0, 15)) {
      const [node, branch, pat] = k.split('|');
      // 参考写法：若该组还命中过实义肯定句（如「好的，谢谢」），给收紧版；否则建议直接移除
      const tightened = tightenPattern(pat);
      const nt2 = (nodeTexts && nodeTexts.get(node)) || new Map();
      const ntTotal2 = [...nt2.values()].reduce((s, c) => s + c, 0);
      let refLine;
      if (tightened && tightened !== pat) {
        const reT = comp(tightened);
        let keep = 0, hitN = 0;
        if (reT) for (const [t, c] of nt2) { if (reT.test(t)) { hitN += c; if (!WEAK_UTT.test(t)) keep += c; } }
        refLine = `收紧为「${tightened}」（节点语料命中 ${ntTotal2 && reT ? Math.round(100 * hitN / ntTotal2) : 0}%，其中实义句占 ${hitN ? Math.round(100 * keep / hitN) : 0}%）`;
      } else {
        refLine = `移除——纯语气应答（${topN(g.texts, 3)}）被它判成「${branch}」，应由【默认】兜底；如需保留实义肯定，用「^((好的?|对|是|行|嗯是的|对对)[，,、\\s]*)+[呢吧啊呀嘛]{0,2}[。，,！!？?\\s]*$」并要求后接实义`;
      }
      push({
        source: 'branch',
        question: nodeQuestion(layers, node),
        branch,
        old_regex: pat,
        new_regex: refLine,
        action: 'remove',
        evidence: `弱语气误判 ${g.n} 次；请核对其他节点是否也引用该规则，避免误伤`,
        hits: g.n,
        node,
        problem_type: '弱肯定误判（肇事规则已定位）',
      });
    }
  }

  // d) 知识库命中却未按意图走 → 给「知识点参考正则」+ 双向回测
  const gIn = new Map();
  for (const r of kbAudit.inFrame) {
    const k = `${r.node}|${r.kb}|${r.kbTarget}`;
    if (!gIn.has(k)) gIn.set(k, { r, n: 0, texts: new Map() });
    const g = gIn.get(k);
    g.n++;
    const c = clean(r.text);
    g.texts.set(c, (g.texts.get(c) || 0) + 1);
  }
  for (const [, g] of [...gIn.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 30)) {
    if (g.n < 10) break;
    const r0 = g.r;
    // 参考正则：优先用命中正则收窄，否则从样本核心句构造锚定正则（方言写法）
    let pats = [];
    if (r0.pat) {
      const nar = narrowSuggest(r0.pat) || tightenPattern(r0.pat);
      if (nar && nar !== r0.pat) pats.push(nar);
    }
    const anchored = anchorPatternFromSamples(g.texts, PURE, { comp: false });   // 样本均为知识库可命中的实义句，生成方言写法
    if (anchored && !pats.includes(anchored)) pats.push(anchored);

    // 双向回测（方言写法经 comp 编译）
    const nt = (nodeTexts && nodeTexts.get(r0.node)) || new Map();
    const ntTotal = [...nt.values()].reduce((s, c) => s + c, 0);
    const rateParts = [];
    for (const p of pats.slice(0, 2)) {
      const re2 = comp(p);
      if (!re2) continue;
      let hit = 0;
      for (const [t, c] of nt) if (re2.test(t)) hit += c;
      const lr = ntTotal ? Math.round(100 * hit / ntTotal) : 0;
      let grab = 0;
      for (const [t, c] of g.texts) if (re2.test(punc(t))) grab += c;
      const gr = g.n ? Math.round(100 * grab / g.n) : 0;
      rateParts.push(`${p}（本组样本 ${gr}% · 节点语料 ${lr}%）`);
    }
    if (!rateParts.length) continue;   // 无法构造可回测正则的组不强行输出（宁缺毋滥）
    push({
      source: 'kb',
      question: r0.kb,
      branch: '',
      old_regex: r0.pat ? `命中正则：${r0.pat}` : '命中相似问法（配置未含正则）',
      new_regex: rateParts.join(' ｜ '),
      action: 'modify',
      evidence: `${topN(g.texts)}；命中知识库「${r0.kb}」（去向「${r0.kbTarget}」）但 AI 未按该意图推进——把该意图的正则补进知识点「${r0.kb}」的相似问法中，命中即转向「${r0.kbTarget}」`,
      hits: g.n,
      node: r0.node,
      problem_type: '5-知识库命中却未按意图走（已给参考正则）',
    });
  }

  // e) 框架外意图（知识库无匹配）→ 生成问题库新增正则建议（对照表 C2 列）
  const gOut = new Map();   // key -> {n, texts}
  for (const r of kbAudit.outFrame) {
    const c = clean(r.text, 40);
    const k = `${r.tag}|${c}`;
    if (!gOut.has(k)) gOut.set(k, { n: 0, texts: new Map() });
    const g = gOut.get(k);
    g.n++;
    g.texts.set(c, (g.texts.get(c) || 0) + 1);
  }
  for (const [k, g] of [...gOut.entries()].filter(([, v]) => v.n >= 15).sort((a, b) => b[1].n - a[1].n).slice(0, 40)) {
    const [tag, text] = k.split('|');
    // 从聚类文本中挖掘核心问句 → 生成锚定正则，回测本聚类命中率
    const cores = new Map();
    for (const t0 of g.texts.keys()) {
      let s = (t0 || '').trim().replace(/^[（(]\s*停顿[^）)]*[）)]/, '');
      s = s.replace(/^((嗯+|哦+|啊+|呃+|诶+|哎+|喂+|嗨+|噢+|喔+|呣|唔|那|那个|就是|然后|反正|是)[，,、\s]*)+/g, '');
      s = s.replace(/[，,、\s~—·。！!？?]+/g, '');
      const stripped = s.replace(/(呢|吧|啊|呀|嘛|哈|咯|喽|哦|噢)+$/g, '').trim();
      s = stripped.length >= 2 ? stripped : s;   // 「干嘛」不能截成「干」
      if (!s || s.length > 14 || PURE.test(s)) continue;
      cores.set(s, (cores.get(s) || 0) + g.texts.get(t0));
    }
    const topCores = [...cores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .filter(([s, c]) => c / g.n >= 0.15);
    const newRegex = [];
    for (const [core] of topCores) {
      const esc = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const p = `^(嗯|哦|啊|呃|诶|哎|喂|那个|就是|是)*[，,、\\s]*${esc}([呢吧啊呀嘛了哈哦噢]|[。！!？?，,\\s]*$)`;
      const re = comp(p);
      if (!re) continue;
      let hit = 0;
      for (const [t, c] of g.texts) if (re.test(t.replace(/[。！!？?，,\s]+$/, ''))) hit += c;
      if (hit / g.n >= 0.4) newRegex.push(`${p}（回测命中 ${+(100 * hit / g.n).toFixed(0)}%）`);
      if (newRegex.length >= 2) break;
    }
    push({
      source: 'question',
      question: text,
      branch: '',
      old_regex: '（知识库/问题库无匹配条目）',
      new_regex: newRegex.join(' ｜ ') || (topCores.length
        ? `${(() => { const esc = topCores[0][0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return `^(嗯|哦|啊|呃|诶|哎|喂|那个|就是|是)*[，,、\\s]*${esc}([呢吧啊呀嘛了哈哦噢]|[。！!？?，,\\s]*$)`; })()}（参考正则，回测未达 40% 入选阈值，人工复核采纳）`
        : `参考正则：^.*(${(text || '').slice(0, 6).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})（参考正则，样本过散，人工复核采纳）`),
      action: 'add',
      evidence: `框架外意图「${tag}」出现 ${g.n} 次，知识库无一匹配；典型问句：${[...g.texts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, c]) => `${t}（${c}）`).join('、')}`,
      hits: g.n,
      node: '',
      problem_type: '6-框架外意图',
    });
  }

  // f) 死条目 → 按标准问法生成锚定参考正则，使其可被命中
  for (const d of deadKb.slice(0, 50)) {
    const sq = (d.standard || d.title || '').trim();
    let ref = '';
    if (sq) {
      let s = sq.replace(/^((嗯+|哦+|啊+|呃+|诶+|哎+|喂+|那|那个|就是)[，,、\s]*)+/g, '');
      s = s.replace(/[，,、\s~—·。！!？?]+/g, '');
      s = s.replace(/(呢|吧|啊|呀|嘛|哈|咯|喽|哦|噢)+$/g, '').trim() || sq;
      if (s.length >= 2) {
        const esc = s.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        ref = `^(嗯|哦|啊|呃|诶|哎|那个|就是)*[，,、\\s]*${esc}([呢吧啊呀嘛了哈哦噢]|[。！!？?，,\\s]*$)`;
      }
    }
    push({
      source: 'kb',
      question: d.standard || d.title,
      branch: '',
      old_regex: '（无正则、无相似问法）',
      new_regex: ref ? `在相似问法中添加：${ref}（按标准问法「${sq}」生成，参考正则，人工复核采纳）` : `为「${sq}」补相似问法或正则后该条目方可命中`,
      action: ref ? 'add' : 'modify',
      evidence: `知识库死条目：有配置去向「${d.target || '无'}」但结构上永远无法命中——按标准问法生成的参考正则可使该知识点正常触发`,
      hits: 0,
      node: '',
      problem_type: '知识库死条目（已给参考正则）',
    });
  }

  return { rows, kwRows, skipGreet };
}

function sum(m) { let s = 0; for (const v of m.values()) s += v; return s; }

function branchDef(layers, libKw, node, br) {
  let own = 0, tgt = null; const sideNames = []; let ownKws = [];
  for (const lay of ['flow', 'multi'])
    for (const s of layers[lay]) {
      if (s.node !== node) continue;
      for (const e of s.edges) {
        if (e.branch !== br) continue;
        own = Math.max(own, (e.keywords || []).length);
        if ((e.keywords || []).length >= ownKws.length) ownKws = e.keywords || [];
        if (e.target && !tgt) tgt = e.target;
        for (const n of e.regex_side || []) if (!sideNames.includes(n)) sideNames.push(n);
      }
    }
  return { own, ownKws, tgt, sideNames };
}

function describeOld(own, ownKws, sideNames, libKw, br) {
  const kwTxt = (ownKws || []).slice(0, 4).join(' ｜ ');
  if (own === 0 && sideNames.length === 0) {
    const lib = libKw[br];
    if (lib && lib.length) return `全局同名分支「${br}」${lib.length} 条${kwTxt ? `（如 ${kwTxt}）` : ''}`;
    return '（空）两侧均无关键词';
  }
  const parts = [];
  if (own) parts.push(`本节点 ${own} 条${kwTxt ? `（${kwTxt}）` : ''}`);
  if (sideNames.length) parts.push(`全局库 ${sideNames.join('/')}（${sideNames.reduce((s, n) => s + (libKw[n] || []).length, 0)} 条）`);
  return parts.join(' + ');
}

function branchRegexDesc(layers, libKw, node, branches) {
  if (!branches) return '（默认分支）';
  const br = branches.split(',')[0];
  const { own, sideNames } = branchDef(layers, libKw, node, br);
  return describeOld(own, sideNames, libKw, br);
}

function nodeQuestion(layers, node) {
  for (const lay of ['flow', 'multi'])
    for (const s of layers[lay])
      if (s.node === node && s.text) return clean(s.text, 80);
  return node;
}

// 为过宽正则生成收窄建议：识别「.{0,N}任意字符」型宽匹配，要求关键词出现在前 N 字内并收紧尾部
function narrowSuggest(pat) {
  const m = pat.match(/^(.{2,12}?)\.\{(0,|1,|0,)(\d+)\}(.{1,10})$/);
  if (!m) return null;
  const [, head, , num, tail] = m;
  const cap = Math.min(Number(num) || 1, 4);
  if (cap >= Number(num || 99)) return null;
  return pat.replace(/^((?:.)\{)(0,|1,)(\d+)(\})/, `$1$2${cap}$4`);
}

// 收紧过宽正则（语气词误伤场景）：把「裸语气词命中」改为「语气词后必须接实义内容」
function tightenPattern(pat) {
  // 情形1：整条就是锚定的裸语气（如 ^嗯。$ ^好$）→ 没有实义版可保留，返回 null 走移除
  const s = pat.replace(/\\[。，,！!？?\s]/g, '');
  if (/^[\^\(（]*[嗯哦啊呃哎诶噢喔喂]{1,2}[\)\|）。．.]*\$?$/.test(s)) return null;
  // 情形2：含宽通配 .{0,N} → 压缩通配长度，要求关键词贴近出现
  const m = pat.match(/\.\{0,(\d+)\}/);
  if (m && Number(m[1]) > 2) return pat.replace(/\.\{0,\d+\}/, '.{0,2}');
  // 情形3：含可选语气后缀（如 (呢|吧|啊)*$）→ 去掉语气后缀支路，改为必有实义锚
  return null;
}

// 从走错样本构造「实义锚定」参考正则：取高频非语气核心句做前缀锚
// opts.comp=false 时输出百应方言（{0<>N}）；默认输出已编译的 V8 写法
function anchorPatternFromSamples(texts, skipRe, opts = {}) {
  const cores = new Map();
  for (const [t, c] of texts) {
    const s0 = punc(t);
    if (!s0 || (skipRe && skipRe.test(s0))) continue;
    let s = (t || '').trim().replace(/^[（(]\s*停顿[^）)]*[）)]/, '');
    s = s.replace(/^((嗯+|哦+|啊+|呃+|诶+|哎+|喂+|嗨+|噢+|喔+|呣|唔|那|那个|就是|然后|反正|是)[，,、\s]*)+/g, '');
    s = s.replace(/[，,、\s~—·。！!？?]+/g, '');
    const stripped = s.replace(/(呢|吧|啊|呀|嘛|哈|咯|喽|哦|噢)+$/g, '').trim();
    s = stripped.length >= 2 ? stripped : s;
    if (!s || s.length < 2 || s.length > 10) continue;
    if (WEAK_UTT.test(s) || PURE.test(s)) continue;
    cores.set(s, (cores.get(s) || 0) + c);
  }
  const top = [...cores.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < 5) return null;
  const esc = top[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opts.comp === false) return `^((嗯|哦|啊|呃|诶|哎|那个|就是){0<>2}[，,、\\s])?${esc}([呢吧啊呀嘛了哈哦噢]|[。！!？?，,\\s]*$)`;
  return `^(嗯|哦|啊|呃|诶|哎|那个|就是)*[，,、\\s]*${esc}([呢吧啊呀嘛了哈哦噢]|$)`;
}
