// kwexport.mjs —— 批次结果导出：xlsx 双表（汇总 + 逐条验证明细），用 bundled python + openpyxl
// 汇总表：问句 / 意图 / 状态 / 正则 / 泛化数 / 规避数 / 修复轮数 / 来源 / 耗时 / 尝试次数
// 明细表：问句 / 类型（泛化|规避）/ 句子 / 命中（✓✗）/ 命中片段
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { getKwBatch, listKwTasks } from './store.mjs';

const STATUS_LABEL = { queued: '排队', running: '生成中', done: '完成', failed: '失败' };

export function exportBatchXlsx(batchId, outPath) {
  const b = getKwBatch(batchId);
  if (!b) throw new Error('批次不存在');
  const rows = listKwTasks({ batchId, limit: 500 }).sort((a, b2) => (a.seq || 0) - (b2.seq || 0));
  if (!rows.length) throw new Error('批次下没有任务');

  const summary = [['序号', '问句', '意图', '状态', '验证结果', '三段式正则', '泛化数', '规避数', '修复轮数', '来源', '耗时(秒)', '尝试次数', '最后诊断']];
  const detail = [['问句', '类型', '句子', '命中', '命中片段']];
  for (const r of rows) {
    const res = r.result || {};
    const v = res.verified || {};
    const miss = (v.general || []).filter(x => !x.hit).length;
    const falseHit = (v.negatives || []).filter(x => x.hit).length;
    const verdict = r.status === 'done' && !miss && !falseHit ? `全通过（泛化${(v.general || []).length}/${(v.general || []).length} + 规避${(v.negatives || []).length}/${(v.negatives || []).length}）`
      : r.status === 'failed' ? `未收敛（泛化未中${miss}/规避误中${falseHit}）`
      : r.status || '';
    summary.push([
      r.seq ?? '', r.question, res.intent || '',
      STATUS_LABEL[r.status] || r.status,
      verdict,
      res.regex || '',
      (res.general || []).length, (res.negatives || []).length,
      res.rounds ?? '', res.source || '',
      res.elapsedMs ? Math.round(res.elapsedMs / 1000) : '',
      res.attempts ?? '', res.lastDiagnosis || r.error || '',
    ]);
    for (const x of v.general || []) detail.push([r.question, '泛化', x.text, x.hit ? '✓' : '✗ 未中', x.seg || '']);
    for (const x of v.negatives || []) detail.push([r.question, '规避', x.text, (!x.hit) ? '✓（正确不命中）' : '✗ 误中', x.seg || '']);
  }

  const py = process.env.DSH_PYTHON
    || path.join(process.env.HOME || '', '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3');
  const payload = JSON.stringify({
    sheets: [['批次汇总', summary], ['验证明细', detail]],
    widths: {
      '批次汇总': [6, 22, 40, 8, 34, 60, 8, 8, 9, 12, 9, 9, 40],
      '验证明细': [22, 8, 40, 16, 24],
    },
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = outPath + '.json';
  fs.writeFileSync(tmp, payload, 'utf8');
  // 数据经临时 .json 文件传入（json.loads 读文件而非 -c argv，规避中文/引号转义问题），脚本也落临时 .py
  const scriptFile = `import json, sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

data = json.loads(open(sys.argv[1], encoding='utf-8').read())
out = sys.argv[2]
sheets = data['sheets']

wb = Workbook()
header_fill = PatternFill('solid', fgColor='EFF3FA')
header_font = Font(bold=True, color='1F2937')
green_font = Font(color='15803D')
red_font = Font(color='B91C1C')

first = True
for name, rows in sheets:
    ws = wb.active if first else wb.create_sheet()
    ws.title = name
    first = False
    ws.append(rows[0])
    for c in ws[1]:
        c.fill = header_fill
        c.font = header_font
        c.alignment = Alignment(vertical='center')
    for row in rows[1:]:
        ws.append(row)
    widths = data.get('widths', {}).get(name, [])
    for i, w in enumerate(widths, 1):
        if w:
            ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = 'A2'
    hit_col = 4 if name == '验证明细' else None
    if hit_col:
        for row in ws.iter_rows(min_row=2):
            cell = row[hit_col - 1]
            if cell.value and '✗' in str(cell.value):
                cell.font = red_font
            elif cell.value:
                cell.font = green_font
wb.save(out)
print('saved')
`;
  fs.writeFileSync(tmp + '.py', scriptFile, 'utf8');
  try {
    const r = spawnSync(py, [tmp + '.py', tmp, outPath], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`xlsx 生成失败：${(r.stderr || r.stdout || '').slice(0, 300)}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch { }
    try { fs.unlinkSync(tmp + '.py'); } catch { }
  }
  return { file: outPath, total: rows.length, detailRows: detail.length - 1 };
}
