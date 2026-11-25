// qfile.mjs —— 批量问句文件解析：txt / csv / xlsx / jsonl，每行一条问句
// 兼容格式：
//   txt: 纯问句行（# 或 // 开头为注释行跳过）
//   csv: 逗号分隔，取第一列（表头自动跳过；只识别一列或含「问句」表头）
//   xlsx: 第一列问句（表头自动跳过；含「问句」表头时按表头列取）
//   jsonl: {"question":"..."} 逐行
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

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

function readCsvRows(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  return lines.map(l => {
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
  });
}

const clean = s => String(s ?? '').replace(/<break[^>]*>/g, '').trim();
const isHeader = s => /^(问句|问题|句子|query|question)$/i.test(s);
const looksLikeHeader = s => /^(问句|问题|句子|query|question)s?$/i.test(s);
const isComment = s => /^#|^\/\//.test(s);

export function parseQuestions(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let raw = [];
  if (ext === '.txt') {
    raw = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map(clean);
  } else if (ext === '.csv') {
    const rows = readCsvRows(filePath);
    const headerLooks = rows.length && rows[0].some(isHeader);
    const start = headerLooks ? 1 : 0;
    raw = rows.slice(start).map(r => clean(r[0]));
  } else if (ext === '.xlsx' || ext === '.xls') {
    const rows = readXlsx(filePath);
    const headerLooks = rows.length && rows[0].some(looksLikeHeader);
    const start = headerLooks ? 1 : 0;
    raw = rows.slice(start).map(r => clean(r[0]));
  } else if (ext === '.jsonl') {
    raw = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { const o = JSON.parse(l); return clean(o.question || o.q || o.text || o.sentence); } catch { return ''; } });
  } else {
    throw new Error(`不支持的文件类型 ${ext}（支持 .txt/.csv/.xlsx/.jsonl）`);
  }
  // 去重保序 + 过滤空/注释
  const seen = new Set(); const out = [];
  for (const q of raw) {
    const t = String(q || '').trim();
    if (!t || isComment(t) || seen.has(t)) continue;
    seen.add(t); out.push(t);
  }
  if (!out.length) throw new Error('文件中未解析到有效问句');
  return out;
}
