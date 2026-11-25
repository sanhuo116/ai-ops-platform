// sydeliver.mjs —— 私有化任务四件套交付（siyouhua-xunjianyouhua 阶段⑥）
// ① 全量巡检问题表 xlsx（5 sheet：分支命中错误/分支走默认未命中/可补样本/优化方案汇总/巡检总览）
// ② 正则改动汇总（分bot）xlsx（3 sheet：改动总览/每bot明细/验证口径）
// ③ 巡检报告 md  ④ 修改明细 md
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PY = process.env.DSH_PYTHON
  || path.join(process.env.HOME || '', '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3');

function buildXlsx(spec, outPath) {
  // spec: {sheets:[{name, headers:[...], widths:[...], rows:[[...]]}]}
  const script = `
import json, sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
spec = json.load(open(sys.argv[1]))
wb = Workbook()
thin = Side(style='thin', color='CCCCCC')
border = Border(left=thin, right=thin, top=thin, bottom=thin)
hdr_fill = PatternFill('solid', fgColor='1F4E79')
hdr_font = Font(bold=True, color='FFFFFF', size=11)
wrap = Alignment(wrap_text=True, vertical='top')
first = True
for sh in spec['sheets']:
    ws = wb.active if first else wb.create_sheet()
    first = False
    ws.title = sh['name'][:31]
    ws.append(sh['headers'])
    for i, h in enumerate(sh['headers'], 1):
        c = ws.cell(1, i); c.value = h; c.font = hdr_font; c.fill = hdr_fill; c.alignment = wrap; c.border = border
    for i, w in enumerate(sh.get('widths') or [], 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    for row in sh['rows']:
        ws.append([('' if v is None else str(v)) for v in row])
    for r in ws.iter_rows(min_row=2):
        for c in r: c.alignment = wrap; c.border = border
    ws.freeze_panes = 'A2'
wb.save(sys.argv[2])
print('OK')
`;
  const tmp = path.join(path.dirname(outPath), `.sy_spec_${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(spec));
  const r = spawnSync(PY, ['-c', script, tmp, outPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try { fs.unlinkSync(tmp); } catch { }
  if (r.status !== 0 || !/OK/.test(r.stdout || '')) throw new Error(`xlsx 生成失败：${((r.stderr || '') + (r.stdout || '')).slice(-300)}`);
}

const escMd = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 220);

export function buildDeliverables(taskId, task, ctx, log) {
  const dir = path.join(process.cwd(), 'data', 'sy-tasks', taskId);
  const outDir = path.join(dir, 'deliverables');
  fs.mkdirSync(outDir, { recursive: true });
  const { stat, clusters, fixReport, flowTree, sceneNames } = ctx;
  const botNames = flowTree.botNames || {};
  const botLabel = bid => (botNames[bid] ? `${botNames[bid]} (${bid})` : bid);

  // ---------- ① 全量巡检问题表 ----------
  const mkRow = (r, i, extra) => [i + 1, botLabel(r.bot), r.node, (r.path || '(root)').slice(0, 40), ...extra];
  const sheetWrong = {
    name: '分支命中错误',
    headers: ['序号', 'bot/话术', '节点', '分支路径', '有问题的用户问句(合并样例)', '出现次数', '当前错误命中的正则', 'AI实际去向', '期望去向', '优化建议', '样例通话ID'],
    widths: [6, 24, 16, 16, 40, 9, 40, 14, 14, 36, 14],
    rows: [],
  };
  const sheetDefault = {
    name: '分支走默认未命中',
    headers: ['序号', 'bot/话术', '节点', '分支路径', '用户问句(合并样例)', '出现次数', '期望(默认)', 'AI实际去向', '问题分析', '建议', '样例通话ID'],
    widths: [6, 24, 16, 16, 40, 9, 16, 14, 34, 30, 14],
    rows: [],
  };
  const sheetGap = {
    name: '可补样本(未命中)',
    headers: ['序号', 'bot/话术', '节点', '分支路径', '未命中的用户问句(合并样例)', '出现次数', '默认去向', 'AI实际去向', '建议', '样例通话ID'],
    widths: [6, 24, 16, 16, 40, 9, 14, 14, 34, 14],
    rows: [],
  };
  const fixByKey = new Map();
  for (const f of fixReport) {
    const k = `${f.bot}|${f.node}|${f.path}|${f.clusterKind}`;
    if (!fixByKey.has(k)) fixByKey.set(k, []);
    fixByKey.get(k).push(f);
  }
  const fmtReg = f => `${f.keep ? '✔采纳' : '✘否决'} ${f.kind}: ${(f.dialect || f.pat || '').slice(0, 120)}（误翻${f.posBad ?? '—'}/修复${f.negFix ?? '—'}/破坏${f.negBreak ?? '—'}/增益${f.gapGain ?? '—'}）`;
  let wi = 0, di = 0, gi = 0;
  for (const c of clusters) {
    const texts = [...c.texts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, n]) => `· ${t}（${n}次）`).join('\n');
    const ids = [...c.ids].slice(0, 8).join(',');
    const fkList = fixByKey.get(`${c.bot}|${c.node}|${c.path}|${c.kind}`) || [];
    const sug = fkList.length ? fkList.map(fmtReg).join('\n') : '无安全改式；保持现状+人工质检';
    if (c.kind === '分支命中错误') {
      sheetWrong.rows.push(mkRow(c, wi++, [texts, c.n, (c.hitRes || []).slice(0, 3).map(h => (h.match(/↤(.+?)(?: ┃|$)/) || ['', ''])[1]).join('\n') || '—', c.actual, c.expected, sug, ids]));
    } else if (c.kind.startsWith('分支走默认未命中')) {
      sheetDefault.rows.push(mkRow(c, di++, [texts, c.n, c.expected, c.actual, c.detail || '', sug, ids]));
    } else if (c.kind === '可补样本(未命中)') {
      sheetGap.rows.push(mkRow(c, gi++, [texts, c.n, c.expected, c.actual, sug, ids]));
    }
  }
  const total = stat.judged || 1;
  const overview = {
    name: '巡检总览',
    headers: ['指标', '数值'],
    widths: [30, 26],
    rows: [
      ['通话记录（判定内）', stat.calls],
      ['版本混合剔除', stat.versionMixCalls],
      ['可判定用户段', stat.judged],
      ['走向正确', stat.ok + stat.okDefault + stat.okSemantic + stat.okInternalSeq],
      ['走向正确率', `${((100 * (stat.ok + stat.okDefault + stat.okSemantic + stat.okInternalSeq) / total)).toFixed(1)}%`],
      ['分支命中错误', stat.errWrong],
      ['分支走默认未命中(偏离)', stat.errDefault],
      ['未命中(可补样本)', stat.noBranchHit],
      ['语义路由接管(合法)', stat.okSemantic],
      ['节点内顺序推进(合法)', stat.okInternalSeq],
      ['无判定分支跳过', stat.skipNoJudge],
      ['语气词跳过', stat.fillerSkip],
      ['末轮无法判定', stat.lastTurn],
      ['采纳的正则改动数', fixReport.filter(f => f.keep).length],
      ['否决的候选式数', fixReport.filter(f => !f.keep && f.kind !== 'remove').length],
    ],
  };
  const sheetPlan = {
    name: '优化方案汇总',
    headers: ['序号', 'bot/话术', '节点', '分支路径', '问题类型', '样本量', '候选式(树方言)', '动作', '回归结果', '是否采纳'],
    widths: [6, 22, 16, 16, 18, 9, 44, 10, 30, 10],
    rows: fixReport.map((f, i) => [i + 1, botLabel(f.bot), f.node, (f.path || '(root)').slice(0, 40), f.clusterKind, f.clusterN, f.dialect || f.pat, f.kind, `误翻${f.posBad} 修正${f.posGood} 修复${f.negFix} 破坏${f.negBreak} 增益${f.gapGain}`, f.keep ? '✔采纳' : '✘否决']),
  };
  const ts = new Date().toISOString().slice(0, 10);
  const p1 = path.join(outDir, `私有化巡检_正则优化_全量问题表_${ts}.xlsx`);
  buildXlsx({ sheets: [sheetWrong, sheetDefault, sheetGap, sheetPlan, overview] }, p1);
  log(`交付① 全量巡检问题表：${path.basename(p1)}（错误${sheetWrong.rows.length} / 偏离${sheetDefault.rows.length} / 可补${sheetGap.rows.length}）`);

  // ---------- ② 正则改动汇总（分bot） ----------
  const kept = fixReport.filter(f => f.keep);
  const byBot = new Map();
  for (const f of kept) {
    if (!byBot.has(f.bot)) byBot.set(f.bot, []);
    byBot.get(f.bot).push(f);
  }
  const s1 = {
    name: '改动总览',
    headers: ['bot/话术', '改动数', '替换(modify)', '追加(add)', '默认兜底(add-default)', '移除(remove)'],
    widths: [34, 10, 14, 12, 20, 14],
    rows: [...byBot.entries()].map(([bid, list]) => [botLabel(bid), list.length,
      list.filter(x => x.kind === 'modify').length, list.filter(x => x.kind === 'add').length,
      list.filter(x => x.kind === 'add-default').length, list.filter(x => x.kind === 'remove').length]),
  };
  const s2 = {
    name: '每bot明细',
    headers: ['序号', 'bot/话术', '节点', '分支路径', '问题类型', '分支', '原正则', '新写法(树方言)', '回归效果', '作用域'],
    widths: [6, 26, 16, 16, 18, 10, 40, 44, 28, 20],
    rows: [],
  };
  let si = 0;
  for (const [bid, list] of byBot) {
    for (const f of list) {
      s2.rows.push([++si, botLabel(bid), f.node, (f.path || '(root)').slice(0, 40), f.clusterKind, f.branch || '', f.target || '（新增）', f.dialect || f.pat,
        `误翻${f.posBad} 修正${f.posGood} 修复${f.negFix} 破坏${f.negBreak} 增益${f.gapGain}`, `${f.node} @ ${f.path}`]);
    }
  }
  const s3 = {
    name: '验证口径',
    headers: ['项', '说明'],
    widths: [22, 80],
    rows: [
      ['回归语料', 'pos=抽样正确走向段（保持不破坏）；neg=巡检错误段（统计修复/破坏）；gap=未命中段（统计增益）'],
      ['一票否决', 'pos 误翻转 ≠ 0 直接否决（正确走向段被新式改变走向即破坏）'],
      ['采纳门槛', '误翻=0 且 修复>破坏 且 增益>0'],
      ['树方言', '树内 keyword 禁半角逗号：量词 {0,N}→{0<>N}；字符类内逗号删除；写入后需元素级核验'],
      ['落地方式', '本地包 keyword + answerKeywordDef 双字段同写；平台同步须经明确授权（updateTree 接口）'],
      ['版本口径', '全量通话按节点序列模拟，逐句×分支顺序首中；语义分支跳过正则（语义优先）'],
    ],
  };
  const p2 = path.join(outDir, `正则改动汇总_分bot_${ts}.xlsx`);
  buildXlsx({ sheets: [s1, s2, s3] }, p2);
  log(`交付② 正则改动汇总（分bot）：${path.basename(p2)}（${kept.length} 条采纳改动，${byBot.size} 个 bot）`);

  // ---------- ③ 巡检报告 ----------
  const ov = (v, t) => `${(100 * v / total).toFixed(1)}%`;
  const md3 = [`# 私有化话术包巡检与正则优化报告`, '',
    `> 任务 ${taskId} · bot：${[...byBot.keys()].map(botLabel).join('、') || botLabel(task.bot_id)} · 通话记录 ${stat.calls} 通（版本混合剔除 ${stat.versionMixCalls}） · 生成时间 ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`, '',
    `## 一、巡检结论`, '',
    `| 指标 | 数值 |`, `|---|---|`,
    `| 可判定用户段 | ${stat.judged} |`,
    `| 走向正确率 | ${ov(stat.ok + stat.okDefault + stat.okSemantic + stat.okInternalSeq)}（正确 ${(stat.ok + stat.okDefault + stat.okSemantic + stat.okInternalSeq)}） |`,
    `| 分支命中错误 | ${stat.errWrong}（${ov(stat.errWrong)}） |`,
    `| 分支走默认未命中(偏离) | ${stat.errDefault}（${ov(stat.errDefault)}） |`,
    `| 未命中(可补样本) | ${stat.noBranchHit}（${ov(stat.noBranchHit)}） |`,
    `| 语义路由接管(合法) | ${stat.okSemantic} |`,
    `| 节点内顺序推进(合法) | ${stat.okInternalSeq} |`,
    `| 采纳正则改动 | ${kept.length} 条（覆盖 ${byBot.size} 个 bot） |`, '',
    `## 二、优化方案汇总（采纳）`, '',
    `| # | bot | 节点 | 分支 | 候选式(树方言) | 回归 |`, `|---|---|---|---|---|---|`];
  kept.slice(0, 60).forEach((f, i) => md3.push(`| ${i + 1} | ${botLabel(f.bot)} | ${f.node} | ${f.branch || '—'} | \`${escMd(f.dialect || f.pat)}\` | 误翻${f.posBad}/修复${f.negFix}/破坏${f.negBreak}/增益${f.gapGain} |`));
  md3.push('', `## 三、剩余不可修问题`, '',
    `- 语义接管类偏离：语义分支优先级高于正则，正则修复无效（本次巡检合法接管 ${stat.okSemantic} 段）`,
    `- 多意图复合句（如「有，但是我没理他」）：正则结构性不可修，补式不得抢 leading 肯定`,
    `- acceptBreak=0 节点（用户语音不打断）：正则巡检不适用，已整节点跳过`, '',
    `## 四、修改文件清单`, '',
    ...[...byBot.keys()].map(bid => `- ${botLabel(bid)}：${byBot.get(bid).length} 处（节点 ${[...new Set(byBot.get(bid).map(x => x.node))].join('、')}）`), '',
    `> 落地：本地包双字段同写（keyword + answerKeywordDef）；平台同步需明确授权后执行（updateTree），当前任务仅产出清单未写平台。`);
  const p3 = path.join(outDir, `私有化巡检报告_${ts}.md`);
  fs.writeFileSync(p3, md3.join('\n'));
  log(`交付③ 巡检报告：${path.basename(p3)}`);

  // ---------- ④ 修改明细 ----------
  const md4 = [`# 修改明细`, '',
    `> 任务 ${taskId} · 备份与回滚见文末 · 验证口径：三轮回归（pos误翻=0 / neg修复>破坏 / gap增益>0）`, '',
    `## 一、文件级修改对照`, '',
    `| # | bot | 环境 | 文件(树节点) | 节点/分支 | 动作 | 原正则 → 新写法 |`, `|---|---|---|---|---|---|---|`];
  kept.slice(0, 80).forEach((f, i) => {
    md4.push(`| ${i + 1} | ${f.bot} | dev | trees/*.json（${f.node}） | ${f.branch || '—'} @ ${f.path} | ${f.kind} | \`${escMd(f.target || '（新增）')}\` → \`${escMd(f.dialect || f.pat)}\` |`);
  });
  md4.push('', `## 二、备份体系与回滚路径`, '',
    `- 改动前自动备份：data/sy-tasks/${taskId}/backup_before_optimize/（manifest 记录源文件 + sha1，同 nid 多环境文件名带环境后缀）`,
    `- 回滚：以备份目录覆盖回 bundle 对应文件，重跑 buildFlowTree 即恢复`,
    `- 平台写入（须授权）：GET 备份 → 元素级替换/追加 → POST updateTree → 回读元素级比对（keyword 与 answerKeywordDef 双字段双验）`, '',
    `## 三、验证口径`, '',
    `- 逐句×分支顺序首中模拟，与线上判定一致；语义分支跳过（语义优先）`,
    `- 三语料回归：pos（抽样正确走向段，误翻=0 一票否决）/ neg（错误段：修复 vs 破坏）/ gap（未命中段增益）`,
    `- 作用域实验：同一式在不同节点语义不同，收尾式不得进入确认节点（黔南教训：误翻 19 例）`, '',
    `## 四、平台写入状态`, '',
    `- 本次任务：仅本地清单 + 本地包建议，未调用平台写接口（updateTree 需用户明确授权）`);
  const p4 = path.join(outDir, `修改明细_${ts}.md`);
  fs.writeFileSync(p4, md4.join('\n'));
  log(`交付④ 修改明细：${path.basename(p4)}`);

  return { files: { problems: p1, changes: p2, report: p3, detail: p4 }, kept: kept.length };
}
