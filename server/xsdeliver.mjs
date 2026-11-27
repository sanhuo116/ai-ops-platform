// xsdeliver.mjs —— 相似问泛化交付物生成（python openpyxl）
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const PY = process.env.DSH_PYTHON
  || path.join(process.env.HOME || '', '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3');

const SCRIPT = `
import json, sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

inp = json.load(open(sys.argv[1], encoding='utf-8'))
out = sys.argv[2]

HDR_FILL = PatternFill('solid', fgColor='1F4E79')
HDR_FONT = Font(color='FFFFFF', bold=True, size=11)
THIN = Border(*[Side(style='thin', color='D9D9D9')]*4)

def style_header(ws, ncols):
    for c in range(1, ncols+1):
        cell = ws.cell(row=1, column=c)
        cell.fill = HDR_FILL; cell.font = HDR_FONT
        cell.alignment = Alignment(horizontal='center', vertical='center')
    ws.freeze_panes = 'A2'

def put(ws, rows, widths):
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    for r in rows:
        ws.append(r)
        for c in range(1, len(r)+1):
            cell = ws.cell(row=ws.max_row, column=c)
            cell.border = THIN
            cell.alignment = Alignment(vertical='top', wrap_text=True)

# ① 相似问交付
wb = Workbook(); ws = wb.active; ws.title = '相似问交付'
rows = [['标准问', '分组', '答案', '相似问（英文逗号分隔）', '生成条数']]
for it in inp['items']:
    rows.append([it['title'], it.get('group',''), it.get('answer',''), ','.join(it['sims']), len(it['sims'])])
put(ws, rows, [34, 14, 46, 80, 9]); style_header(ws, 5)

# ② 校验报告
ws2 = wb.create_sheet('校验报告')
rows = [['标准问', '目标数', '生成数', '批内去重剔除', '撞历史黑名单', '红线告警', '区分度告警', '结论']]
for v in inp['verify']:
    rows.append([v['title'], v['need'], v['got'], v['dupRemoved'], v['blacklistHit'],
                 '; '.join(v.get('redline', [])) or '-', v.get('distinct', '-') or '-', v['verdict']])
put(ws2, rows, [34, 8, 8, 12, 12, 26, 26, 10]); style_header(ws2, 8)

# ③ 任务总览
ws3 = wb.create_sheet('任务总览')
rows = [['指标', '数值']] + [[k, str(v)] for k, v in inp['stat'].items()]
put(ws3, rows, [30, 40]); style_header(ws3, 2)
wb.save(out)

# ④ 批量导入模板（与平台知识库模板列结构一致：标准问｜分组｜答案｜相似问）
wb4 = Workbook(); ws4 = wb4.active; ws4.title = '知识库导入'
rows = [['标准问', '分组', '答案', '相似问（英文逗号分隔）']]
for it in inp['items']:
    rows.append([it['title'], it.get('group',''), it.get('answer',''), ','.join(it['sims'])])
put(ws4, rows, [34, 14, 46, 80]); style_header(ws4, 4)
wb4.save(sys.argv[3])
print('ok')
`;

export function buildXsDeliverables(data, xlsxOut, tplOut) {
  const jsonIn = xlsxOut.replace(/\.xlsx$/, '.json');
  fs.writeFileSync(jsonIn, JSON.stringify(data));
  const r = spawnSync(PY, ['-c', SCRIPT, jsonIn, xlsxOut, tplOut], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  try { fs.unlinkSync(jsonIn); } catch { }
  if (r.status !== 0 || !fs.existsSync(xlsxOut)) throw new Error(`xlsx 生成失败：${(r.stderr || r.stdout || '').slice(0, 300)}`);
}

// 换行文本版：每条相似问一行，按条目分节
export function buildXsText(items, meta) {
  const L = [];
  L.push(`# 相似问泛化结果（${meta.sceneLabel} · 每 KB ${meta.perKb} 条）`);
  L.push(`# bot ${meta.botId} · 条目 ${items.length} · 生成时间 ${new Date().toLocaleString('zh-CN')}`);
  L.push('');
  items.forEach((it, i) => {
    L.push(`【${i + 1}】标准问：${it.title}${it.group ? `（分组：${it.group}）` : ''}`);
    for (const q of it.sims) L.push(q);
    L.push('');
  });
  return L.join('\n');
}
