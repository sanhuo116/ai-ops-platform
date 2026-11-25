// audit_tree.mjs —— 规则版话术的精确巡检（决策树口径）
//
// 节点定位：AI 话术与话术包原文**精确匹配**（规则版话术写死，不会改述）
// 判定单元：一个 step = 一句固定话术 + 它的分支集合
// 判定链路：用户说 X → 当前 step 各分支正则 → 命中分支的去向 vs AI 下一句所在 step
import fs from 'node:fs';
import readline from 'node:readline';

const OUT = process.argv[2] || '<WORKSPACE>/work/byai-calls';
const T = JSON.parse(fs.readFileSync(`${OUT}/flow_tree.json`, 'utf8'));
const LIB = JSON.parse(fs.readFileSync(`${OUT}/branch_lib_kw.json`, 'utf8'));

const norm = s => (s || '')
  .replace(/[（(]\s*停顿\s*\d+\s*[sS秒]?\s*[）)]/g, '')
  .replace(/[\s，。！？、,.!?…~—\-·；：""''（）()【】\[\]]/g, '');

const comp = p => {
  const q = (p || '').replace(/\{0<>\s*/g, '{0,').replace(/\{(\d+)<>\s*/g, '{1,');
  try { return new RegExp(q, 'u'); } catch { }
  try { return new RegExp(q); } catch { }
  return null;
};
const libRes = b => (LIB[b]?.keywords || []).map(k => ({ raw: k, re: comp(k) })).filter(x => x.re);
// 按 regex_side 精确取：分支实际引用的是全局库中哪些具名分支
const sideRes = names => {
  const out = [];
  for (const n of names || [])
    for (const k of (LIB[n]?.keywords || [])) {
      const re = comp(k);
      if (re) out.push({ raw: k, re, lib: n });
    }
  return out;
};

// 每个 bot：话术->step 索引
const BOTS = {};
for (const bid of Object.keys(T)) {
  const stepByText = new Map();
  const steps = [];
  for (const lay of ['flow', 'multi']) {
    for (const s of T[bid].layers[lay]) {
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
      steps.push(rec);
    }
  }
  BOTS[bid] = { stepByText, steps };
}

const SYS = /^(您好。?在吗|您好[，,]?您能听到我(的)?说话吗|条件判断|系统|请稍等|正在为您转接)/;

function locate(bid, aiText) {
  const t = norm(aiText);
  if (!t || t.length < 6) return null;
  const B = BOTS[bid];
  if (B.stepByText.has(t)) return B.stepByText.get(t);
  // 前缀兜底（截断）
  for (const [k, v] of B.stepByText) {
    if (k.length >= 10 && t.length >= 10 && (t.startsWith(k.slice(0, 18)) || k.startsWith(t.slice(0, 18)))) return v;
  }
  // 片段兜底
  if (t.length >= 16) {
    for (const [k, v] of B.stepByText) {
      for (let i = 0; i + 14 <= t.length; i += 7) if (k.includes(t.slice(i, i + 14))) return v;
    }
  }
  return null;
}

function botOf(t) {
  if (!t) return null;
  if (t.includes('刷单') || t.includes('投资理财、贷款')) return '2161410';
  if (t.includes('虚假投资理财类诈骗高发')) return '420469';
  if (t.includes('诈骗案件高发')) return '420445';
  return null;
}

const DEF = new Set(['默认', '兜底', '其他']);
const GREET = new Set(['开场白']);

const byCall = new Map();
const rl = readline.createInterface({ input: fs.createReadStream(`${OUT}/dialogue_turns.jsonl`), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const o = JSON.parse(line);
  const id = String(o.id);
  if (!byCall.has(id)) byCall.set(id, []);
  byCall.get(id).push(o);
}

const stat = { calls: 0, steps: 0, exact: 0, exactPct: 0, ok: 0, okDefault: 0,
  errWrong: 0, errDefault: 0, noMatch: 0, noMatchNoDef: 0, okInternalSeq: 0, skipNoJudge: 0, noStep: 0, lastTurn: 0, sysLike: 0 };
const problems = [];
const gaps = [];

for (const [id, turns] of byCall) {
  const firstAI = turns.find(t => t.role === 'AI');
  const bid = botOf(firstAI ? firstAI.text : '');
  if (!bid || !BOTS[bid]) continue;
  stat.calls++;

  const stepOf = new Map();
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role !== 'AI') continue;
    const raw = (turns[i].text || '').trim();
    if (!raw) continue;
    if (SYS.test(raw)) { stat.sysLike++; continue; }
    const s = locate(bid, raw);
    if (s) stepOf.set(i, s);
  }

  for (let i = 0; i < turns.length; i++) {
    const tr = turns[i];
    if (tr.role !== 'ME') continue;
    const text = (tr.text || '').trim();
    if (!text) continue;

    let ci = -1;
    for (let j = i - 1; j >= 0; j--) if (stepOf.has(j)) { ci = j; break; }
    if (ci < 0) { stat.noStep++; continue; }
    let cur = stepOf.get(ci);

    // 该 step 只有默认/原地分支 -> 是纯告知话术，没有分支判定可言，跳过
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

    const defEdge = cur.edges.find(e => DEF.has(e.branch));

    // "原地"分支（target=None）= 在本节点内顺序说下一句，合法
    const sameNodeSeq = (cur.node === next.node) && (cur.path !== next.path);

    if (matched.length === 0) {
      stat.noMatch++;
      // 弱监督：AI 实际去了哪，反推本该命中哪个分支
      const cands = cur.edges.filter(e => e.target && next.node === e.target).map(e => e.branch);
      gaps.push({ id, bot: bid, node: cur.node, path: cur.path, text, next: next.node,
        cands: cands.join(','), hasDefault: !!defEdge, defTarget: defEdge ? defEdge.target : null });
      if (defEdge && defEdge.target) {
        if (next.node === defEdge.target) stat.okDefault++;
        else {
          stat.errDefault++;
          problems.push({ id, bot: bid, node: cur.node, path: cur.path, text,
            kind: '2-该走默认却偏离', expected: defEdge.target, actual: next.node,
            detail: `无分支命中，【默认】本应去「${defEdge.target}」，实际去「${next.node}」`, branches: '' });
        }
      } else if (sameNodeSeq) {
        // 该 step 的默认分支原地续说，AI 确实在本节点内推进
        stat.okInternalSeq++;
      } else {
        stat.noMatchNoDef++;
      }
      continue;
    }

    const targets = [...new Set(matched.map(m => m.target).filter(Boolean))];
    if (targets.length === 0) {
      // 命中的分支都是"原地续说"：同节点内推进即正确
      if (sameNodeSeq || next.node === cur.node) stat.ok++;
      else stat.okInternalSeq++;
      continue;
    }
    if (targets.includes(next.node)) { stat.ok++; continue; }

    stat.errWrong++;
    problems.push({ id, bot: bid, node: cur.node, path: cur.path, text,
      kind: '1-命中分支却走错去向', expected: targets[0], actual: next.node,
      branches: matched.map(m => m.branch).join(','),
      detail: `命中[${matched.map(m => `${m.branch}→${m.target || '原地'}`).join(' / ')}]，实际去「${next.node}」` });
  }
}

console.error('STAT', JSON.stringify(stat, null, 2));
fs.writeFileSync(`${OUT}/tree_problems.json`, JSON.stringify(problems, null, 1));
fs.writeFileSync(`${OUT}/tree_gaps.json`, JSON.stringify(gaps, null, 1));
fs.writeFileSync(`${OUT}/tree_stat.json`, JSON.stringify(stat, null, 1));
console.error('problems', problems.length, 'gaps', gaps.length);
