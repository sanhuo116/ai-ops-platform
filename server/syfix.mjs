// syfix.mjs —— 私有化 badcase 正则优化（siyouhua-xunjianyouhua 阶段④）
// 五步法：聚类定位 → 候选式设计（学库内范本：lookbehind 否定族/限量间隔/后向排除/树方言）→
//         回归验证（pos 误翻转=0 一票否决 / neg 修复>破坏 / gap 增益）→ 迭代否决 → 产出改动清单
// 树方言：树内 keyword 禁半角逗号 → 量词 {0<>N}；side 库无此限制
import fs from 'node:fs';
import path from 'node:path';
import { buildEngine, makeLocator } from './syaudit.mjs';

const norm = s => (s || '')
  .replace(/[（(]\s*停顿\s*\d+\s*[sS秒]?\s*[）)]/g, '')
  .replace(/[\s，。！？、,.!?…~—\-·；：""''（）()【】\[\]]/g, '');
const comp = p => {
  const q = (p || '').replace(/\{0<>\s*/g, '{0,').replace(/\{(\d+)<>\s*/g, '{1,');
  try { return new RegExp(q, 'u'); } catch { try { return new RegExp(q); } catch { return null; } }
};
// V8 写法 → 树方言写法（树内 keyword 禁半角逗号）
const toDialect = p => p.replace(/\{0,(\d+)\}/g, '{0<>$1}').replace(/\{1,(\d+)\}/g, '{1<>$1}').replace(/(?<![\\])\[(\^)?[^\]]*,[^\]]*\]/g, m => m.replace(/,/g, ''));

const SYS = /(通话已转至语音留言|已转至语音留言|正在为您转接|条件判断|抱歉，刚才没有听清您的回答|请您再重复一遍)/;
const DEF = new Set(['默认', '兜底', '其他']);
const WEAK = /^(嗯+|哦+|啊+|呃+|诶+|哎+|噢+|喂+|好|行|对|是|好的?|嗯好|嗯嗯+)$/;

const NO_PREFIX = '(?<![没不么无否未木].{0,8})';
const NEG_GUARD = {
  '否定': NO_PREFIX,
  '未受骗': NO_PREFIX,
  '肯定': '(?<![没不么无否未木].{0,8})',
};

// 聚类：(bot, node, path, kind, expected/actual) → 簇
export function clusterProblems(problems, gaps) {
  const byKey = new Map();
  for (const r of problems) {
    const k = `${r.bot}|${r.node}|${r.path}|${r.kind}|${r.expected}|${r.actual}`;
    if (!byKey.has(k)) byKey.set(k, { ...r, n: 0, texts: new Map(), ids: new Set(), hitRes: [] });
    const g = byKey.get(k);
    g.n++;
    const c = (r.text || '').slice(0, 120);
    g.texts.set(c, (g.texts.get(c) || 0) + 1);
    g.ids.add(r.id);
    if (r.hitRe && g.hitRes.length < 200) g.hitRes.push(r.hitRe);
  }
  // gap 簇（可补样本）：按 (bot,node,path,defTarget) 聚
  const gapKey = new Map();
  for (const r of gaps) {
    const k = `${r.bot}|${r.node}|${r.path}|GAP|${r.defTarget || ''}`;
    if (!gapKey.has(k)) gapKey.set(k, { ...r, kind: '可补样本(未命中)', expected: r.defTarget || '(默认)', actual: r.next, n: 0, texts: new Map(), ids: new Set() });
    const g = gapKey.get(k);
    g.n++;
    const c = (r.text || '').slice(0, 120);
    g.texts.set(c, (g.texts.get(c) || 0) + 1);
    g.ids.add(r.id);
  }
  const clusters = [...byKey.values(), ...gapKey.values()].sort((a, b) => b.n - a.n);
  return clusters;
}

// 候选式设计：从簇样本学库内范本生成候选正则（含树方言写法）
export function designCandidates(cluster, lib, botSteps) {
  const out = [];
  const texts = [...cluster.texts.keys()];
  const coreOf = t => {
    let s = (t || '').replace(/^[（(]\s*停顿[^）)]*[）)]/, '');
    s = s.replace(/^((嗯+|哦+|啊+|呃+|诶+|哎+|喂+|嗨+|噢+|喔+|呣|唔|那|那个|就是|然后|反正|是)[，,、\s]*)+/g, '');
    s = s.replace(/[，,、\s~—·。！!？?]+/g, '');
    const stripped = s.replace(/(呢|吧|啊|呀|嘛|哈|咯|喽|哦|噢)+$/g, '').trim();
    return stripped.length >= 2 ? stripped : s;
  };
  // 高频核心句（句次加权）
  const cores = new Map();
  for (const [t, c] of cluster.texts) {
    const core = coreOf(t);
    if (!core || core.length < 2 || core.length > 14) continue;
    if (WEAK.test(core)) continue;
    cores.set(core, (cores.get(core) || 0) + c);
  }
  const topCores = [...cores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const total = cluster.n;

  if (cluster.kind === '可补样本(未命中)') {
    // 补式：锚定核心句 → ^[语气前缀]*核心(语气后缀|$)；带否定环视守卫（学库内范本）
    for (const [core, c] of topCores) {
      if (c / total < 0.15) continue;
      const esc = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const negWords = /(没|不|无|未|别)/.test(core) ? '' : '';
      const p = `^(?:嗯+|哦+|啊+|那个|就是|是|好)*[，,、\\s]*${esc}(?:[呢吧啊呀嘛了哈哦噢]|[。，,！!？?\\s]*$)`;
      out.push({ pat: p, dialect: toDialect(p), kind: 'add', weight: c / total, sample: core });
    }
    return out;
  }

  if (cluster.kind.startsWith('分支走默认未命中')) {
    // 默认偏离：高频语气句兜底（限定该节点默认分支的语气兜底式，防抢实义句）
    const weakTexts = texts.filter(t => WEAK.test(norm(t)));
    if (weakTexts.length / texts.length >= 0.5) {
      const atoms = new Set();
      for (const t of weakTexts.slice(0, 8)) for (const ch of norm(t).replace(/[。！!？?，,]/g, '')) if (/[嗯哦啊呃诶哎噢喔喂]/.test(ch)) atoms.add(ch);
      if (atoms.size) {
        const p = `^[${[...atoms].join('')}]{1,3}[。，,！!？?\\s]*$`;
        out.push({ pat: p, dialect: toDialect(p), kind: 'add-default', weight: weakTexts.length / texts.length, sample: norm(weakTexts[0]) });
      }
    } else {
      // 非语气样本的默认偏离：锚定高频核心句补进【默认】分支（比语义分支优先级低的兜底捕捉）
      for (const [core, c] of topCores.slice(0, 2)) {
        const esc = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const p = `^(?:嗯+|哦+|啊+|那个|就是)*[，,、\\s]*${esc}(?:[呢吧啊呀嘛了哈哦噢]|[。，,！!？?\\s]*$)`;
        out.push({ pat: p, dialect: toDialect(p), kind: 'add-default', weight: c / total, sample: core });
      }
    }
    return out;
  }

  if (cluster.kind.startsWith('分支命中错误')) {
    // 肇事正则定位：hitRe 里「branch[lib]：utt↤pat」——找触发样本最多的肇事正则
    const patCnt = new Map();
    for (const [t] of cluster.texts) { void t; }
    // cluster 需带 hitRe 列表（聚类时收集）；fallback：从本簇无法定位则直接返回
    const hitList = cluster.hitRes || [];
    for (const h of hitList) {
      const m = (h || '').match(/↤(.+?)(?: ┃|$)/);
      if (m) patCnt.set(m[1], (patCnt.get(m[1]) || 0) + 1);
    }
    const culprit = [...patCnt.entries()].sort((a, b) => b[1] - a[1])[0];
    if (culprit) {
      const [pat, cnt] = culprit;
      // 收窄：把宽通配压缩 / 加否定环视 / 删裸语气支路
      const cands = [];
      const m = pat.match(/\.\{0,(\d+)\}/);
      if (m && Number(m[1]) > 2) cands.push(pat.replace(/\.\{0,\d+\}/, `.{0,2}`));
      if (!/^\^/.test(pat) && !pat.includes('(?!') && !pat.includes('(?<')) cands.push(pat.replace(/^/, '^'));
      // 否定环视守卫版
      const branchOf = (cluster.hitRe || '').split('[')[0] || '否定';
      const guard = NEG_GUARD[branchOf];
      if (guard && !pat.includes(guard)) cands.push(guard + pat.replace(/^\^/, ''));
      for (const c of cands.slice(0, 2)) {
        if (comp(c)) out.push({ pat: c, dialect: toDialect(c), kind: 'modify', target: pat, weight: cnt / cluster.n, sample: culprit[0] });
      }
      // 移除建议（若该正则几乎只命中语气/无实义）
      out.push({ pat: `移除「${pat}」`, dialect: '', kind: 'remove', target: pat, weight: cnt / cluster.n, sample: pat });
    }
    return out;
  }
  return out;
}

// 回归验证：候选式加入后，pos 误翻转必须 = 0；neg 修复>破坏；gap 增益>0
export function regression(cands, flowTree, pos, neg, gaps) {
  const { BOTS, resolve } = buildEngine(flowTree);
  // node+path → edges 索引（一步定位，不经文本匹配）
  const IDX = new Map();   // bot|node|path → rec
  for (const [bid, steps] of Object.entries(flowTree.bots || {})) {
    const own = BOTS[bid];
    if (!own) continue;
    // buildEngine 已过滤 norm<6 的 step；此处直接复用 BOTS 内 rec（含编译好的 res）
    for (const [k, list] of own.byText) for (const rec of list) IDX.set(bid + '|' + rec.node + '|' + rec.path, rec);
  }
  const FILLER2 = t => WEAK.test(norm(t)) || norm(t).length <= 1;
  const okRoute = (m, next, node) => m ? (m.target ? resolve(m.target) === resolve(next) : next === node) : (next === node);

  function simRoute(bot, node, path, sub, news) {
    const rec = IDX.get(bot + '|' + node + '|' + path);
    if (!rec) return null;
    for (const t of sub) {
      if (FILLER2(t)) continue;
      for (const e of rec.edges) {
        if (e.semantic) continue;
        let res = e.res;
        if (news && news[e.branch]) res = res.concat(news[e.branch].map(p => ({ raw: p, re: comp(p) })).filter(x => x.re));
        for (const k of res) if (k.re.test(t)) return { branch: e.branch, target: e.target, utt: t, why: k.raw };
      }
    }
    return null;
  }

  const report = [];
  for (const cand of cands) {
    const branch = cand.branch || '否定';
    const news = { [branch]: [cand.pat] };
    let posBad = 0, posGood = 0, negFix = 0, negBreak = 0, gapGain = 0;
    const exBad = [], exBrk = [];
    for (const s of pos) {
      if (!s.sub || s.bot !== cand.bot) continue;
      if (s.node !== cand.node || s.path !== cand.path) continue;
      const o = simRoute(s.bot, s.node, s.path, s.sub, null);
      const n = simRoute(s.bot, s.node, s.path, s.sub, news);
      if (okRoute(o, s.next, s.node) && !okRoute(n, s.next, s.node)) { posBad++; if (exBad.length < 3) exBad.push((s.text || '').slice(0, 40)); }
      if (!okRoute(o, s.next, s.node) && okRoute(n, s.next, s.node)) posGood++;
    }
    for (const s of neg) {
      if (!s.sub || s.bot !== cand.bot) continue;
      if (s.node !== cand.node || s.path !== cand.path) continue;
      const o = simRoute(s.bot, s.node, s.path, s.sub, null);
      const n = simRoute(s.bot, s.node, s.path, s.sub, news);
      if (okRoute(o, s.next, s.node) && !okRoute(n, s.next, s.node)) { negBreak++; if (exBrk.length < 3) exBrk.push((s.text || '').slice(0, 40)); }
      if (!okRoute(o, s.next, s.node) && okRoute(n, s.next, s.node)) negFix++;
    }
    for (const g of gaps) {
      if (!g.sub || g.bot !== cand.bot) continue;
      if (g.node !== cand.node || g.path !== cand.path) continue;
      const o = simRoute(g.bot, g.node, g.path, g.sub, null);
      const n = simRoute(g.bot, g.node, g.path, g.sub, news);
      if (!o && n && n.target && resolve(n.target) === resolve(g.next)) gapGain++;
    }
    // 一票否决：误翻转 != 0
    const keep = posBad === 0 && negFix > 0 && (negFix - negBreak) > 0;
    report.push({ ...cand, posBad, posGood, negFix, negBreak, gapGain, keep, exBad, exBrk });
  }
  return report;
}
