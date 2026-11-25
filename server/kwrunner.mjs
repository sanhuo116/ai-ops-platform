// kwrunner.mjs —— 批量执行器：顺序跑 kw_tasks 队列（batch 或 single 模式），写回进度
// 【铁律】失败绝不终态：未收敛/异常 → 无限自动重试（策略递进 + 退避），直到验证全过才交付
import { getKwTask, updateKwTask, getKwBatch, updateKwBatch, listKwTasks } from './store.mjs';
import { generateOne, adaptToUserLists } from './gen.mjs';

const state = { running: false };   // 全局串行：同一时刻只跑一个任务（LLM 网关并发限制）

export function runnerBusy() { return state.running; }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const queueWait = async () => { while (state.running) await sleep(400); };

// 全量生成：无限重试直到收敛。retryHint 递进（温度 0.4→0.9、修复轮 4→12），退避封顶 20s
async function runForever(id) {
  const t0 = getKwTask(id);
  if (!t0 || t0.status === 'done') return;
  const log = m => console.log(`[kw ${id}] ${m}`);
  updateKwTask(id, { status: 'running', error: '' });
  const prev = t0.result || {};
  let attempt = prev.attempts || 0;
  let lastErr = prev.lastDiagnosis || '';
  while (true) {
    attempt++;
    if (attempt > 1) {
      log(`第 ${attempt} 次尝试（上次：${lastErr.slice(0, 50)}）`);
      await sleep(Math.min(5000 + attempt * 2000, 20000));
    }
    try {
      const r = await generateOne(t0.question, { log, retryHint: Math.min(attempt, 5) });
      if (r.verified.ok) {
        updateKwTask(id, {
          status: 'done', error: '',
          result: {
            intent: r.intent, notes: r.notes || '', regex: r.regex,
            general: r.general, negatives: r.negatives,
            verified: r.verified, rounds: r.rounds, source: r.source,
            passed: true, elapsedMs: r.elapsedMs,
            attempts: attempt, lastDiagnosis: attempt > 1 ? lastErr : '',
          },
        });
        log(`完成（第 ${attempt} 次）：验证全通过（泛化${r.general.length}/规避${r.negatives.length}）`);
        return;
      }
      const miss = r.verified.general.filter(x => !x.hit);
      const fh = r.verified.negatives.filter(x => x.hit);
      lastErr = `泛化未中 ${miss.length}（${miss.slice(0, 2).map(x => x.text).join('、')}），规避误中 ${fh.length}（${fh.slice(0, 2).map(x => x.text).join('、')}）`;
      // 中间结果保留（可编辑），状态保持 running —— 不是终态
      updateKwTask(id, {
        status: 'running',
        error: `第 ${attempt} 次未收敛，自动重试中：${lastErr}`,
        result: {
          intent: r.intent, notes: r.notes || '', regex: r.regex,
          general: r.general, negatives: r.negatives,
          verified: r.verified, rounds: r.rounds, source: r.source,
          passed: false, elapsedMs: r.elapsedMs, attempts: attempt, lastDiagnosis: lastErr,
        },
      });
      log(`未收敛，继续重试：${lastErr}`);
      // 连续 5 次未收敛：让出队列重新排队（queued，扫描器会再捞起——永不 failed）
      if (attempt % 5 === 0) {
        updateKwTask(id, { status: 'queued', error: `已重试 ${attempt} 次未收敛，排队等待下一轮（系统会持续重试直到成功）` });
        log(`已重试 ${attempt} 次，让出队列重新排队`);
        return 'requeued';
      }
    } catch (e) {
      lastErr = String(e.message || e);
      const cur = getKwTask(id);
      updateKwTask(id, {
        status: 'running',
        error: `第 ${attempt} 次异常，自动重试中：${lastErr}`,
        result: { ...((cur && cur.result) || {}), attempts: attempt },
      });
      log(`异常，继续重试：${lastErr}`);
      if (attempt % 5 === 0) {
        updateKwTask(id, { status: 'queued', error: `已重试 ${attempt} 次异常，排队等待下一轮（系统会持续重试直到成功）` });
        return 'requeued';
      }
    }
  }
}

// 用户编辑列表后的适配重跑：同样无限重试，每轮加大修复轮数上限（6→10→14…）
async function adaptForever(id, general, negatives, prevRegex) {
  const t0 = getKwTask(id);
  if (!t0) return;
  const log = m => console.log(`[kw adapt ${id}] ${m}`);
  updateKwTask(id, { status: 'running', error: '' });
  const prev = t0.result || {};
  let attempt = 0;
  let lastErr = '';
  while (true) {
    attempt++;
    const rounds = 6 + 4 * (attempt - 1);
    if (attempt > 1) {
      log(`第 ${attempt} 次适配（修复轮上限 ${rounds}，上次：${lastErr.slice(0, 50)}）`);
      await sleep(3000);
    }
    try {
      const r = await adaptToUserLists(t0.question, general, negatives, { prevRegex, rounds, log });
      if (r.ok) {
        updateKwTask(id, {
          status: 'done', error: '',
          result: {
            ...prev, regex: r.regex, general, negatives,
            verified: r.verified, rounds: r.rounds, source: 'manual+engine',
            passed: true, elapsedMs: r.elapsedMs, attempts: attempt,
            lastDiagnosis: attempt > 1 ? lastErr : '',
          },
        });
        log(`适配成功（第 ${attempt} 次，修复${r.rounds}轮，${r.elapsedMs}ms）`);
        return;
      }
      lastErr = r.reason;
      updateKwTask(id, {
        status: 'running',
        error: `第 ${attempt} 次适配未收敛，自动加大修复轮数重试：${r.reason}`,
        result: {
          ...prev, regex: r.regex, general, negatives,
          verified: r.verified, rounds: r.rounds, source: 'manual+engine',
          passed: false, elapsedMs: r.elapsedMs, attempts: attempt, lastDiagnosis: r.reason,
          pendingAdapt: { general, negatives, prevRegex },
        },
      });
      // 连续 5 次：让出队列，扫描器带着 pendingAdapt 续跑（永不 failed）
      if (attempt % 5 === 0) {
        updateKwTask(id, { status: 'queued', error: `适配已重试 ${attempt} 次，排队等待下一轮（系统会持续重试直到成功）` });
        return 'requeued';
      }
    } catch (e) {
      lastErr = String(e.message || e);
      updateKwTask(id, {
        status: 'running',
        error: `第 ${attempt} 次适配异常，自动重试：${lastErr}`,
        result: { ...prev, attempts: attempt },
      });
      log(`适配异常，继续重试：${lastErr}`);
    }
  }
}

export async function enqueue(id) {
  await queueWait();
  state.running = true;
  try {
    await runForever(id);
  } finally {
    state.running = false;
  }
  const t = getKwTask(id);
  if (t && t.batch_id) refreshBatch(t.batch_id);
}

// 编辑后重跑（用户列表适配）：走同一串行队列
export async function enqueueAdapt(id, general, negatives, prevRegex) {
  await queueWait();
  state.running = true;
  try {
    await adaptForever(id, general, negatives, prevRegex);
  } finally {
    state.running = false;
  }
  const t = getKwTask(id);
  if (t && t.batch_id) refreshBatch(t.batch_id);
}

// 启动恢复：failed/queued 全部重新入队（后台异步）；返回入队数
export function resumeAll() {
  const rows = listKwTasks({ limit: 5000 }).filter(x => x.status !== 'done' && x.status !== 'running');
  if (!rows.length) { startSweeper(); return 0; }
  setTimeout(async () => {
    for (const row of rows) {
      try { await enqueueOrAdapt(row); } catch (e) { console.error('[kw resume]', row.id, e); }
    }
  }, 200);
  startSweeper();
  return rows.length;
}

// 按任务当前数据选择执行方式：带 pendingAdapt（用户编辑过的列表）走适配，否则全量生成
async function enqueueOrAdapt(row) {
  const pend = ((row.result || {}).pendingAdapt) || null;
  if (pend && pend.general && pend.negatives) {
    await enqueueAdapt(row.id, pend.general, pend.negatives, pend.prevRegex || '');
  } else {
    await enqueue(row.id);
  }
}

// 周期扫描器（60s）：兜底复活一切非 done 任务——failed 残留、queued 卡住、服务重启丢失的 running
function startSweeper() {
  setInterval(async () => {
    try {
      if (state.running) return;
      const rows = listKwTasks({ limit: 5000 }).filter(x => x.status !== 'done');
      if (!rows.length) return;
      for (const row of rows) {
        if (row.status === 'running') continue;   // 正在跑的等下轮
        try { await enqueueOrAdapt(row); } catch (e) { console.error('[kw sweep]', row.id, e); }
      }
    } catch (e) { console.error('[kw sweeper]', e); }
  }, 60000);
}

// 兼容保留：把非 done 的任务重新入队（启动恢复/手动触发用）
export async function retryBatchFailed(batchId) {
  const rows = listKwTasks({ batchId }).filter(x => x.status !== 'done' && x.status !== 'running');
  for (const row of rows) {
    await enqueue(row.id);
  }
  return rows.length;
}

function refreshBatch(batchId) {
  const b = getKwBatch(batchId);
  if (!b) return;
  const rows = listKwTasks({ batchId });
  const done = rows.filter(r2 => r2.status === 'done').length;
  const retrying = rows.filter(r2 => r2.status !== 'done').length;   // 未完成 = 重试中（永不 failed 终态）
  updateKwBatch(batchId, { done, failed: retrying, status: done >= rows.length ? 'done' : 'running' });
}
