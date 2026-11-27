// server/index.js —— 平台 HTTP 服务：API + 静态资源 + 任务队列
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getTask, listTasks, getLib, getLibKeywords, getOptimizations, countOptimizations,
  loadSeedLib, db, createTask,
} from './store.mjs';
import { runTask, listLibForAudit } from './pipeline.mjs';
import { parseCallFile } from './callfile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT || 8787);

// 启动时导入种子库
const seeded = loadSeedLib();
console.log('[seed] 正则库:', seeded.skipped ? `已存在（跳过）` : `已导入 分支${seeded.branches}+问题${seeded.questions}`);

// 启动恢复：存量 failed 全部复活为 queued（失败绝不终态），再统一入队
try {
  
  const n = db.prepare("UPDATE kw_tasks SET status='queued' WHERE status!='done'").run().changes;
  if (n) console.log(`[kw] 启动复活：${n} 个非完成任务（含崩溃残留 running）已转为 queued 重跑`);
} catch (e) { console.error('[kw revive]', e.message); }
const resumed = resumeAll();
if (resumed) console.log(`[kw] 启动恢复：${resumed} 个未完成任务已重新入队`);

// ---------- 简易路由 ----------
const routes = [];
const route = (method, re, fn) => routes.push({ method, re, fn });

route('GET', /^\/api\/tasks$/, () => ok(listTasks().map(t => ({ ...t, optCount: countOptimizations(t.id) }))));

route('GET', /^\/api\/tasks\/([\w-]+)$/, m => {
  const t = getTask(m[1]);
  if (!t) return notFound('任务不存在');
  return ok({ ...t, optCount: countOptimizations(m[1]) });
});

route('POST', /^\/api\/tasks$/, (m, body) => {
  const botId = String(body.botId || '').trim();
  if (!/^\d+$/.test(botId)) return bad('botId 必须是数字');
  const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const callSource = body.callSource === 'upload' ? 'upload' : 'fetch';
  const params = {
    days: Number(body.days) || 30,
    useSeed: !!body.useSeed,
    callSource,
    table: body.table === 'inbound' ? 'inbound' : 'outbound',
    companyId: body.companyId ? String(body.companyId) : '',
    botTenant: body.botTenant ? String(body.botTenant) : '',
    minDuration: body.minDuration ? Number(body.minDuration) : 0,
    bindToken: body.bindToken || '',
    uploadName: body.uploadName || '',
  };
  createTask(id, botId, '', params.companyId, params);
  setTimeout(() => {
    const t = getTask(id);
    runTask(id, t, { log: m => console.log(`[task ${id}]`, m) }).catch(() => { });
  }, 50);
  return ok({ id }, 201);
});

// ---------- 通话记录上传（取数之外的另一种来源，二选一） ----------
// multipart/form-data: file + botId（可选 companyId/table 用于展示）
// 解析 xlsx/csv/jsonl → 统一 calls.jsonl 暂存 uploads/<id>.jsonl，随后 POST /api/tasks 带 uploadId 关联
const UPLOADS = path.join(__dirname, '..', 'data', 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

function parseMultipart(req, boundary) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  }).then(buf => {
    const parts = [];
    const delim = Buffer.from(`--${boundary}`);
    let pos = buf.indexOf(delim);
    while (pos !== -1) {
      const next = buf.indexOf(delim, pos + delim.length);
      if (next === -1) break;
      parts.push(buf.slice(pos + delim.length, next));
      pos = next;
    }
    const fields = {}; let file = null;
    for (const p of parts) {
      // part = \r\nheaders\r\n\r\ncontent\r\n
      const headEnd = p.indexOf('\r\n\r\n');
      if (headEnd === -1) continue;
      const head = p.slice(0, headEnd).toString('utf8');
      const content = p.slice(headEnd + 4, p.length - 2);   // 去尾部 \r\n
      const nameM = head.match(/name="([^"]+)"/);
      const fileM = head.match(/filename="([^"]*)"/);
      if (fileM && content.length) file = { name: fileM[1] || 'calls.xlsx', content };
      else if (nameM) fields[nameM[1]] = content.toString('utf8');
    }
    return { fields, file };
  });
}

// 多文件版 multipart 解析：同名 files 字段全部保留
function parseMultipartAll(req, boundary) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  }).then(buf => {
    const parts = [];
    const delim = Buffer.from(`--${boundary}`);
    let pos = buf.indexOf(delim);
    while (pos !== -1) {
      const next = buf.indexOf(delim, pos + delim.length);
      if (next === -1) break;
      parts.push(buf.slice(pos + delim.length, next));
      pos = next;
    }
    const fields = {}; const files = [];
    for (const p of parts) {
      const headEnd = p.indexOf('\r\n\r\n');
      if (headEnd === -1) continue;
      const head = p.slice(0, headEnd).toString('utf8');
      const content = p.slice(headEnd + 4, p.length - 2);
      const nameM = head.match(/name="([^"]+)"/);
      const fileM = head.match(/filename="([^"]*)"/);
      if (fileM && content.length) files.push({ name: fileM[1] || 'calls.xlsx', content, field: nameM?.[1] || '' });
      else if (nameM) fields[nameM[1]] = content.toString('utf8');
    }
    return { fields, files };
  });
}

route('POST', /^\/api\/upload-calls$/, async (m, body, q, req, headers) => {
  const ct = headers['content-type'] || '';
  const bm = ct.match(/boundary=([^;]+)/);
  if (!bm) return bad('需要 multipart/form-data');
  const { fields, file } = await parseMultipart(req, bm[1]);
  if (!file) return bad('缺少文件字段 file');
  const ext = path.extname(file.name).toLowerCase();
  if (!['.xlsx', '.xls', '.csv', '.jsonl'].includes(ext)) return bad(`不支持的文件类型 ${ext}（支持 .xlsx/.csv/.jsonl）`);
  const upId = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const tmp = path.join(UPLOADS, `${upId}${ext}`);
  fs.writeFileSync(tmp, file.content);
  let calls;
  try { calls = parseCallFile(tmp); } catch (e) { fs.unlinkSync(tmp); return bad(e.message); }
  if (!calls.length) { fs.unlinkSync(tmp); return bad('未解析出任何通话（检查表头列名：通话ID/内容/角色 等）'); }
  const out = path.join(UPLOADS, `${upId}.jsonl`);
  fs.writeFileSync(out, calls.map(c => JSON.stringify(c)).join('\n') + '\n');
  fs.unlinkSync(tmp);
  const turns = calls.reduce((s, c) => s + c.turns.length, 0);
  return ok({ uploadId: upId, calls: calls.length, turns, name: file.name });
});

// 上传后正式建任务：body.uploadId 指向上传文件，callSource=upload
route('POST', /^\/api\/tasks\/with-upload$/, (m, body) => {
  const botId = String(body.botId || '').trim();
  if (!/^\d+$/.test(botId)) return bad('botId 必须是数字');
  const upId = String(body.uploadId || '');
  const src = path.join(UPLOADS, `${upId}.jsonl`);
  if (!/^u[\w]+$/.test(upId) || !fs.existsSync(src)) return bad('uploadId 无效或已过期，请重新上传');
  const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const params = {
    days: Number(body.days) || 30,
    useSeed: !!body.useSeed,
    callSource: 'upload',
    table: body.table === 'inbound' ? 'inbound' : 'outbound',
    companyId: body.companyId ? String(body.companyId) : '',
    botTenant: body.botTenant ? String(body.botTenant) : '',
    minDuration: 0,
    bindToken: body.bindToken || '',
    uploadId: upId,
    uploadName: body.uploadName || `${upId}.jsonl`,
  };
  createTask(id, botId, '', params.companyId, params);
  // 把上传文件挂到任务目录
  const dir = path.join(__dirname, '..', 'data', 'tasks', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, path.join(dir, 'calls.jsonl'));
  fs.unlinkSync(src);   // 一次性：挂到任务后清理暂存
  setTimeout(() => {
    const t = getTask(id);
    runTask(id, t, { log: m => console.log(`[task ${id}]`, m) }).catch(() => { });
  }, 50);
  return ok({ id }, 201);
});

route('POST', /^\/api\/tasks\/([\w-]+)\/rerun$/, m => {
  const t = getTask(m[1]);
  if (!t) return notFound('任务不存在');
  setTimeout(() => runTask(m[1], t, { log: x => console.log(`[task ${m[1]}]`, x) }).catch(() => { }), 50);
  return ok({ id: m[1], rerun: true });
});

route('GET', /^\/api\/tasks\/([\w-]+)\/optimizations$/, (m, _b, q) => {
  const rows = getOptimizations(m[1], { q: q.get('q') || '', source: q.get('source') || '', limit: Math.min(2000, Number(q.get('limit') || 500)) });
  return ok({ rows, total: countOptimizations(m[1]) });
});

route('GET', /^\/api\/tasks\/([\w-]+)\/report$/, m => {
  const f = path.join(__dirname, '..', 'data', 'tasks', m[1], 'report.json');
  if (!fs.existsSync(f)) return notFound('报告尚未生成');
  return ok(JSON.parse(fs.readFileSync(f, 'utf8')));
});

route('GET', /^\/api\/lib\/(branch|question)$/, (m, _b, q) => {
  const rows = getLib(m[1], { q: q.get('q') || '', limit: Math.min(1000, Number(q.get('limit') || 300)) });
  return ok({ rows, total: db.prepare('SELECT COUNT(*) c FROM regexlib WHERE kind=?').get(m[1]).c });
});

route('GET', /^\/api\/lib\/(branch|question)\/(\d+)$/, m => {
  return ok({ libId: m[2], kind: m[1], keywords: getLibKeywords(Number(m[2]), m[1]) });
});

route('GET', /^\/api\/lib\/stats$/, () => {
  const b = db.prepare("SELECT COUNT(*) groups, (SELECT COUNT(*) FROM regex_kw WHERE kind='branch') kws FROM regexlib WHERE kind='branch'").get();
  const q2 = db.prepare("SELECT COUNT(*) groups, (SELECT COUNT(*) FROM regex_kw WHERE kind='question') kws FROM regexlib WHERE kind='question'").get();
  return ok({ branch: b, question: q2 });
});

route('GET', /^\/api\/audit-libs$/, () => ok(listLibForAudit().map(r => ({ name: r.name, kws: r.kws.length }))));

// ---------- 关键词生成（单句 + 批量） ----------
import { createKwTask, updateKwTask, getKwTask, listKwTasks, deleteKwTask, createKwBatch, getKwBatch, updateKwBatch, listKwBatches } from './store.mjs';
import { enqueue, runnerBusy, retryBatchFailed, enqueueAdapt, resumeAll } from './kwrunner.mjs';
import { exportBatchXlsx } from './kwexport.mjs';
import { verifyRegex, generateOne } from './gen.mjs';
import { parseQuestions } from './qfile.mjs';

const kwId = () => `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// 单句提交
route('POST', /^\/api\/kw\/tasks$/, (m, body) => {
  const q = String(body.question || '').trim();
  if (!q || q.length > 100) return bad('请输入问句（1~100 字）');
  const id = kwId();
  createKwTask(id, { mode: 'single', question: q });
  setTimeout(() => enqueue(id).catch(e => console.error('[kw]', e)), 30);
  return ok({ id }, 201);
});

// 任务库（可按 mode/关键字过滤）
route('GET', /^\/api\/kw\/tasks$/, (m, _b, q) => {
  const rows = listKwTasks({
    mode: q.get('mode') || '', q: q.get('q') || '',
    limit: Math.min(500, Number(q.get('limit') || 200)),
  });
  return ok({ rows, busy: runnerBusy() });
});

// 任务详情
route('GET', /^\/api\/kw\/tasks\/([\w-]+)$/, m => {
  const t = getKwTask(m[1]);
  if (!t) return notFound('任务不存在');
  return ok(t);
});

// 删除任务
route('DELETE', /^\/api\/kw\/tasks\/([\w-]+)$/, m => {
  deleteKwTask(m[1]);
  return ok({ deleted: m[1] });
});

// 重跑：用户在详情页增删改泛化/规避后，带着列表重跑验证；不带列表则全量重新生成
route('POST', /^\/api\/kw\/tasks\/([\w-]+)\/rerun$/, (m, body) => {
  const t = getKwTask(m[1]);
  if (!t) return notFound('任务不存在');
  if (runnerBusy()) return bad('有任务正在执行，请稍后再试');
  const general = Array.isArray(body.general) ? body.general.map(s => String(s).trim()).filter(Boolean) : null;
  const negatives = Array.isArray(body.negatives) ? body.negatives.map(s => String(s).trim()).filter(Boolean) : null;
  if (general && !general.length) return bad('泛化句列表不能为空');
  if (negatives && !negatives.length) return bad('规避案例列表不能为空');
  // 全部走串行队列的无限重试闭环（失败绝不终态，直到验证全过才置 done）
  const prevRegex = String(body.regex ?? (t.result || {}).regex ?? '');
  if (general && negatives) {
    setTimeout(() => { enqueueAdapt(m[1], general, negatives, prevRegex).catch(e => console.error('[kw adapt]', e)); }, 30);
  } else {
    setTimeout(() => { enqueue(m[1]).catch(e => console.error('[kw rerun]', e)); }, 30);
  }
  return ok({ id: m[1], rerun: true });
});

// 批量导入：multipart 文件 或 JSON {questions:[...]}；建批次+子任务并串行执行
route('POST', /^\/api\/kw\/batches$/, async (m, body, q, req, headers) => {
  let questions = [];
  let filename = '';
  const ct = headers['content-type'] || '';
  if (ct.includes('multipart/form-data')) {
    const bm = ct.match(/boundary=([^;]+)/);
    if (!bm) return bad('需要 multipart/form-data');
    const { fields, file } = await parseMultipart(req, bm[1]);
    if (file) {
      filename = file.name;
      const ext = path.extname(file.name).toLowerCase();
      const tmp = path.join(UPLOADS, `kq${Date.now().toString(36)}${ext || '.txt'}`);
      fs.writeFileSync(tmp, file.content);
      try { questions = parseQuestions(tmp); } catch (e) { fs.unlinkSync(tmp); return bad(e.message); }
      fs.unlinkSync(tmp);
    } else if (fields.questions) {
      questions = fields.questions.split(/\n+/).map(s => s.trim()).filter(Boolean);
    }
  } else {
    filename = String(body.filename || '粘贴文本');
    questions = Array.isArray(body.questions) ? body.questions.map(s => String(s).trim()).filter(Boolean) : [];
  }
  questions = [...new Set(questions.filter(q2 => q2 && q2.length <= 100))];
  if (!questions.length) return bad('未解析到有效问句（支持 .txt/.csv/.xlsx/.jsonl 或直接粘贴，每行一条，≤100 字）');
  if (questions.length > 200) questions = questions.slice(0, 200);
  const bid = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  createKwBatch(bid, { name: String(body.name || filename || '批量任务').slice(0, 50), filename, total: questions.length });
  questions.forEach((qq, i) => {
    const id = kwId();
    createKwTask(id, { mode: 'batch', batchId: bid, seq: i + 1, question: qq });
    setTimeout(() => enqueue(id).catch(e => console.error('[kw batch]', e)), 30 + i);
  });
  return ok({ batchId: bid, total: questions.length }, 201);
});

// 批次列表
route('GET', /^\/api\/kw\/batches$/, () => ok({ rows: listKwBatches() }));

// 批次详情（含子任务）
route('GET', /^\/api\/kw\/batches\/([\w-]+)$/, m => {
  const b = getKwBatch(m[1]);
  if (!b) return notFound('批次不存在');
  const rows = listKwTasks({ batchId: m[1], limit: 500 });
  return ok({ ...b, tasks: rows.sort((a, b2) => (a.seq || 0) - (b2.seq || 0)) });
});

// 重试批次中的失败项（未收敛/异常的子任务，换策略重跑直到收敛）
route('POST', /^\/api\/kw\/batches\/([\w-]+)\/retry-failed$/, (m) => {
  const b = getKwBatch(m[1]);
  if (!b) return notFound('批次不存在');
  const failedCount = listKwTasks({ batchId: m[1] }).filter(x => x.status === 'failed').length;
  if (!failedCount) return bad('没有失败项需要重试');
  updateKwBatch(m[1], { status: 'running' });
  setTimeout(() => { retryBatchFailed(m[1]).catch(e => console.error('[kw retry]', e)); }, 30);
  return ok({ retried: failedCount });
});

// 批次结果导出 xlsx（汇总 + 逐条验证明细）
route('GET', /^\/api\/kw\/batches\/([\w-]+)\/export$/, (m, _b, _q, _req, _headers, res) => {
  const b = getKwBatch(m[1]);
  if (!b) return notFound('批次不存在');
  const fname = `关键词批量_${(b.name || m[1]).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)}_${Date.now().toString(36)}.xlsx`;
  const out = path.join(UPLOADS, fname);
  try {
    const info = exportBatchXlsx(m[1], out);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
      'Content-Length': fs.statSync(out).size,
    });
    fs.createReadStream(out).pipe(res);
    // 发送后清理临时文件
    res.on('finish', () => { try { fs.unlinkSync(out); } catch { } });
  } catch (e) {
    json(res, 400, { error: String(e.message || e) });
  }
});

// ============ 巡检报告中心（政企部AI运营中心迁移） ============
import { createRequest, updateRequest, getRequest, listRequests, countByStatus } from './xjstore.mjs';
import { runRequest, retryRequest, ensureDirs as ensureXjDirs, XJ_DATA_DIR, TEMPLATE_EXEC } from './xjrunner.mjs';

const XJ_UPLOAD_DIR = path.join(__dirname, '..', 'data', 'xj-uploads');
fs.mkdirSync(XJ_UPLOAD_DIR, { recursive: true });
ensureXjDirs();

// 启动时把崩溃残留的 processing 请求标记为 failed（可 retry 重跑）
try {
  const n = db.prepare("UPDATE xj_requests SET status='failed', error='服务重启中断，请重新生成' WHERE status='processing'").run().changes;
  if (n) console.log(`[xj] 启动恢复：${n} 个中断请求已标记为 failed`);
} catch (e) { console.error('[xj revive]', e.message); }

// 提交巡检需求：multipart，字段 files（多文件）+ payload（JSON 字符串）
route('POST', /^\/api\/xj\/requests$/, async (m, _b, _q, req, headers) => {
  const ct = headers['content-type'] || '';
  const bm = ct.match(/boundary=([^;]+)/);
  if (!bm) return bad('需要 multipart/form-data');
  const parsed = await parseMultipartAll(req, bm[1]);
  const payload = (() => { try { return JSON.parse(parsed.fields.payload || '{}'); } catch { return {}; } })();

  const tenant = String(payload.tenant || '').trim();
  const templateId = String(payload.templateId || '').trim();
  const def = TEMPLATE_EXEC[templateId];
  if (!tenant) return bad('租户名称必填');
  if (!def) return bad(`未知模板 ${templateId}`);
  if (!payload.periodStart || !payload.periodEnd) return bad('报告周期必填');
  if (!parsed.files.length) return bad('请至少上传一份通话记录');

  const id = `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const dir = path.join(XJ_UPLOAD_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const fileRecords = [];
  for (const f of parsed.files) {
    const ext = path.extname(f.name).toLowerCase();
    if (!['.xlsx', '.xls', '.csv', '.txt', '.zip'].includes(ext)) {
      return bad(`不支持的文件类型 ${f.name}（${ext}）`);
    }
    if (f.content.length > 200 * 1024 * 1024) return bad(`文件过大：${f.name}`);
    const dest = path.join(dir, f.name);
    fs.writeFileSync(dest, f.content);
    fileRecords.push({ name: f.name, size: f.content.length, abs: dest });
  }

  createRequest(id, {
    tenant,
    scenario: payload.scenario || '',
    templateId,
    template: payload.template || def.name || templateId,
    skill: def.skill,
    taskName: payload.taskName || def.taskName || '',
    periodStart: payload.periodStart,
    periodEnd: payload.periodEnd,
    period: '',
    remarks: String(payload.remarks || ''),
    files: JSON.stringify(fileRecords),
  });

  setTimeout(() => runRequest(id, msg => console.log(`[xj ${id}]`, msg)), 60);
  return ok({ id, taskName: payload.taskName || def.taskName }, 201);
});

route('GET', /^\/api\/xj\/requests$/, () => ok({ rows: listRequests(), counts: countByStatus() }));

route('GET', /^\/api\/xj\/requests\/([\w-]+)$/, m => {
  const r = getRequest(m[1]);
  if (!r) return notFound('巡检请求不存在');
  return ok(r);
});

route('POST', /^\/api\/xj\/requests\/([\w-]+)\/retry$/, m => {
  if (!getRequest(m[1])) return notFound('巡检请求不存在');
  retryRequest(m[1]);
  return ok({ id: m[1], retry: true });
});

route('GET', /^\/api\/xj\/requests\/([\w-]+)\/download$/, (m, _b, _q, _req, _headers, res) => {
  const r = getRequest(m[1]);
  if (!r) return notFound('巡检请求不存在');
  if (r.status !== 'success' || !r.report_path) return notFound('报告尚未生成');
  const f = path.join(__dirname, '..', r.report_path);
  if (!fs.existsSync(f)) return notFound('报告文件已丢失，请重新生成');
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(r.report_name + '.docx')}`,
  });
  fs.createReadStream(f).pipe(res);
});

route('GET', /^\/api\/xj\/requests\/([\w-]+)\/log$/, m => {
  const r = getRequest(m[1]);
  if (!r) return notFound('巡检请求不存在');
  return ok({ lines: String(r.executor_log || '').split('\n').filter(Boolean) });
});

route('GET', /^\/api\/xj\/templates$/, () => ok(TEMPLATE_EXEC));

// ============ 私有化规则版话术优化（siyouhua-xunjianyouhua） ============
import { createSyTask, getSyTask, listSyTasks, updateSyTask } from './store.mjs';
import { runSyTask } from './sypipeline.mjs';

const SY_DIR = path.join(__dirname, '..', 'data', 'sy-tasks');
fs.mkdirSync(SY_DIR, { recursive: true });

// 私有化任务通话记录上传：只落盘存原始文件（zip/xlsx/csv/jsonl），解析在任务管线 import 阶段进行
// （大文件解析放请求进程内不可靠且错误不可见；放任务里全程日志可见、失败可重试）
const syUploadJobs = new Map();   // upId → {status:'received', name}
route('POST', /^\/api\/sy\/upload$/, async (m, body, q, req, headers) => {
  const ct = headers['content-type'] || '';
  const bm = ct.match(/boundary=([^;]+)/);
  if (!bm) return bad('需要 multipart/form-data');
  const { fields, file } = await parseMultipart(req, bm[1]);
  if (!file) return bad('缺少文件字段 file');
  const ext = path.extname(file.name).toLowerCase();
  if (!['.zip', '.xlsx', '.xls', '.csv', '.jsonl'].includes(ext)) return bad(`不支持的文件类型 ${ext}（支持 zip/xlsx/csv/jsonl）`);
  const upId = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(path.join(UPLOADS, `${upId}${ext}`), file.content);
  syUploadJobs.set(upId, { status: 'received', calls: 0, error: '', name: file.name });
  return ok({ uploadId: upId, name: file.name });
});

route('GET', /^\/api\/sy\/upload\/([\w-]+)$/, m => {
  const j = syUploadJobs.get(m[1]);
  if (!j) return notFound('上传任务不存在（服务重启后请重新上传）');
  return ok(j);
});

route('POST', /^\/api\/sy\/tasks$/, (m, body) => {
  const botId = String(body.botId || '').trim();
  if (!/^\d+$/.test(botId)) return bad('botId 必须是数字');
  const upId = String(body.uploadId || '').trim();
  if (!/^u[\w-]+$/.test(upId)) return bad('uploadId 无效');
  // 找上传的原始文件（任意扩展名，解析在管线 import 阶段）
  const upFiles = fs.readdirSync(UPLOADS).filter(f => f.startsWith(upId) && !f.endsWith('.jsonl') && !f.includes('_ex'));
  if (!upFiles.length) return bad('上传文件不存在或已过期，请重新上传');
  const upSrc = path.join(UPLOADS, upFiles[0]);
  const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const params = { call_source: 'upload', uploadId: upId, uploadName: body.uploadName || upFiles[0] };
  // 本地夹具模式（验收/离线）：referenceBundle = 已导出话术包 zip 绝对路径，跳过 CDP
  if (body.referenceBundle && typeof body.referenceBundle === 'string') {
    if (!fs.existsSync(body.referenceBundle)) return bad('referenceBundle 文件不存在');
    params.referenceBundle = body.referenceBundle;
  }
  if (body.referenceSides && typeof body.referenceSides === 'string') {
    if (!fs.existsSync(body.referenceSides)) return bad('referenceSides 目录不存在');
    params.referenceSides = body.referenceSides;
  }
  createSyTask(id, botId, params);
  const dir = path.join(SY_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(upSrc, path.join(dir, `raw_upload${path.extname(upSrc)}`));
  syEnqueue(id);
  return ok({ id }, 201);
});

// 私有化任务串行队列：同一时间只跑一个（大文件巡检 CPU 密集，并发会拖垮服务）
const syQueue = [];
let syRunning = false;
function syEnqueue(id) {
  syQueue.push(id);
  syPump();
}
function syPump() {
  if (syRunning || !syQueue.length) return;
  const id = syQueue.shift();
  syRunning = true;
  const t = getSyTask(id);
  if (!t || t.status === 'done' || t.status === 'failed') { syRunning = false; return syPump(); }
  runSyTask(id, t, { log: m => console.log(`[sy ${id}]`, m) })
    .catch(() => { })
    .finally(() => { syRunning = false; syPump(); });
}

// 服务重启后遗留的 running 任务已死：标记 failed（进程内状态无 persist runner）
for (const t of listSyTasks({ limit: 200 })) {
  if (t.status === 'running' || t.status === 'queued') {
    updateSyTask(t.id, { status: 'failed', error: '服务重启导致任务中断，请重新提交', stage_detail: '已中断' });
  }
}

route('GET', /^\/api\/sy\/tasks$/, (m, _b, q) => ok(listSyTasks({ limit: Math.min(200, Number(q.get('limit') || 100)) })));
// 质检问题清单（分页；供「是否回归测试」选择）
route('GET', /^\/api\/sy\/tasks\/([\w-]+)\/problems$/, (m, _b, q) => {
  const dir = path.join(SY_DIR, m[1]);
  const file = path.join(dir, 'full_problems.json');
  if (!fs.existsSync(file)) return notFound('该任务无质检问题数据');
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));
  const kind = (q.get('kind') || '').trim();
  const kw = (q.get('q') || '').trim();
  const page = Math.max(1, Number(q.get('page') || 1));
  const size = Math.min(100, Number(q.get('size') || 20));
  let rows = all;
  if (kind) rows = rows.filter(p => p.kind === kind);
  if (kw) rows = rows.filter(p => JSON.stringify({ n: p.node, t: p.text, e: p.expected, a: p.actual }).includes(kw));
  const total = rows.length;
  const slice = rows.slice((page - 1) * size, page * size).map(p => ({
    id: p.id, bot: p.bot, kind: p.kind, node: p.node, path: p.path,
    text: String(p.text || '').slice(0, 200), expected: p.expected, actual: p.actual,
    detail: p.detail, hitRe: String(p.hitRe || '').slice(0, 160),
  }));
  const kinds = {};
  for (const p of all) kinds[p.kind] = (kinds[p.kind] || 0) + 1;
  return ok({ total, page, size, kinds, rows: slice });
});
route('GET', /^\/api\/sy\/tasks\/([\w-]+)$/, m => {
  const t = getSyTask(m[1]);
  if (!t) return notFound('任务不存在');
  let result = null;
  try { result = t.result ? JSON.parse(t.result) : null; } catch { }
  let log = [];
  try {
    const logFile = path.join(SY_DIR, m[1], 'run.log');
    log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-40) : [];
  } catch { }
  return ok({ ...t, result, log });
});

// 交付物下载
route('GET', /^\/api\/sy\/tasks\/([\w-]+)\/deliverables\/([\w.-]+)$/, (m, _b, _q, _req, _headers, res) => {
  const t = getSyTask(m[1]);
  if (!t) return notFound('任务不存在');
  let result = null;
  try { result = t.result ? JSON.parse(t.result) : null; } catch { }
  const file = result?.deliverables?.[m[2]];
  if (!file || !fs.existsSync(file)) return notFound('交付物尚未生成');
  const fname = path.basename(file);
  const ctype = fname.endsWith('.xlsx')
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : fname.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': ctype,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
  });
  fs.createReadStream(file).pipe(res);
});



route('GET', /^\/api\/health$/, () => ok({ ok: true, time: new Date().toISOString() }));

// ============ Agent质检（zhijian-all） ============
import { createZjTask, getZjTask, listZjTasks, updateZjTask } from './zjstore.mjs';
import { runZjTask, zjTaskDir, ZJ_TASK_DIR } from './zjpipeline.mjs';
import { loadZjConfig } from './zjnotify.mjs';

fs.mkdirSync(ZJ_TASK_DIR, { recursive: true });

// 通用质检规则清单（zhijian-all 通用 10 条，提交页展示；每单默认全量写入）
const ZJ_GENERIC_RULES = [
  ['R01', 'AI沉默不回复', '红线', '空回复/提问后中断（转写缺失放行）'],
  ['R02', '输出内部流程或依据', '红线', '向用户说出"根据知识库/大模型"等内部用语'],
  ['R03', '口吻不符客服', '红线', '嘲讽、争吵等不符合客服口吻的表达'],
  ['R04', '超出知识范围联想生成', '红线', '金额/事实无依据且未兜底（用户自述数字放行）'],
  ['R07', '虚假处置或结果承诺', '扣分', '"保证/一定能"类承诺（否定语境放行）'],
  ['R08', '给出未授权的联系方式', '红线', '号码不在白名单（第三方机构转述放行）'],
  ['R11', '输出Markdown或内部格式', '红线', '语音场景输出不可朗读的格式符号'],
  ['R12', '无效重复追问', '扣分', '同问题原文重复追问（固定播报放行）'],
  ['R13', '转人工未响应', '扣分', '明说/紧急/投诉诉求无转接（转接或排队播报=成功）'],
  ['R14', '无依据未兜底', '扣分', '过短回复且无事实/反问兜底（具体事实放行）'],
];

route('GET', /^\/api\/zj\/rules$/, () => ok({
  generic: ZJ_GENERIC_RULES.map(([id, name, level, desc]) => ({ id, name, level, desc })),
  custom: loadZjConfig().customRules || [],
  feishuPush: loadZjConfig().feishuPush !== false,
}));

// 上传通话记录（xlsx/csv/jsonl）：落盘原始文件，解析在任务管线 fetch 阶段
route('POST', /^\/api\/zj\/upload$/, async (m, body, q, req, headers) => {
  const ct = headers['content-type'] || '';
  const bm = ct.match(/boundary=([^;]+)/);
  if (!bm) return bad('需要 multipart/form-data');
  const { file } = await parseMultipart(req, bm[1]);
  if (!file) return bad('缺少文件字段 file');
  const ext = path.extname(file.name).toLowerCase();
  if (!['.xlsx', '.xls', '.csv', '.jsonl'].includes(ext)) return bad(`不支持的文件类型 ${ext}（支持 xlsx/csv/jsonl）`);
  const upId = `zu${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(path.join(UPLOADS, `${upId}${ext}`), file.content);
  // 预解析计数（仅展示用；正式解析在任务管线里，错误可见可重试）
  let calls = 0;
  try { calls = parseCallFile(path.join(UPLOADS, `${upId}${ext}`)).length; } catch { }
  return ok({ uploadId: upId, name: file.name, calls });
});

// 提交质检任务
route('POST', /^\/api\/zj\/tasks$/, async (m, body) => {
  const botId = String(body.botId || '').trim();
  if (!/^\d+$/.test(botId)) return bad('botId 必须是数字');
  // 大模型 Agent 边界门禁：规则版 bot 拦截并引导（质检仅针对大模型 Agent）
  const guard = await checkLlmBot(botId);
  if (!guard.ok) return bad(guard.message);
  const params = {
    botName: String(body.botName || '').trim(),
    tenantName: String(body.tenantName || '').trim(),
    prompt: String(body.prompt || ''),
    kbBase64: body.knowledgeBase ? String(body.knowledgeBase) : '',
    customRules: Array.isArray(body.customRules) ? body.customRules.slice(0, 10) : [],
    days: Number(body.days) || 7,
    table: body.table === 'inbound' ? 'inbound' : 'outbound',
    callSource: body.uploadId ? 'upload' : 'fetch',
  };
  if (params.callSource === 'upload') {
    const upId = String(body.uploadId || '').trim();
    const upFiles = fs.readdirSync(UPLOADS).filter(f => f.startsWith(upId));
    if (!upFiles.length) return bad('上传文件不存在或已过期，请重新上传');
    params.uploadFile = path.join(UPLOADS, upFiles[0]);
    params.uploadName = body.uploadName || upFiles[0];
  } else {
    if (!body.companyId || !/^\d+$/.test(String(body.companyId).trim())) return bad('平台取数需要 companyId（数据租户号）');
    params.companyId = String(body.companyId).trim();
  }
  const id = `z${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  createZjTask(id, botId, params);
  fs.mkdirSync(zjTaskDir(id), { recursive: true });
  zjEnqueue(id);
  return ok({ id }, 201);
});

// 质检任务串行队列（引擎 CPU 密集，同一时间只跑一个）
const zjQueue = [];
let zjRunning = false;
function zjEnqueue(id) { zjQueue.push(id); zjPump(); }
function zjPump() {
  if (zjRunning || !zjQueue.length) return;
  const id = zjQueue.shift();
  zjRunning = true;
  const t = getZjTask(id);
  if (!t || t.status === 'done' || t.status === 'failed') { zjRunning = false; return zjPump(); }
  runZjTask(id, t, { log: m => console.log(m) })
    .catch(() => { })
    .finally(() => { zjRunning = false; zjPump(); });
}

route('GET', /^\/api\/zj\/tasks$/, (m, _b, q) => ok(listZjTasks({ limit: Math.min(200, Number(q.get('limit') || 100)) }).map(t => {
  let result = null;
  try { result = t.result ? JSON.parse(t.result) : null; } catch { }
  return { ...t, result, params: undefined };
})));

route('GET', /^\/api\/zj\/tasks\/([\w-]+)$/, m => {
  const t = getZjTask(m[1]);
  if (!t) return notFound('任务不存在');
  let result = null;
  try { result = t.result ? JSON.parse(t.result) : null; } catch { }
  let log = [];
  try {
    const logFile = path.join(zjTaskDir(m[1]), 'run.log');
    log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-40) : [];
  } catch { }
  return ok({ ...t, result, log });
});

// 质检问题清单（bot 维度聚合，含证据样例）
function collectZjIssuesFallback(reports) {
  const byRule = new Map();
  for (const r of reports) {
    for (const f of [...(r.redline_hits || []), ...(r.deductions || [])]) {
      if (!byRule.has(f.rule_id)) byRule.set(f.rule_id, { rule_id: f.rule_id, rule_name: f.rule_name, level: f.level, calls: 0, callIds: new Set(), samples: [] });
      const g = byRule.get(f.rule_id);
      g.callIds.add(r.call_id); g.calls = g.callIds.size;
      if (g.samples.length < 6) g.samples.push({ call_id: r.call_id, turn: f.turn_idx, evidence: (f.evidence || '').slice(0, 200), detail: (f.detail || '').slice(0, 200) });
    }
  }
  return [...byRule.values()].map(({ callIds, ...rest }) => rest).sort((a, b) => b.calls - a.calls);
}

route('GET', /^\/api\/zj\/tasks\/([\w-]+)\/issues$/, m => {
  const t = getZjTask(m[1]);
  if (!t) return notFound('任务不存在');
  let issues = [];
  let findings = [];   // 全量问题明细（逐通话逐轮，不聚合不截断）
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(zjTaskDir(m[1]), 'issues.json'), 'utf8'));
    issues = Array.isArray(raw) ? raw : (raw.issues || []);
  } catch {
    try {
      const insp = JSON.parse(fs.readFileSync(path.join(zjTaskDir(m[1]), 'inspect.json'), 'utf8'));
      issues = collectZjIssuesFallback(insp.reports);
    } catch { }
  }
  try {
    const insp = JSON.parse(fs.readFileSync(path.join(zjTaskDir(m[1]), 'inspect.json'), 'utf8'));
    for (const r of (insp.reports || [])) {
      for (const f of [...(r.redline_hits || []), ...(r.deductions || [])]) {
        findings.push({
          call_id: r.call_id, verdict: r.verdict, score: r.score,
          rule_id: f.rule_id, rule_name: f.rule_name, level: f.level, severity: f.severity,
          turn: f.turn_idx, evidence: (f.evidence || '').slice(0, 300), detail: (f.detail || '').slice(0, 300),
          suggestion: (f.suggestion || '').slice(0, 200),
        });
      }
    }
  } catch { }
  findings.sort((a, b) => (a.level === '红线' ? 0 : 1) - (b.level === '红线' ? 0 : 1) || String(a.call_id).localeCompare(String(b.call_id)) || (a.turn || 0) - (b.turn || 0));
  return ok({ taskId: m[1], botId: t.bot_id, botName: t.bot_name, issues, findings, total: findings.length });
});

// 按天报告下载
route('GET', /^\/api\/zj\/tasks\/([\w-]+)\/reports\/(\d{4}-\d{2}-\d{2})$/, (m, _b, _q, _req, _headers, res) => {
  const t = getZjTask(m[1]);
  if (!t) return notFound('任务不存在');
  const file = path.join(zjTaskDir(m[1]), `AI质检报告_${m[2]}_${m[1]}.docx`);
  if (!fs.existsSync(file)) return notFound('该日期报告尚未生成');
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
  });
  fs.createReadStream(file).pipe(res);
});

// 服务重启后遗留任务标记失败
for (const t of listZjTasks({ limit: 200 })) {
  if (t.status === 'running' || t.status === 'queued') {
    updateZjTask(t.id, { status: 'failed', error: '服务重启导致任务中断，请重新提交', stage_detail: '已中断' });
  }
}


// ---------- helpers ----------
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const ok = (data, code = 200) => ({ __json: true, code, data });
const bad = msg => ({ __json: true, code: 400, data: { error: msg } });
const notFound = msg => ({ __json: true, code: 404, data: { error: msg } });

// ---------- 静态资源 ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  let f = path.join(DIST, pathname === '/' ? 'index.html' : pathname);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end('dist 未构建：请先运行 npm run build'); }
  const ext = path.extname(f);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const pathname = u.pathname;
  try {
    if (pathname.startsWith('/api/')) {
      const ct = req.headers['content-type'] || '';
      // multipart 上传：body 是二进制，跳过字符串预读，交给 handler 自己消费 req 流
      if (ct.includes('multipart/form-data')) {
        let handled = false;
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = pathname.match(r.re);
          if (m) {
            handled = true;
            const result = await r.fn(m, {}, u.searchParams, req, req.headers, res);
            if (result && result.__json) return json(res, result.code, result.data);
            return;
          }
        }
        if (!handled) return json(res, 404, { error: 'no route' });
      }
      let body = '';
      for await (const ch of req) body += ch;
      let parsed = {};
      if (body && (req.headers['content-type'] || '').includes('json')) { try { parsed = JSON.parse(body); } catch { } }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = pathname.match(r.re);
        if (m) {
          const result = await r.fn(m, parsed, u.searchParams, req, req.headers, res);
          if (result && result.__json) return json(res, result.code, result.data);
          return;
        }
      }
      return json(res, 404, { error: 'no route' });
    }
    serveStatic(req, res, pathname);
  } catch (e) {
    console.error('[api]', e);
    json(res, 500, { error: String(e.message || e) });
  }
});

// ============ 相似问泛化（xiangshiwen-fanhua 平台化） ============
import { createXsTask, updateXsTask, getXsTask, listXsTasks } from './xsstore.mjs';
import { runXsTask, SCENES, XS_UPLOAD_DIR } from './xsrunner.mjs';

const xsId = () => `xs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// 相似问任务串行队列（LLM 分批生成，避免并发限流）
const xsQueue = [];
let xsRunning = false;
function xsEnqueue(id) { xsQueue.push(id); xsPump(); }
function xsPump() {
  if (xsRunning || !xsQueue.length) return;
  const id = xsQueue.shift();
  xsRunning = true;
  const t = getXsTask(id);
  if (!t || t.status === 'done' || t.status === 'failed') { xsRunning = false; return xsPump(); }
  runXsTask(id, t, { log: msg => console.log(`[xs ${id}]`, msg) })
    .catch(() => { })
    .finally(() => { xsRunning = false; xsPump(); });
}
// 服务重启后遗留 running 任务标记失败
for (const t of listXsTasks({ limit: 200 })) {
  if (t.status === 'running' || t.status === 'pending') {
    updateXsTask(t.id, { status: 'failed', error: '服务重启导致任务中断，请重新提交', stage_detail: '已中断' });
  }
}

// 知识库表格上传：解析出 [{title, group, answer}]（列名兼容：标准问/知识库名称/问题、分组、答案/知识库答案）
route('POST', /^\/api\/xs\/upload$/, async (m, body, q, req, headers) => {
  const ct = headers['content-type'] || '';
  const bm = ct.match(/boundary=([^;]+)/);
  if (!bm) return bad('需要 multipart/form-data');
  const { file } = await parseMultipart(req, bm[1]);
  if (!file) return bad('缺少文件字段 file');
  const ext = path.extname(file.name).toLowerCase();
  if (!['.xlsx', '.xls', '.csv', '.txt'].includes(ext)) return bad(`不支持的文件类型 ${ext}（支持 xlsx/csv/txt）`);
  const tmp = path.join(XS_UPLOAD_DIR, `xs${Date.now().toString(36)}${ext}`);
  fs.writeFileSync(tmp, file.content);
  // 用 python 解析表格 → [{title, group, answer}]
  const { spawnSync } = await import('node:child_process');
  const PY = process.env.DSH_PYTHON || path.join(process.env.HOME || '', '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3');
  const py = spawnSync(PY, ['-c', `
import json, sys
rows_raw = None
if sys.argv[1].endswith(('.xlsx', '.xls')):
    from openpyxl import load_workbook
    wb = load_workbook(sys.argv[1], read_only=True, data_only=True)
    ws = wb[wb.sheetnames[0]]
    rows_raw = [['' if c is None else str(c).strip() for c in r] for r in ws.iter_rows(values_only=True)]
else:
    rows_raw = [[c.strip() for c in l.split(',')] for l in open(sys.argv[1], encoding='utf-8', errors='replace').read().splitlines() if l.strip()]
def colfind(names):
    for i, h in enumerate(rows_raw[0] if rows_raw else []):
        for n in names:
            if n in h: return i
    return -1
ti = colfind(['标准问', '知识库名称', '问题', '标题', 'title'])
gi = colfind(['分组', '分类', 'group'])
ai = colfind(['答案', '知识库答案', 'answer'])
if ti < 0: ti = 0
start = 1 if rows_raw and any(rows_raw[0]) else 0
items, seen = [], set()
for r in rows_raw[start:]:
    if len(r) <= ti: continue
    title = r[ti].strip()
    if not title: continue
    # 一格两条问句（换行分隔）拆分
    for t in title.split('\\n'):
        t = t.strip()
        if not t: continue
        key = t
        if key in seen: continue
        seen.add(key)
        items.append({'title': t, 'group': (r[gi] if gi >= 0 and len(r) > gi else '').strip(), 'answer': (r[ai] if ai >= 0 and len(r) > ai else '').strip()})
print(json.dumps(items, ensure_ascii=False))
`, tmp], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  fs.unlinkSync(tmp);
  if (py.status !== 0) return bad(`解析失败：${(py.stderr || py.stdout || '').slice(0, 240)}`);
  let items = [];
  try { items = JSON.parse(py.stdout || '[]'); } catch { return bad('解析输出异常'); }
  if (!items.length) return bad('表格中未解析到知识库条目（需包含 标准问/知识库名称 列）');
  if (items.length > 500) items = items.slice(0, 500);
  return ok({ items, count: items.length, name: file.name });
});

// 场景清单
route('GET', /^\/api\/xs\/scenes$/, () => ok({ scenes: SCENES.map(x => ({ key: x.key, label: x.label, special: x.special || '' })) }));

// 创建相似问任务
route('POST', /^\/api\/xs\/tasks$/, (m, body) => {
  const tenantId = String(body.tenantId || '').trim();
  const botId = String(body.botId || '').trim();
  if (!/^\d+$/.test(botId)) return bad('botId 必须是数字');
  if (!tenantId) return bad('租户 ID 不能为空');
  const scene = SCENES.find(x => x.key === body.scene) ? body.scene : 'other';
  const perKb = Math.max(1, Math.min(50, Number(body.perKb) || 5));
  const kb = Array.isArray(body.kb) ? body.kb.filter(x => x && String(x.title || '').trim()).map(x => ({ title: String(x.title).trim().slice(0, 120), group: String(x.group || '').trim().slice(0, 40), answer: String(x.answer || '').trim().slice(0, 2000) })) : [];
  if (!kb.length) return bad('知识库条目为空，请先上传知识库表格');
  if (kb.length > 500) return bad('知识库条目超过 500 条上限，请拆分提交');
  const needTotal = kb.length * perKb;
  if (needTotal > 4000) return bad(`生成总量 ${needTotal} 条超上限 4000，请降低每条数量或拆分`);
  const id = xsId();
  const sceneMeta = SCENES.find(x => x.key === scene);
  createXsTask(id, { name: String(body.name || '').slice(0, 60) || `相似问-${sceneMeta.label}-${botId}`, tenantId, botId, scene, sceneLabel: sceneMeta.label, perKb, kbCount: kb.length, needTotal, params: { kb } });
  const dir = path.join(DATA_DIR_XS(), String(id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'kb.json'), JSON.stringify(kb));
  xsEnqueue(id);
  return ok({ id }, 201);
});

function DATA_DIR_XS() { return path.join(__dirname, '..', 'data', 'xs-tasks'); }

// 任务清单
route('GET', /^\/api\/xs\/tasks$/, (m, _b, q) => ok({ rows: listXsTasks({ limit: Math.min(200, Number(q.get('limit') || 100)) }) }));

// 任务详情（含预览 items）
route('GET', /^\/api\/xs\/tasks\/([\w-]+)$/, m => {
  const t = getXsTask(m[1]);
  if (!t) return notFound('任务不存在');
  // 预览只回前 50 条 KB 的相似问（完整内容走下载）
  if (t.result?.items?.length > 50) t.result.preview = t.result.items.slice(0, 50);
  return ok(t);
});

// 下载交付物（xlsx / tpl / txt）
route('GET', /^\/api\/xs\/tasks\/([\w-]+)\/download\/(xlsx|tpl|txt)$/, (m, _b, _q, _req, _headers, res) => {
  const t = getXsTask(m[1]);
  if (!t) return notFound('任务不存在');
  if (t.status !== 'done') return bad('任务尚未完成');
  const key = m[2];
  const files = scanXsFiles(m[1]);
  const map = { xlsx: f => !f.includes('导入模板') && f.endsWith('.xlsx'), tpl: f => f.includes('导入模板'), txt: f => f.endsWith('.txt') };
  const file = files.find(map[key]);
  if (!file) return notFound('交付物不存在');
  const fname = path.basename(file);
  const ctype = fname.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/plain; charset=utf-8';
  res.writeHead(200, { 'Content-Type': ctype, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}` });
  fs.createReadStream(file).pipe(res);
});

function scanXsFiles(id) {
  const dir = path.join(DATA_DIR_XS(), String(id));
  return fs.existsSync(dir) ? fs.readdirSync(dir).map(f => path.join(dir, f)).filter(f => fs.statSync(f).isFile()) : [];
}

// ============ Agent自动优化（voiceagent-evidence-driven-optimizer 平台化） ============
import { createAoTask, updateAoTask, getAoTask, listAoTasks, createAoRegression, updateAoRegression, getAoRegression, listAoRegressions } from './aostore.mjs';
import { runAoTask, runAoRegression, AO_UPLOAD_DIR } from './aorunner.mjs';
import { checkLlmBot, checkLlmBotSync } from './botguard.mjs';

// bot 类型预检（大模型 Agent / 规则版）：供前端提交前引导
route('GET', /^\/api\/bot\/type$/, (m, _b, q) => {
  const g = checkLlmBotSync(q.get('botId') || '');
  if (!g.ok && g.reason === 'rule_bot') return ok({ type: 'rule', name: g.name, message: g.message });
  if (!g.ok && g.reason === 'deleted') return ok({ type: 'deleted', name: g.name, message: g.message });
  if (!g.ok) return bad(g.message);
  return ok({ type: 'llm', name: g.name, flow: g.flow });
});

const aoId = () => `ao${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const aoQueue = [];
let aoRunning = false;
function aoEnqueue(id) { aoQueue.push(id); aoPump(); }
function aoPump() {
  if (aoRunning || !aoQueue.length) return;
  const id = aoQueue.shift();
  aoRunning = true;
  const t = getAoTask(id);
  if (!t || t.status === 'done' || t.status === 'failed') { aoRunning = false; return aoPump(); }
  runAoTask(id, t, { log: m => console.log(`[ao ${id}]`, m) })
    .catch(() => { })
    .finally(() => { aoRunning = false; aoPump(); });
}
const aoRegQueue = [];
let aoRegRunning = false;
function aoRegEnqueue(id) { aoRegQueue.push(id); aoRegPump(); }
function aoRegPump() {
  if (aoRegRunning || !aoRegQueue.length) return;
  const id = aoRegQueue.shift();
  aoRegRunning = true;
  const r = getAoRegression(id);
  if (!r || ['pass', 'fail', 'blocked', 'error'].includes(r.status)) { aoRegRunning = false; return aoRegPump(); }
  runAoRegression(id, { log: m => console.log(`[ao-reg ${id}]`, m) })
    .catch(() => { })
    .finally(() => { aoRegRunning = false; aoRegPump(); });
}
for (const t of listAoTasks({ limit: 200 })) {
  if (t.status === 'running' || t.status === 'pending') updateAoTask(t.id, { status: 'failed', error: '服务重启中断，请重新提交', stage_detail: '已中断' });
}
for (const r of listAoRegressions({ limit: 500 })) {
  if (r.status === 'running' || r.status === 'pending') updateAoRegression(r.id, { status: 'error', error: '服务重启中断，请重新发起', stage_detail: '已中断' });
}

// 需求/知识文档上传（未外呼模式，多份）
route('POST', /^\/api\/ao\/upload$/, async (m, body, q, req, headers) => {
  const ct = headers['content-type'] || '';
  const bm = ct.match(/boundary=([^;]+)/);
  if (!bm) return bad('需要 multipart/form-data');
  const aoPrefix = (q.get('taskId') || '').trim();
  const { file } = await parseMultipart(req, bm[1]);
  if (!file) return bad('缺少文件字段 file');
  const ext = path.extname(file.name).toLowerCase();
  if (!['.xlsx', '.xls', '.csv', '.txt', '.md', '.docx', '.pdf', '.json'].includes(ext)) return bad(`不支持的文件类型 ${ext}`);
  const dir = path.join(AO_UPLOAD_DIR, aoPrefix || 'pending');
  fs.mkdirSync(dir, { recursive: true });
  const stored = `${Date.now().toString(36)}${ext}`;
  fs.writeFileSync(path.join(dir, stored), file.content);
  let brief = '';
  if (['.txt', '.md', '.csv', '.json'].includes(ext)) {
    brief = fs.readFileSync(path.join(dir, stored), 'utf8').slice(0, 4000);
  } else if (['.xlsx', '.xls'].includes(ext)) {
    try {
      const rows = parseKbTableSync(path.join(dir, stored));
      brief = rows.slice(0, 40).map(r => `【${r.title}】${String(r.answer || '').slice(0, 120)}`).join('\n').slice(0, 4000);
    } catch { brief = ''; }
  }
  return ok({ stored, name: file.name, size: file.content.length, brief });
});

function parseKbTableSync(fp) {
  const PYp = process.env.DSH_PYTHON || path.join(process.env.HOME || '', '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3');
  const r = spawnSync(PYp, ['-c', `
import json, sys
rows = None
if sys.argv[1].endswith('.csv'):
    rows = [[c.strip() for c in l.split(',')] for l in open(sys.argv[1], encoding='utf-8', errors='replace').read().splitlines() if l.strip()]
else:
    from openpyxl import load_workbook
    wb = load_workbook(sys.argv[1], read_only=True, data_only=True)
    ws = wb[wb.sheetnames[0]]
    rows = [['' if c is None else str(c).strip() for c in r] for r in ws.iter_rows(values_only=True)]
def colfind(names, default0=False):
    for i, h in enumerate(rows[0] if rows else []):
        for n in names:
            if n in str(h): return i
    return 0 if default0 else -1
ti = colfind(['标准问','知识库名称','问题','标题'], True)
ai = colfind(['答案','知识库答案'])
start = 1 if rows and any(rows[0]) else 0
out = []
for r in rows[start:]:
    if len(r) <= ti or not r[ti]: continue
    out.append({'title': r[ti], 'answer': r[ai] if ai >= 0 and len(r) > ai else ''})
print(json.dumps(out, ensure_ascii=False))
`, fp], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (r.status !== 0) throw new Error((r.stderr || '').slice(0, 200));
  return JSON.parse(r.stdout || '[]');
}

// 创建 Agent 自动优化任务
route('POST', /^\/api\/ao\/tasks$/, async (m, body) => {
  const botId = String(body.botId || '').trim();
  if (!/^\d+$/.test(botId)) return bad('botId 必须是数字');
  // 大模型 Agent 边界门禁：规则版 bot 拦截并引导
  const guard = await checkLlmBot(botId);
  if (!guard.ok) return bad(guard.message);
  const mode = body.mode === 'called' ? 'called' : 'draft';
  const tenantId = String(body.tenantId || '').trim();
  if (mode === 'called' && !tenantId) return bad('已外呼模式需要租户 ID（用于数仓取数）');
  const files = Array.isArray(body.files) ? body.files.slice(0, 10).map(f => ({ stored: String(f.stored || '').slice(0, 80), name: String(f.name || '').slice(0, 100) })) : [];
  if (mode === 'draft' && !files.length) return bad('未外呼模式需要至少上传一份知识库或需求文档');
  const requirementBrief = String(body.requirementBrief || '').slice(0, 8000);
  const qcProblems = Array.isArray(body.qcProblems) ? body.qcProblems.slice(0, 200) : [];
  const id = aoId();
  createAoTask(id, {
    name: String(body.name || '').slice(0, 60) || `Agent优化-${botId}`,
    mode, botId, tenantId,
    params: { files, requirementBrief, qcProblems, mode },
  });
  aoEnqueue(id);
  return ok({ id }, 201);
});

route('GET', /^\/api\/ao\/tasks$/, (m, _b, q) => ok({ rows: listAoTasks({ limit: Math.min(200, Number(q.get('limit') || 100)) }) }));

route('GET', /^\/api\/ao\/tasks\/([\w-]+)$/, m => {
  const t = getAoTask(m[1]);
  if (!t) return notFound('任务不存在');
  return ok(t);
});

// 从质检问题发起回归测试（sy 巡检问题 → ao_regressions）
route('POST', /^\/api\/ao\/regressions$/, async (m, body) => {
  const botId = String(body.botId || '').trim();
  if (!/^\d+$/.test(botId)) return bad('botId 必须是数字');
  // 大模型 Agent 边界门禁：sy 巡检覆盖规则版与大模型 bot，规则版问题不进入回归
  const guard = await checkLlmBot(botId);
  if (!guard.ok) return bad(guard.message);
  const items = Array.isArray(body.problems) ? body.problems.slice(0, 50) : [];
  if (!items.length) return bad('未选择质检问题');
  const created = [];
  for (const p of items) {
    const rid = `rg${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${Math.random().toString(36).slice(2, 4)}`;
    createAoRegression(rid, {
      source: 'sy', sourceTaskId: String(body.sourceTaskId || '').slice(0, 40),
      callId: String(p.id || p.callId || '').slice(0, 40), botId,
      problemKind: String(p.kind || '').slice(0, 40),
      problemBrief: String(p.detail || p.brief || `${p.kind || ''} 节点:${p.node || ''} 期望:${p.expected || ''} 实际:${p.actual || ''}`).slice(0, 800),
      caseJson: p.case || null,
      aoTaskId: String(body.aoTaskId || '').slice(0, 40),
    });
    created.push(rid);
    aoRegEnqueue(rid);
  }
  return ok({ created: created.length, ids: created }, 201);
});

// 回归测试清单（质检回归测试页）
route('GET', /^\/api\/ao\/regressions$/, (m, _b, q) => {
  const taskId = q.get('taskId') || '';
  const status = q.get('status') || '';
  return ok({ rows: listAoRegressions({ taskId: taskId || undefined, status: status || undefined, limit: 300 }) });
});

route('GET', /^\/api\/ao\/regressions\/([\w-]+)$/, m => {
  const r = getAoRegression(m[1]);
  if (!r) return notFound('回归任务不存在');
  return ok(r);
});

// 手动重试
route('POST', /^\/api\/ao\/regressions\/([\w-]+)\/retry$/, m => {
  const r = getAoRegression(m[1]);
  if (!r) return notFound('回归任务不存在');
  // 清理上次冻结/跑测产物（freeze 的 FREEZE_EXISTS 门禁要求目录干净）
  const regDir = path.join(AO_UPLOAD_DIR, '..', 'ao-tasks', `reg-${m[1]}`);
  if (fs.existsSync(regDir)) {
    for (const f of ['frozen-bank.json']) { try { fs.unlinkSync(path.join(regDir, f)); } catch { } }
    try { fs.rmSync(path.join(regDir, 'run'), { recursive: true, force: true }); } catch { }
  }
  updateAoRegression(m[1], { status: 'pending', error: '', stage_detail: '重新排队', progress: 0 });
  aoRegEnqueue(m[1]);
  return ok({ queued: true });
});

server.listen(PORT, () => console.log(`[regex-opt-platform] http://localhost:${PORT}`));
