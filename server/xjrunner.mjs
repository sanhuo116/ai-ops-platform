// xjrunner.mjs —— 巡检报告执行引擎：调用本地已安装的 skill 生成 DOCX
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRequest, updateRequest } from './xjstore.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const XJ_DATA_DIR = path.join(__dirname, '..', 'data', 'xj-reports');
const RUNS_DIR = path.join(XJ_DATA_DIR, 'runs');
const OUT_DIR = path.join(XJ_DATA_DIR, 'output');

export function ensureDirs() {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

// 场景 → 执行器。当前已有真实 skill 的场景走 generate_report.py；
// 暂无 skill 的场景保留扩展点，登记失败原因后置为 failed。
const EXECUTORS = {
  'saas-xunjian-tongyong': {
    kind: 'python',
    script: path.join(process.env.HOME || '', '.codex/skills/saas-xunjian-tongyong/scripts/generate_report.py'),
    titleSuffix: 'AI外呼巡检报告',
  },
};

// 各模板的默认参数（与 codex 版 templateCatalog 对齐）
export const TEMPLATE_EXEC = {
  'saas-general': { skill: 'saas-xunjian-tongyong', taskName: '语音saas巡检' },
  'hangzhou-shebao': { skill: 'hangzhoushebao-report', taskName: '杭州社保巡检' },
  'text-project': { skill: 'chatbot-xjbg', ready: false },
  'yuhang-shebao': { skill: 'yuhangshebao-report', ready: false },
};

function logTail(runDir) {
  try {
    const raw = fs.readFileSync(path.join(runDir, 'runner.log'), 'utf8');
    return raw.split('\n').slice(-40).join('\n');
  } catch { return ''; }
}

/**
 * 单个请求的完整执行流程：
 * 1. 校验文件 → 2. 组装命令 → 3. spawn 生成器 → 4. 校验产物 → 5. 落库
 */
export async function runRequest(id, log = () => { }) {
  const rec = getRequest(id);
  if (!rec) return;
  ensureDirs();
  const runDir = path.join(RUNS_DIR, id);
  fs.mkdirSync(runDir, { recursive: true });
  updateRequest(id, { stage: 'generating' });

  try {
    const exec = TEMPLATE_EXEC[rec.template_id];
    if (!exec || !EXECUTORS[exec.skill]) {
      throw new Error(`模板 ${rec.template_id}（${rec.skill}）尚未接入执行器，暂时无法生成报告`);
    }

    // 收集上传文件（xj_uploads/<id>/ 下）
    const files = JSON.parse(rec.files || '[]');
    if (!files.length) throw new Error('没有可用的通话记录文件');

    const cfg = EXECUTORS[exec.skill];
    const callFile = files[0];
    const outName = `${rec.tenant}巡检报告_${id}.docx`;
    const outPath = path.join(OUT_DIR, outName);

    // 周期按生成器要求的中文名格式拼装（如 2025年1月1日-2025年12月23日）
    const [sy, sm, sd] = String(rec.period_start).split('-');
    const [ey, em, ed] = String(rec.period_end).split('-');
    const periodZh = (sy && ey)
      ? `${sy}年${+sm}月${+sd}日-${ey}年${+em}月${+ed}日`
      : '';
    updateRequest(id, { period: periodZh });

    const args = [
      cfg.script,
      '--calls', callFile.abs,
      '--customer-name', rec.tenant,
      '--output', outPath,
    ];
    if (periodZh) args.push('--period', periodZh);

    const logFd = fs.openSync(path.join(runDir, 'runner.log'), 'a');
    const writeLog = (m) => fs.writeSync(logFd, `${m}\n`);
    writeLog(`[start] ${new Date().toISOString()} template=${rec.template_id} skill=${exec.skill}`);
    writeLog(`[cmd] python3 ${args.join(' ')}`);

    const code = await new Promise((resolve) => {
      const child = spawn('python3', args, { stdio: ['ignore', logFd, logFd] });
      child.on('error', (e) => { writeLog(`[spawn-error] ${e.message}`); resolve(-1); });
      child.on('close', (c) => resolve(c ?? -1));
    });

    writeLog(`[exit] ${code}`);
    fs.closeSync(logFd);

    if (code !== 0 || !fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) {
      throw new Error(`报告生成失败（exit=${code}），详见执行日志`);
    }

    updateRequest(id, {
      status: 'success',
      stage: 'done',
      report_path: path.relative(path.join(__dirname, '..'), outPath),
      report_name: `${rec.tenant}巡检报告`,
      executor_log: logTail(runDir),
    });
    log(`[xj ${id}] 报告生成成功 ${outName}`);
  } catch (e) {
    updateRequest(id, {
      status: 'failed',
      stage: 'done',
      error: e.message,
      executor_log: logTail(runDir),
    });
    log(`[xj ${id}] 失败: ${e.message}`);
  }
}

/** 重新执行失败的请求 */
export function retryRequest(id) {
  const rec = getRequest(id);
  if (!rec) return false;
  updateRequest(id, { status: 'processing', stage: 'queued', error: null });
  setTimeout(() => runRequest(id, m => console.log(`[xj ${id}]`, m)), 50);
  return true;
}
