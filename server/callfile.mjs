// callfile.mjs — 通话记录文件解析：xlsx / csv / jsonl → 统一 calls 格式
// 兼容两种输入形态：
//   A) 外呼导出：一通一行，content 列 = JSON 数组字符串 ["1:AI:...", "2:ME:...", ...]
//      （百应后台导出 Excel 的常见格式）
//   B) 呼入导出：一行一轮（inbound_instance_id / speaker_type / content / inbound_instance_log_id）
//      （DLC 呼入表导出格式；也兼容工作区里"租户91386_呼入记录_近2个月.xlsx"的列名）
// 解析后统一为 {id, turns:[{role:'AI'|'ME', text}]}
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

// 用 bundled python 读 xlsx（openpyxl），避免加 node 依赖
function readXlsx(filePath) {
  const py = process.env.DSH_PYTHON
    || path.join(process.env.HOME || '', '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3');
  const script = `
import json, sys
from openpyxl import load_workbook
wb = load_workbook(sys.argv[1], read_only=True, data_only=True)
ws = wb[wb.sheetnames[0]]
rows = []
for r in ws.iter_rows(values_only=True):
    rows.append(['' if c is None else str(c) for c in r])
print(json.dumps(rows, ensure_ascii=False))
`;
  const r = spawnSync(py, ['-c', script, filePath], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`xlsx 解析失败：${(r.stderr || r.stdout || '').slice(0, 300)}`);
  return JSON.parse(r.stdout);
}

function readCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  // 简易 CSV：支持引号包裹
  const parseLine = l => {
    const out = []; let cur = '', inQ = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (inQ) {
        if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur); return out;
  };
  return lines.map(parseLine);
}

const norm = s => String(s ?? '').replace(/<break[^>]*>/g, '').replace(/条件判断-条件判断节点/g, '').trim();

const ROLE_MAP = { AI: 'AI', ME: 'ME', 用户: 'ME', 客户: 'ME', 人工客服: 'ME', USER: 'ME' };

// 识别每行 role:text 的 "1:AI:xxx" 前缀
const TURN_RE = /^(\d+)\s*[:：]\s*(AI|ME|用户|人工客服|客户|USER)\s*[:：]\s*(.*)$/s;
// 识别行首角色标签 "AI：xxx / 用户：xxx"（百应后台呼入导出"通话记录"列格式）
const LABEL_RE = /^\s*(AI|ME|用户|客户|人工客服|USER)\s*[:：]\s*/;

export function parseCallRows(header, rows) {
  const cols = header.map(h => String(h || '').trim());
  const colIdx = name => cols.findIndex(c => c === name);
  const colRe = re => cols.findIndex(c => re.test(c));

  const idCol = colRe(/inbound_instance_id|call_instance_id|通话记录id|通话ID|通话id|实例ID|instance_id|^id$/i);
  const speakerCol = colRe(/speaker_type|角色|speaker|role/i);
  const contentCol = colRe(/^(通话记录|对话记录|content|对话内容|文本)$/i);
  const logCol = colRe(/inbound_instance_log_id|轮次|turn|log_id/i);

  const isPerTurn = speakerCol >= 0 && contentCol >= 0;   // 呼入逐轮格式
  const calls = [];

  if (isPerTurn) {
    // —— 呼入逐轮：按 id 分组、按 log_id/出现顺序排 ——
    const byCall = new Map();
    rows.forEach((r, ri) => {
      const id = String(r[idCol >= 0 ? idCol : 0] ?? '').trim();
      if (!id) return;
      if (!byCall.has(id)) byCall.set(id, []);
      const roleRaw = String(r[speakerCol] ?? '').trim().toUpperCase();
      const role = ROLE_MAP[roleRaw] || (roleRaw === 'AI' ? 'AI' : 'ME');
      const text = norm(r[contentCol]);
      if (!text) return;
      const order = logCol >= 0 ? Number(r[logCol]) || ri : ri;
      byCall.get(id).push({ role, text, order });
    });
    for (const [id, turns] of byCall) {
      turns.sort((a, b) => a.order - b.order);
      calls.push({ id, turns: turns.map(t => ({ role: t.role, text: t.text })) });
    }
  } else {
    // —— 外呼一通一行：content 列 = JSON 数组、角色标签行、或 "1:AI:xxx" 分隔 ——
    const cCol = contentCol >= 0 ? contentCol : cols.findIndex(c => /通话记录|对话记录/.test(c));
    const useCol = cCol >= 0 ? cCol : cols.length - 1;
    rows.forEach((r, ri) => {
      const id = String(r[idCol >= 0 ? idCol : 0] ?? '').trim() || `row${ri}`;
      let content = r[useCol];
      if (typeof content === 'string') {
        const raw = content;
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = null; }
        if (Array.isArray(parsed)) {
          content = parsed;
        } else {
          // 角色标签格式："AI：您好…\n用户：好的" —— 按行拆，每行带 AI/用户 前缀
          const lines = raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
          const labeled = lines.filter(l => LABEL_RE.test(l));
          if (labeled.length) {
            content = lines.map(l => l.replace(LABEL_RE, (m0, g) => `${g === 'AI' ? 'AI' : 'ME'}: `));
          } else {
            content = lines.length > 1 ? lines : [raw];
          }
        }
      }
      if (!Array.isArray(content)) content = [String(content)];
      const turns = content.map(line => {
        const m = String(line).match(TURN_RE);
        if (m) return { role: ROLE_MAP[m[2].toUpperCase()] || 'ME', text: norm(m[3]) };
        const lm = String(line).match(/^\s*(AI|ME)\s*[:：]\s*([\s\S]*)$/);
        if (lm) return { role: lm[1], text: norm(lm[2]) };
        return { role: 'ME', text: norm(line) };
      }).filter(t => t.text);
      if (turns.length) calls.push({ id, turns });
    });
  }
  return calls;
}

export function parseCallFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let header, rows;
  if (ext === '.xlsx' || ext === '.xls') {
    const all = readXlsx(filePath);
    if (!all.length) throw new Error('Excel 文件为空');
    header = all[0]; rows = all.slice(1).filter(r => r.some(c => String(c).trim()));
  } else if (ext === '.csv') {
    const all = readCsv(filePath);
    header = all[0] || []; rows = all.slice(1).filter(r => r.some(c => String(c).trim()));
  } else if (ext === '.jsonl') {
    // jsonl：{id,turns:[{role,text}]} 或逐轮 {id,turn,role,text}
    const byCall = new Map();
    for (const l of fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)) {
      const o = JSON.parse(l);
      if (o.turns) { byCall.set(String(o.id), o.turns.map(t => ({ role: t.role === 'AI' ? 'AI' : 'ME', text: norm(t.text) })).filter(t => t.text)); continue; }
      const id = String(o.id);
      if (!byCall.has(id)) byCall.set(id, []);
      const text = norm(o.text);
      if (text) byCall.get(id).push({ role: o.role === 'AI' ? 'AI' : 'ME', text, order: o.turn ?? byCall.get(id).length });
    }
    return [...byCall].map(([id, turns]) => ({ id, turns: turns.map(t => ({ role: t.role, text: t.text })) }));
  } else {
    throw new Error(`不支持的文件类型 ${ext}（支持 .xlsx/.csv/.jsonl）`);
  }
  return parseCallRows(header, rows);
}
