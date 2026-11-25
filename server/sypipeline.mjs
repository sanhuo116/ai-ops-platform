// sypipeline.mjs —— 私有化任务编排（siyouhua-xunjianyouhua 6 阶段）
// ① 通话记录导入（zip/xlsx/jsonl → calls.jsonl） ② 话术包导出（CDP planet） ③ 引擎构建
// ④ 全量巡检 ⑤ badcase 正则优化三轮回归 ⑥ 四件套交付
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseLeadXlsxToJsonl, extractCallsZip } from './sycalls.mjs';
import { exportBotBundle, buildFlowTree } from './sybundle.mjs';
import { auditFull } from './syaudit.mjs';
import { clusterProblems, designCandidates, regression } from './syfix.mjs';
import { buildDeliverables } from './sydeliver.mjs';
import { updateSyTask, getSyTask } from './store.mjs';

const STAGES = [
  ['import', '通话记录导入', 5],
  ['bundle', '话术包导出', 20],
  ['engine', '引擎构建', 32],
  ['audit', '全量巡检', 55],
  ['fix', '正则优化回归', 85],
  ['deliver', '四件套交付', 96],
];

export async function runSyTask(taskId, task, io) {
  const log = m => { console.log(`[sy ${taskId}]`, m); try { appendLog(taskId, m); } catch { } };
  const dir = path.join(process.cwd(), 'data', 'sy-tasks', taskId);
  const setStage = (key, detail, progress) => {
    const st = STAGES.find(s => s[0] === key);
    updateSyTask(taskId, { stage: key, stage_detail: detail || st[1], progress: progress ?? st[2], status: 'running' });
  };

  try {
    // ---------- ① 通话记录导入 ----------
    setStage('import', '解包与解析通话记录…', 3);
    const callsJsonl = path.join(dir, 'calls.jsonl');
    // 任务目录里的 raw_upload*（上传路由只落盘原始文件，解析在这里进行——全程日志可见）
    const rawFile = fs.readdirSync(dir).find(f => f.startsWith('raw_upload'));
    if (!fs.existsSync(callsJsonl) && rawFile) {
      const raw = path.join(dir, rawFile);
      const ext = path.extname(raw).toLowerCase();
      const { parseLeadXlsxToJsonl, extractCallsZip } = await import('./sycalls.mjs');
      const { parseCallFile } = await import('./callfile.mjs');
      const appendCall = obj => fs.appendFileSync(callsJsonl, JSON.stringify(obj) + '\n');
      if (ext === '.zip') {
        const exDir = path.join(dir, 'extract');
        const files = extractCallsZip(raw, exDir, log);
        for (const f of files) {
          log(`解析 ${path.basename(f)}`);
          if (/\.jsonl$/i.test(f)) {
            const rli = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
            for await (const l of rli) {
              if (!l.trim()) continue;
              try {
                const d = JSON.parse(l);
                if (Array.isArray(d.turns)) appendCall({ id: String(d.id), tpl: d.tpl || '', turns: d.turns });
                else if (d.text) appendCall({ id: String(d.id), tpl: d.tpl || '', turns: [{ role: d.role === 'AI' ? 'AI' : 'ME', text: d.text || '' }] });
              } catch { }
            }
          } else if (/\.(xlsx|xls)$/i.test(f)) {
            // 每个 xlsx 独立 part（parseLeadXlsxToJsonl 以 'w' 截断打开，多文件避免互相覆盖）
            const pi = files.indexOf(f);
            const part = path.join(dir, `.part_${pi}.jsonl`);
            const k = parseLeadXlsxToJsonl(f, part, log);
            fs.appendFileSync(callsJsonl, fs.readFileSync(part, 'utf8'));
            try { fs.unlinkSync(part); } catch { }
            log(`  → ${k} 通`);
          } else {
            const calls = parseCallFile(f);
            for (const c of calls) appendCall({ id: String(c.id), tpl: '', turns: c.turns });
            log(`  → ${calls.length} 通`);
          }
        }
        fs.rmSync(exDir, { recursive: true, force: true });
      } else if (/\.(xlsx|xls)$/i.test(ext)) {
        parseLeadXlsxToJsonl(raw, callsJsonl, log);
      } else if (ext === '.jsonl') {
        fs.copyFileSync(raw, callsJsonl);
      } else {
        const calls = parseCallFile(raw);
        for (const c of calls) appendCall({ id: String(c.id), tpl: '', turns: c.turns });
      }
    }
    if (!fs.existsSync(callsJsonl) || !fs.statSync(callsJsonl).size) throw new Error('通话记录为空：请先上传 zip/xlsx/jsonl');
    // 流式数行（大文件不阻塞）
    const countLines = src => new Promise((res, rej) => {
      let n = 0; const rli = readline.createInterface({ input: fs.createReadStream(src), crlfDelay: Infinity });
      rli.on('line', () => { n++; });
      rli.on('close', () => res(n));
      rli.on('error', rej);
    });
    const callCount = await countLines(callsJsonl);
    log(`通话记录就绪：${callCount} 通`);
    updateSyTask(taskId, { call_count: callCount });

    // ---------- ② 话术包导出 ----------
    setStage('bundle', 'CDP 连接 planet 页签…', 8);
    const taskFull = { ...task, params: (() => { try { return JSON.parse(task.params || '{}'); } catch { return {}; } })() };
    const bundleInfo = await exportBotBundle(taskId, taskFull, log);

    // ---------- ③ 引擎构建 ----------
    setStage('engine', '解析决策树 → 引擎构建…', 30);
    const flowTree = await buildFlowTree(taskId, task.bot_id, log);
    if (!flowTree.bots[task.bot_id]?.length) throw new Error('引擎为空：话术树解析失败（检查 bot 是否为规则版话术）');

    // ---------- ④ 全量巡检 ----------
    setStage('audit', '全量巡检执行中…', 36);
    // bot 归属：模板名 → 优先从 flow_tree 的 bots 匹配（单 bot 任务直接归该 bot）
    // 流式读取（readline），大文件不阻塞事件循环
    const assign = new Map();
    const botIds = Object.keys(flowTree.bots);
    const tplFile = path.join(dir, 'tpl_map.json');
    let tplMap = {};
    if (fs.existsSync(tplFile)) tplMap = JSON.parse(fs.readFileSync(tplFile, 'utf8'));
    const rlAssign = readline.createInterface({ input: fs.createReadStream(callsJsonl), crlfDelay: Infinity });
    for await (const l of rlAssign) {
      if (!l.trim()) continue;
      let d; try { d = JSON.parse(l); } catch { continue; }
      let bid = tplMap[d.tpl || ''];
      if (!bid && botIds.length === 1) bid = botIds[0];
      if (!bid) {
        // 模板名含 bot 名称关键词兜底
        bid = botIds.find(b => (d.tpl || '').includes(flowTree.botNames?.[b]?.slice(0, 6) || '')) || botIds[0];
      }
      assign.set(String(d.id), bid);
    }
    let lastP = 0;
    const result = await auditFull(dir, flowTree, assign, (done, st) => {
      const p = 36 + Math.min(18, Math.round(18 * done / Math.max(1, st.calls + 1)));
      if (p !== lastP) { lastP = p; setStage('audit', `巡检中 ${done}/${st.calls} 通`, p); }
    });
    fs.writeFileSync(path.join(dir, 'full_stat.json'), JSON.stringify(result.stat, null, 1));
    fs.writeFileSync(path.join(dir, 'full_problems.json'), JSON.stringify(result.problems));
    fs.writeFileSync(path.join(dir, 'full_gaps.json'), JSON.stringify(result.gaps));
    fs.writeFileSync(path.join(dir, 'full_pos.json'), JSON.stringify(result.posSamples));
    log(`巡检完成：${result.stat.judged} 段可判定，正确率 ${(100 * (result.stat.ok + result.stat.okDefault + result.stat.okSemantic + result.stat.okInternalSeq) / Math.max(1, result.stat.judged)).toFixed(1)}%，问题 ${result.problems.length}，可补 ${result.gaps.length}`);

    // ---------- ⑤ 正则优化（聚类→候选→三轮回归） ----------
    setStage('fix', 'badcase 聚类与候选式设计…', 60);
    const clusters = clusterProblems(result.problems, result.gaps);
    log(`聚类：${clusters.length} 簇（top1 ${clusters[0]?.kind} ${clusters[0]?.n} 次）`);
    const cands = [];
    for (const c of clusters.slice(0, 80)) {
      const cs = designCandidates(c, flowTree.lib, flowTree.bots[c.bot]);
      for (const cd of cs) {
        // remove 类无 pat 可回归，直接带元信息进报告
        if (cd.kind === 'remove') { cands.push({ ...cd, bot: c.bot, node: c.node, path: c.path, branch: (c.hitRes?.[0] || '').split('[')[0] || '', clusterKind: c.kind, clusterN: c.n, keep: false }); continue; }
        cands.push({ ...cd, bot: c.bot, node: c.node, path: c.path, branch: c.kind.startsWith('分支命中') ? ((c.hitRes?.[0] || '').split('[')[0] || '否定') : (c.kind.startsWith('分支走默认') || c.kind === '可补样本(未命中)' ? '默认' : '否定'), clusterKind: c.kind, clusterN: c.n });
      }
    }
    setStage('fix', `回归验证 ${cands.length} 条候选式…`, 66);
    // 去重：同一 (bot,node,path,pat) 只保留权重最高的一条（同一肇事正则可能被多簇/多分支命中）
    {
      const seen = new Map();
      const dedupCands = [];
      for (const c of cands) {
        const k = `${c.bot}|${c.node}|${c.path}|${c.pat}`;
        const prev = seen.get(k);
        if (!prev || (c.weight || 0) > (prev.weight || 0)) {
          if (prev) dedupCands.splice(dedupCands.indexOf(prev), 1);
          seen.set(k, c);
          dedupCands.push(c);
        }
      }
      cands.length = 0;
      cands.push(...dedupCands);
    }
    const regressable = cands.filter(c => c.kind !== 'remove');
    const reported = regressable.length ? regression(regressable, flowTree, result.posSamples, result.problems, result.gaps) : [];
    // remove 候选直接附上回归占位（标记为需人工确认）
    const fixReport = [...reported, ...cands.filter(c => c.kind === 'remove')];
    const keptN = fixReport.filter(f => f.keep).length;
    fs.writeFileSync(path.join(dir, 'fix_report.json'), JSON.stringify(fixReport));
    log(`回归完成：采纳 ${keptN}/${fixReport.length}（误翻=0 一票否决）`);

    // ---------- ⑥ 四件套交付 ----------
    setStage('deliver', '生成四件套…', 92);
    const sceneNames = { [task.bot_id]: bundleInfo.sceneName };
    const del = buildDeliverables(taskId, task, { stat: result.stat, clusters, fixReport, flowTree, sceneNames }, log);
    updateSyTask(taskId, {
      status: 'done', stage: 'deliver', stage_detail: '完成', progress: 100,
      result: JSON.stringify({
        stat: result.stat,
        deliverables: del.files,
        keptChanges: del.kept,
        clusters: clusters.length,
        sceneName: bundleInfo.sceneName,
        botName: flowTree.botNames?.[task.bot_id] || '',
      }),
    });
    log(`任务完成：采纳 ${del.kept} 条正则改动，四件套就绪`);
  } catch (e) {
    console.error(`[sy ${taskId}] 失败:`, e);
    updateSyTask(taskId, { status: 'failed', error: String(e.message || e).slice(0, 500) });
    try { appendLog(taskId, 'FAILED: ' + String(e.message || e)); } catch { }
  }
}

function appendLog(taskId, msg) {
  const dir = path.join(process.cwd(), 'data', 'sy-tasks', taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'run.log'), `[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}
