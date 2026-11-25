// sycalls.mjs —— 私有化任务通话记录解析：百应线索导出 zip/xlsx（流式 SAX，支持 80 万行级大文件）
// 格式（黔南参考任务）：线索编号|联系方式|外呼任务模板|通话记录ID|通话状态|通话时长(秒)|拨打轮次|通话开始时间|通话结束时间|标签|通话详情
// 通话详情列 = "AI:...\nME:..." 逐轮文本（\xa 分隔）；统一输出 {id, tpl, turns:[{role,text}]}
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';

const PY = process.env.DSH_PYTHON
  || path.join(process.env.HOME || '', '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3');

// 流式 SAX 解析 xlsx → jsonl（通话记录），处理 300MB+ 级 sheet xml 不爆内存
// 输出行：{id, tpl, turns:[{role,text}]}
export function parseLeadXlsxToJsonl(xlsxPath, jsonlPath, log = () => { }) {
  const script = `
import sys, zipfile, re, json
from xml.parsers import expat

XLSX, OUT = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(XLSX)
# sheet1 = 线索通话记录（本格式只有一个数据 sheet + 可能的聚合 sheet，都解析取第一个非空）
sheet_name = [n for n in z.namelist() if re.match(r'xl/worksheets/sheet\\d+\\.xml$', n)][0]

parser = expat.ParserCreate()
state = {'row': None, 'cells': {}, 'cur_col': None, 'buf': [], 'in_t': False, 'n': 0, 'out': open(OUT, 'w', encoding='utf8')}
HDR = None
# 列顺序由 header 决定：线索编号|联系方式|外呼任务模板|通话记录ID|通话状态|通话时长|拨打轮次|开始|结束|标签|通话详情

def flush_call(cells, hdr):
    d = dict(zip(hdr, cells))
    detail = d.get('通话详情', '')
    cid = d.get('通话记录ID') or d.get('线索编号') or ('r' + str(state['n']))
    if not detail or not detail.strip():
        return
    turns = []
    for line in detail.split('\\n'):
        line = line.strip()
        if not line: continue
        m = re.match(r'^(AI|ME|用户|客户)\\s*[:：]\\s*(.*)$', line, re.S)
        if m:
            role = 'AI' if m.group(1) == 'AI' else 'ME'
            text = m.group(2).strip()
        else:
            role, text = 'ME', line
        if text: turns.append({'role': role, 'text': text})
    if not turns: return
    state['out'].write(json.dumps({'id': str(cid), 'tpl': d.get('外呼任务模板', ''), 'turns': turns}, ensure_ascii=False) + '\\n')
    state['n'] += 1
    if state['n'] % 50000 == 0: print(f'  parsed {state["n"]} calls', file=sys.stderr, flush=True)

def start(name, attrs):
    if name == 'row':
        state['row'] = attrs.get('r'); state['cells'] = {}
    elif name == 'c':
        ref = attrs.get('r', '')
        m = re.match(r'([A-Z]+)', ref)
        state['cur_col'] = col_idx(m.group(1)) if m else None
        state['buf'] = []
        state['in_t'] = attrs.get('t') == 'inlineStr' or attrs.get('t') == 'str'
    elif name == 't':
        state['in_t'] = True

def col_idx(letters):
    n = 0
    for ch in letters: n = n * 26 + (ord(ch) - 64)
    return n - 1

def end(name):
    if name == 't':
        pass
    elif name == 'c':
        if state['cur_col'] is not None:
            state['cells'][state['cur_col']] = ''.join(state['buf'])
        state['buf'] = []
    elif name == 'row':
        cells = [state['cells'].get(i, '') for i in range(0, max(state['cells'].keys(), default=-1) + 1)]
        if state['row'] == '1':
            global HDR
            HDR = cells
        elif HDR:
            flush_call(cells, HDR)
        state['cells'] = {}

parser.StartElementHandler = start
parser.EndElementHandler = end
parser.CharacterDataHandler = lambda data: state['buf'].append(data)

with z.open(sheet_name) as f:
    parser.ParseFile(f)
state['out'].close()
print(f'DONE {state["n"]}', file=sys.stderr)
`;
  const r = spawnSync(PY, ['-c', script, xlsxPath, jsonlPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 });
  if (r.status !== 0) {
    const msg = ((r.stderr || '') + (r.stdout || '')).slice(-500);
    throw new Error(`线索 xlsx 解析失败：${msg}`);
  }
  const n = Number((r.stderr || '').match(/DONE (\d+)/)?.[1] || 0);
  log(`通话记录解析：${n} 通`);
  return n;
}

// 解包 zip：支持直接包含 .xlsx / .jsonl / .csv（递归一层）
export function extractCallsZip(zipPath, destDir, log = () => { }) {
  fs.mkdirSync(destDir, { recursive: true });
  const files = [];
  if (/\.zip$/i.test(zipPath)) {
    // unzip -o 覆盖解包（macOS 自带）
    execSync(`unzip -o -q ${JSON.stringify(zipPath)} -d ${JSON.stringify(destDir)} -x "__MACOSX/*" "*.DS_Store"`, { timeout: 10 * 60 * 1000 });
    const walk = d => {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (/\.(xlsx|csv|jsonl)$/i.test(f)) files.push(p);
      }
    };
    walk(destDir);
  } else {
    files.push(zipPath);
  }
  log(`解包：${files.length} 个数据文件`);
  return files;
}
