// store.mjs —— SQLite 存储：任务、正则库、问题库、待优化库
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.join(DATA, 'tasks'), { recursive: true });

export const db = new DatabaseSync(path.join(DATA, 'platform.db'));
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS regexlib (
  id INTEGER NOT NULL,
  kind TEXT NOT NULL,            -- branch | question
  name TEXT NOT NULL,
  label TEXT,
  scenes TEXT,
  status INTEGER,
  kw_count INTEGER,
  gmt_modified TEXT,
  updated_at TEXT,
  PRIMARY KEY (id, kind)
);
CREATE TABLE IF NOT EXISTS regex_kw (
  kw_id INTEGER NOT NULL,
  lib_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (kw_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_kw_lib ON regex_kw(lib_id);
CREATE INDEX IF NOT EXISTS idx_kw_kind ON regex_kw(kind);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  bot_name TEXT,
  company_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued|running|done|failed
  stage TEXT NOT NULL DEFAULT 'pending',   -- pending|export|fetch|audit|optimize|done
  stage_detail TEXT,
  progress INTEGER DEFAULT 0,
  params TEXT,
  error TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS optimizations (
  task_id TEXT NOT NULL,
  seq INTEGER,
  source TEXT,                 -- branch|question
  question TEXT,               -- 问题问句
  branch TEXT,                 -- 所属分支/问题集
  old_regex TEXT,              -- 原正则
  new_regex TEXT,              -- 优化后正则
  action TEXT,                 -- add|remove|modify|keep
  evidence TEXT,               -- 证据（错误问句/通话样本）
  hits INTEGER,                -- 涉及句次
  node TEXT,
  problem_type TEXT,
  PRIMARY KEY (task_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_opt_task ON optimizations(task_id);

CREATE TABLE IF NOT EXISTS kw_tasks (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'single',       -- single | batch
  batch_id TEXT,                              -- batch 模式所属批次
  seq INTEGER,                                -- batch 内序号
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',      -- queued|running|done|failed
  result TEXT,                                -- JSON: intent/general/negatives/regex/verified/...
  error TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_kw_task_batch ON kw_tasks(batch_id);

CREATE TABLE IF NOT EXISTS kw_batches (
  id TEXT PRIMARY KEY,
  name TEXT,
  filename TEXT,
  total INTEGER DEFAULT 0,
  done INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',     -- running|done|failed
  created_at TEXT,
  updated_at TEXT
);
`);

export function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ---------- 正则库 ----------
export function loadSeedLib() {
  const tx = db;
  const cntBr = tx.prepare("SELECT COUNT(*) c FROM regexlib WHERE kind='branch'").get().c;
  if (cntBr > 0) return { branches: cntBr, skipped: true };
  const seedFile = path.join(DATA, 'seed', 'regexlib.json');
  if (!fs.existsSync(seedFile)) return { missing: true };
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  const insLib = tx.prepare(
    'INSERT INTO regexlib (id,kind,name,label,scenes,status,kw_count,gmt_modified,updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
  const insKw = tx.prepare('INSERT INTO regex_kw (kw_id,lib_id,kind,text) VALUES (?,?,?,?)');
  let kwId = 1_000_000;
  for (const kind of ['branch', 'question']) {
    for (const r of seed[kind === 'branch' ? 'branches' : 'questions']) {
      insLib.run(r.id, kind, r.name, r.label, JSON.stringify(r.scenes || []), r.status, r.kwCount, r.gmtModified, now());
      for (const k of r.kwList) insKw.run(k.id ?? ++kwId, r.id, kind, k.text);
    }
  }
  return { branches: seed.branches.length, questions: seed.questions.length };
}

export function getLib(kind, { q = '', limit = 500, offset = 0 } = {}) {
  if (q) {
    const like = `%${q}%`;
    return db.prepare(
      `SELECT l.*, (SELECT COUNT(*) FROM regex_kw k WHERE k.lib_id=l.id AND k.kind=l.kind) kw_n
       FROM regexlib l WHERE l.kind=? AND (l.name LIKE ? OR l.label LIKE ?)
       ORDER BY l.kw_count DESC LIMIT ? OFFSET ?`).all(kind, like, like, limit, offset);
  }
  return db.prepare(
    `SELECT l.*, (SELECT COUNT(*) FROM regex_kw k WHERE k.lib_id=l.id AND k.kind=l.kind) kw_n
     FROM regexlib l WHERE l.kind=? ORDER BY l.kw_count DESC LIMIT ? OFFSET ?`).all(kind, limit, offset);
}

export function getLibKeywords(libId, kind) {
  return db.prepare('SELECT kw_id id, text FROM regex_kw WHERE lib_id=? AND kind=? ORDER BY kw_id').all(libId, kind);
}

export function libKeywordByKind(kind, name) {
  // 按名称取一个库组的全部正则（巡检用，等价于 branch_lib_kw[name].keywords）
  const row = db.prepare('SELECT id FROM regexlib WHERE kind=? AND name=?').get(kind, name);
  if (!row) return [];
  return db.prepare('SELECT text FROM regex_kw WHERE lib_id=?').all(row.id).map(x => x.text);
}

// ---------- 任务 ----------
export function createTask(id, botId, botName, companyId, params) {
  db.prepare(`INSERT INTO tasks (id,bot_id,bot_name,company_id,status,stage,progress,params,created_at,updated_at)
              VALUES (?,?,?,?,'queued','pending',0,?,?,?)`)
    .run(id, String(botId), botName || '', companyId ? String(companyId) : '', JSON.stringify(params || {}), now(), now());
}

export function updateTask(id, fields) {
  const cur = getTask(id);
  if (!cur) return;
  const merged = { ...cur, ...fields, updated_at: now() };
  db.prepare(`UPDATE tasks SET status=?,stage=?,stage_detail=?,progress=?,bot_name=?,error=?,updated_at=?
              WHERE id=?`)
    .run(merged.status, merged.stage, merged.stage_detail ?? '', merged.progress ?? 0,
         merged.bot_name ?? '', merged.error ?? '', merged.updated_at, id);
}

export function getTask(id) {
  const r = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if (r && r.params) r.params = JSON.parse(r.params);
  return r;
}

export function listTasks() {
  return db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all()
    .map(t => ({ ...t, params: t.params ? JSON.parse(t.params) : {} }));
}

// ---------- 待优化库 ----------
export function clearOptimizations(taskId) {
  db.prepare('DELETE FROM optimizations WHERE task_id=?').run(taskId);
}

export function addOptimization(taskId, row) {
  db.prepare(`INSERT OR REPLACE INTO optimizations
    (task_id,seq,source,question,branch,old_regex,new_regex,action,evidence,hits,node,problem_type)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(taskId, row.seq, row.source, row.question, row.branch, row.old_regex, row.new_regex,
         row.action, row.evidence, row.hits ?? 0, row.node ?? '', row.problem_type ?? '');
}

export function getOptimizations(taskId, { q = '', source = '', limit = 200, offset = 0 } = {}) {
  let sql = 'SELECT * FROM optimizations WHERE task_id=?';
  const args = [taskId];
  if (source) { sql += ' AND source=?'; args.push(source); }
  if (q) { sql += ' AND (question LIKE ? OR old_regex LIKE ? OR new_regex LIKE ? OR evidence LIKE ?)';
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY seq LIMIT ? OFFSET ?';
  args.push(limit, offset);
  return db.prepare(sql).all(...args);
}

export function countOptimizations(taskId) {
  return db.prepare('SELECT COUNT(*) c FROM optimizations WHERE task_id=?').get(taskId).c;
}

// ---------- 关键词任务（单句 + 批量） ----------
export function createKwTask(id, { mode = 'single', batchId = null, seq = null, question }) {
  db.prepare(`INSERT INTO kw_tasks (id,mode,batch_id,seq,question,status,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, mode, batchId ?? null, seq ?? null, String(question), 'queued', now(), now());
}

export function updateKwTask(id, fields) {
  const cur = getKwTask(id);
  if (!cur) return null;
  const merged = { ...cur, ...fields, updated_at: now() };
  const resStr = merged.result == null ? ''
    : (typeof merged.result === 'string' ? merged.result : JSON.stringify(merged.result));
  db.prepare('UPDATE kw_tasks SET status=?,result=?,error=?,updated_at=? WHERE id=?')
    .run(merged.status, resStr, merged.error ?? '', merged.updated_at, id);
  return merged;
}

export function getKwTask(id) {
  const r = db.prepare('SELECT * FROM kw_tasks WHERE id=?').get(id);
  if (r && r.result) { try { r.result = JSON.parse(r.result); } catch { } }
  return r;
}

export function listKwTasks({ mode = '', batchId = '', q = '', limit = 200, offset = 0 } = {}) {
  let sql = 'SELECT * FROM kw_tasks';
  const where = [], args = [];
  if (mode) { where.push('mode=?'); args.push(mode); }
  if (batchId) { where.push('batch_id=?'); args.push(batchId); }
  if (q) { where.push('question LIKE ?'); args.push(`%${q}%`); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  args.push(limit, offset);
  return db.prepare(sql).all(...args).map(r => ({ ...r, result: r.result ? JSON.parse(r.result) : null }));
}

export function countKwTasks({ mode = '', status = '' } = {}) {
  let sql = 'SELECT status, COUNT(*) c FROM kw_tasks';
  const where = [], args = [];
  if (mode) { where.push('mode=?'); args.push(mode); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' GROUP BY status';
  return db.prepare(sql).all(...args);
}

export function deleteKwTask(id) {
  db.prepare('DELETE FROM kw_tasks WHERE id=?').run(id);
}

// ---------- 批次 ----------
export function createKwBatch(id, { name = '', filename = '', total = 0 }) {
  db.prepare(`INSERT INTO kw_batches (id,name,filename,total,done,failed,status,created_at,updated_at)
              VALUES (?,?,?,?,0,0,'running',?,?)`)
    .run(id, name, filename, total, now(), now());
}

export function updateKwBatch(id, fields) {
  const cur = getKwBatch(id);
  if (!cur) return;
  const merged = { ...cur, ...fields, updated_at: now() };
  db.prepare('UPDATE kw_batches SET name=?,filename=?,total=?,done=?,failed=?,status=?,updated_at=? WHERE id=?')
    .run(merged.name ?? '', merged.filename ?? '', merged.total ?? 0, merged.done ?? 0, merged.failed ?? 0,
         merged.status ?? 'running', merged.updated_at, id);
}

export function getKwBatch(id) {
  return db.prepare('SELECT * FROM kw_batches WHERE id=?').get(id);
}

export function listKwBatches({ limit = 100, offset = 0 } = {}) {
  return db.prepare('SELECT * FROM kw_batches ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
}

// ============ 私有化规则版话术优化任务（sy_tasks） ============
db.exec(`CREATE TABLE IF NOT EXISTS sy_tasks (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  bot_name TEXT DEFAULT '',
  scene_name TEXT DEFAULT '',
  status TEXT DEFAULT 'queued',
  stage TEXT DEFAULT 'pending',
  stage_detail TEXT DEFAULT '',
  progress INTEGER DEFAULT 0,
  call_count INTEGER DEFAULT 0,
  call_source TEXT DEFAULT 'upload',
  params TEXT DEFAULT '{}',
  result TEXT,
  error TEXT,
  created_at TEXT,
  updated_at TEXT
)`);

export function createSyTask(id, botId, params) {
  db.prepare(`INSERT INTO sy_tasks (id,bot_id,status,stage,stage_detail,progress,call_source,params,created_at,updated_at)
              VALUES (?,?, 'queued','pending','排队中',0,?,?,?,?)`)
    .run(id, String(botId), params.call_source || 'upload', JSON.stringify(params || {}), now(), now());
}

export function updateSyTask(id, fields) {
  const cur = getSyTask(id);
  if (!cur) return;
  const merged = { ...cur, ...fields, updated_at: now() };
  db.prepare(`UPDATE sy_tasks SET bot_name=?,scene_name=?,status=?,stage=?,stage_detail=?,progress=?,call_count=?,result=?,error=?,updated_at=?
              WHERE id=?`)
    .run(merged.bot_name ?? '', merged.scene_name ?? '', merged.status, merged.stage, merged.stage_detail ?? '',
      merged.progress ?? 0, merged.call_count ?? 0, merged.result ?? null, merged.error ?? '', merged.updated_at, id);
}

export function getSyTask(id) {
  return db.prepare('SELECT * FROM sy_tasks WHERE id=?').get(id);
}

export function listSyTasks({ limit = 100, offset = 0 } = {}) {
  return db.prepare('SELECT * FROM sy_tasks ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
}
