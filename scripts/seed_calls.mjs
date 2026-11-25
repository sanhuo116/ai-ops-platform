// 从全量对话缓存中抽取指定 bot 的通话（演示任务用），格式与线上取数一致
// 用法: node seed_calls.mjs <botId> <outJsonl> [maxCalls]
import fs from 'node:fs';
import readline from 'node:readline';

const [botId, out, maxStr] = process.argv.slice(2);
const MAX = Number(maxStr) || 8000;
const SRC = `${process.env.HOME}/Documents/deepseek-harness/default-workspace/work/byai-calls/dialogue_turns.jsonl`;

const botOf = t => {
  if (!t) return null;
  if (t.includes('刷单') || t.includes('投资理财、贷款')) return '2161410';
  if (t.includes('虚假投资理财类诈骗高发')) return '420469';
  if (t.includes('诈骗案件高发')) return '420445';
  return null;
};

// 第一遍：记录每通电话的行号区间
const map = new Map(); // id -> {start, end, bot}
let idx = 0;
const rl = readline.createInterface({ input: fs.createReadStream(SRC), crlfDelay: Infinity });
rl.on('line', l => {
  if (!l.trim()) { idx++; return; }
  const o = JSON.parse(l);
  let m = map.get(String(o.id));
  if (!m) { m = { start: idx, end: idx, bot: null }; map.set(String(o.id), m); }
  m.end = idx;
  if (!m.bot && o.role === 'AI') m.bot = botOf(o.text);
  idx++;
});
await new Promise(r => rl.on('close', r));
console.error('total calls:', map.size);

// 收集目标 bot 的通话
const wanted = [...map.entries()].filter(([, m]) => m.bot === botId).slice(0, MAX);
console.error('calls for', botId, ':', wanted.length);

// 第二遍：按行号区间提取
const lines = [];
const rl2 = readline.createInterface({ input: fs.createReadStream(SRC), crlfDelay: Infinity });
let i = 0;
const ranges = wanted.map(([id, m]) => ({ id, lo: m.start, hi: m.end }));
ranges.sort((a, b) => a.lo - b.lo);
let ri = 0;
rl2.on('line', l => {
  while (ri < ranges.length && i > ranges[ri].hi) ri++;
  if (ri < ranges.length && i >= ranges[ri].lo && i <= ranges[ri].hi) lines.push(l);
  i++;
});
await new Promise(r => rl2.on('close', r));

fs.writeFileSync(out, lines.join('\n') + '\n');
console.error('written', lines.length, 'lines ->', out);
