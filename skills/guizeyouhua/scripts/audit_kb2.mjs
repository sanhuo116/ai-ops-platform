// audit_kb2.mjs —— 两类知识库问题的可判定版本
//
// 判定原则：只用客观证据，不猜语义。
//
// 【问题一】框架内未命中
//   定义：市民话术命中了某条知识库规则（正则或相似问法），但 AI 没有按该条目的去向推进。
//   证据：该条目有 target，且 AI 下一句仍在原节点/去了别的节点。
//   另外单列"死条目"：知识库里有这条意图，但既无正则也无相似问法 —— 结构上永远不可能命中。
//
// 【问题二】框架外意图
//   定义：市民话术带有明确的问询/诉求标记（疑问词、请求词、"你们/我能不能"等），
//        但知识库所有条目的正则与相似问法都匹配不上，AI 仍给出了某句固定话术。
//   证据客观：疑问/诉求标记是语言学可枚举的，不依赖语义模型。
import fs from 'node:fs';
import readline from 'node:readline';

const OUT = process.argv[2] || '<WORKSPACE>/work/byai-calls';
const KB = JSON.parse(fs.readFileSync(`${OUT}/kb_parsed.json`, 'utf8'));
const TREE = JSON.parse(fs.readFileSync(`${OUT}/flow_tree.json`, 'utf8'));

const norm = s => (s || '')
  .replace(/[（(]\s*停顿\s*\d+\s*[sS秒]?\s*[）)]/g, '')
  .replace(/[\s，。！？、,.!?…~—\-·；：""''（）()【】\[\]]/g, '');

const comp = p => {
  const q = (p || '').replace(/\{0<>\s*/g, '{0,').replace(/\{(\d+)<>\s*/g, '{1,');
  try { return new RegExp(q, 'u'); } catch { }
  try { return new RegExp(q); } catch { }
  return null;
};

const BOTS = {};
for (const bid of Object.keys(KB)) {
  const entries = KB[bid].map(e => ({
    ...e,
    res: (e.keywords || []).map(k => ({ raw: k, re: comp(k) })).filter(x => x.re),
    norms: [e.standard, ...(e.similars || [])].map(x => norm(x)).filter(x => x.length >= 2),
  }));
  const stepByText = new Map();
  for (const lay of ['flow', 'multi'])
    for (const s of TREE[bid].layers[lay]) {
      const n = norm(s.text);
      if (n.length >= 6 && !stepByText.has(n)) stepByText.set(n, s);
    }
  BOTS[bid] = { entries, stepByText };
}

function locate(bid, aiText) {
  const t = norm(aiText);
  if (!t || t.length < 6) return null;
  const B = BOTS[bid];
  if (B.stepByText.has(t)) return B.stepByText.get(t);
  for (const [k, v] of B.stepByText)
    if (k.length >= 10 && t.length >= 10 && (t.startsWith(k.slice(0, 18)) || k.startsWith(t.slice(0, 18)))) return v;
  if (t.length >= 16)
    for (const [k, v] of B.stepByText)
      for (let i = 0; i + 14 <= t.length; i += 7) if (k.includes(t.slice(i, i + 14))) return v;
  return null;
}

// 知识库严格匹配：正则 或 相似问法字面包含（不做反向包含，避免"我在"匹配一切）
function kbMatch(bid, text) {
  const B = BOTS[bid];
  const t = norm(text);
  if (!t) return null;
  for (const e of B.entries)
    for (const k of e.res) if (k.re.test(text)) return { e, how: 'regex', pat: k.raw };
  for (const e of B.entries)
    for (const n of e.norms) {
      if (!n || n.length < 2) continue;
      if (t === n || t.includes(n)) return { e, how: 'similar', pat: n };
    }
  return null;
}

// 明确意图标记：疑问词/诉求词。"明显意图"由语言学标记客观界定。
// 第一类：市民主动发问（询问身份/目的/原因/处理方式）
const ASK = /(什么|啥|哪位|谁呀|谁啊|是谁|怎么了|怎么啦|干啥|干嘛|什么事|咋回事|为什么|咋办|如何)/;
// 第二类：诉求/质疑标记
const INTENT = /(怎么办|怎么弄|怎么处理|为什么|为什么呀|什么意思|啥意思|什么情况|真的假的|是不是真的|是不是骗子|你们是谁|你是哪|你是干什么|哪里来的|怎么知道|谁告诉你|我的钱|能不能|可不可以|我要报|我想报|帮我|告诉我|我要查|查一下|我该怎么办|钱能|能追回|退回来|退钱|抓到了|报警|举报|投诉|冻结|银行卡|账号被|已经转了|我转了|我被骗|转钱了|扣钱了|扣费|我不同意|我要求|必须|凭什么|你有证件|证件|工号|派出所|公安局|你说什么|再说一遍|听不清|听不到)/;
const FILLER = /^(喂|你好|喂喂|哎|诶|啊|哦|嗯|嗯嗯|哦哦|好好|行|对|是的|好的|好|可以|谢谢|谢谢啊|拜拜|再见|我|你|他|那个|这个|呃|哼|明白|知道|清楚|了解|懂了)/;

function isFiller(t) {
  const s = norm(t);
  return !s || (s.length <= 8 && FILLER.test(s));
}

const byCall = new Map();
const rl = readline.createInterface({ input: fs.createReadStream(`${OUT}/dialogue_turns.jsonl`), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const o = JSON.parse(line);
  const id = String(o.id);
  if (!byCall.has(id)) byCall.set(id, []);
  byCall.get(id).push(o);
}

function botOf(t) {
  if (!t) return null;
  if (t.includes('刷单') || t.includes('投资理财、贷款')) return '2161410';
  if (t.includes('虚假投资理财类诈骗高发')) return '420469';
  if (t.includes('诈骗案件高发')) return '420445';
  return null;
}

const inFrame = [];
const outFrame = [];
const stat = { calls: 0, meTurns: 0, filler: 0, intentMarked: 0,
  intentNoKb: 0, intentNoKbWithReply: 0, kbHit: 0, kbHitNoRedirect: 0 };

for (const [id, turns] of byCall) {
  const firstAI = turns.find(t => t.role === 'AI');
  const bid = botOf(firstAI ? firstAI.text : '');
  if (!bid || !BOTS[bid]) continue;
  stat.calls++;

  for (let i = 0; i < turns.length; i++) {
    const tr = turns[i];
    if (tr.role !== 'ME') continue;
    const text = (tr.text || '').trim();
    if (!text) continue;
    stat.meTurns++;
    if (isFiller(text)) { stat.filler++; continue; }

    let cur = null;
    for (let j = i - 1; j >= 0; j--) if (turns[j].role === 'AI' && (turns[j].text || '').trim()) { cur = locate(bid, turns[j].text); if (cur) break; }

    let nxt = null;
    for (let j = i + 1; j < turns.length; j++) if (turns[j].role === 'AI' && (turns[j].text || '').trim()) { nxt = turns[j]; break; }

    const hit = kbMatch(bid, text);

    if (hit) {
      stat.kbHit++;
      // 命中但没按其去向推进
      if (hit.e.target && cur && nxt) {
        const after = locate(bid, nxt.text);
        if (after && after.node !== hit.e.target && after.node === cur.node) {
          stat.kbHitNoRedirect++;
          inFrame.push({ id, bot: bid, node: cur.node, text,
            kb: hit.e.title || hit.e.standard, how: hit.how, pat: hit.pat,
            kbTarget: hit.e.target, actual: after.node });
        }
      }
      continue;
    }

    // 未命中任何知识库条目
    const t2 = norm(text);
    if (INTENT.test(text) || (ASK.test(text) && t2.length <= 14)) {
      stat.intentMarked++;
      stat.intentNoKb++;
      if (nxt) {
        stat.intentNoKbWithReply++;
        outFrame.push({ id, bot: bid, node: cur ? cur.node : '(未知)', text,
          aiReply: (nxt.text || '').slice(0, 90),
          tag: INTENT.test(text) ? '诉求/质疑' : '主动发问' });
      }
    }
  }
}

console.error('STAT', JSON.stringify(stat, null, 2));
fs.writeFileSync(`${OUT}/kb_inframe2.json`, JSON.stringify(inFrame, null, 1));
fs.writeFileSync(`${OUT}/kb_outframe2.json`, JSON.stringify(outFrame, null, 1));
fs.writeFileSync(`${OUT}/kb_stat2.json`, JSON.stringify(stat, null, 1));
console.error('inFrame', inFrame.length, 'outFrame', outFrame.length);
