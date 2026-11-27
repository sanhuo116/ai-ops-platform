// aostore.mjs —— Agent自动优化任务存储（复用 store.mjs 的 SQLite 连接）
import { db } from './store.mjs';

db.exec(`
CREATE TABLE IF NOT EXISTS ao_tasks (
  id TEXT PRIMARY KEY,
  name TEXT,
  mode TEXT,                    -- called(已外呼/呼入过) | draft(未外呼)
  bot_id TEXT,
  tenant_id TEXT,
  status TEXT DEFAULT 'pending',
  stage TEXT DEFAULT '',
  stage_detail TEXT DEFAULT '',
  progress INTEGER DEFAULT 0,
  error TEXT,
  params TEXT,
  result TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS ao_regressions (
  id TEXT PRIMARY KEY,
  ao_task_id TEXT,
  source TEXT,                  -- sy:私有化巡检问题 | manual
  source_task_id TEXT,
  call_id TEXT,
  bot_id TEXT,
  problem_kind TEXT,
  problem_brief TEXT,
  case_json TEXT,               -- 生成的回归用例 JSON
  status TEXT DEFAULT 'pending',   -- pending|running|pass|fail|blocked|error
  progress INTEGER DEFAULT 0,
  stage_detail TEXT DEFAULT '',
  run_dir TEXT,
  verdict TEXT,
  rationale TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_ao_reg_task ON ao_regressions(ao_task_id);
CREATE INDEX IF NOT EXISTS idx_ao_reg_status ON ao_regressions(status);
`);

const stmts = {};
function s(key, sql) { return stmts[key] ||= db.prepare(sql); }

export function createAoTask(id, fields) {
  s('ins', `INSERT INTO ao_tasks (id,name,mode,bot_id,tenant_id,params) VALUES (?,?,?,?,?,?)`)
    .run(id, fields.name || '', fields.mode, String(fields.botId || ''), String(fields.tenantId || ''), JSON.stringify(fields.params || {}));
}

export function updateAoTask(id, fields) {
  const keys = Object.keys(fields).filter(k => k !== 'id');
  if (!keys.length) return;
  const set = keys.map(k => `${k}=?`).join(',');
  const vals = keys.map(k => (typeof fields[k] === 'object' && fields[k] !== null ? JSON.stringify(fields[k]) : fields[k]));
  s('upd:' + set, `UPDATE ao_tasks SET ${set}, updated_at=datetime('now','localtime') WHERE id=?`).run(...vals, id);
}

export function getAoTask(id) {
  const r = s('get', 'SELECT * FROM ao_tasks WHERE id=?').get(id);
  return hydrate(r);
}

export function listAoTasks({ limit = 100 } = {}) {
  return s('list', 'SELECT * FROM ao_tasks ORDER BY created_at DESC LIMIT ?').all(limit).map(hydrate);
}

// ---------- 回归子任务 ----------
export function createAoRegression(id, fields) {
  s('rins', `INSERT INTO ao_regressions (id,ao_task_id,source,source_task_id,call_id,bot_id,problem_kind,problem_brief,case_json) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, fields.aoTaskId || '', fields.source || 'manual', fields.sourceTaskId || '', String(fields.callId || ''), String(fields.botId || ''), fields.problemKind || '', fields.problemBrief || '', JSON.stringify(fields.caseJson || null));
}

export function updateAoRegression(id, fields) {
  const keys = Object.keys(fields).filter(k => k !== 'id');
  if (!keys.length) return;
  const set = keys.map(k => `${k}=?`).join(',');
  const vals = keys.map(k => (typeof fields[k] === 'object' && fields[k] !== null ? JSON.stringify(fields[k]) : fields[k]));
  s('rupd:' + set, `UPDATE ao_regressions SET ${set}, updated_at=datetime('now','localtime') WHERE id=?`).run(...vals, id);
}

export function getAoRegression(id) {
  const r = s('rget', 'SELECT * FROM ao_regressions WHERE id=?').get(id);
  return hydrate(r);
}

export function listAoRegressions({ taskId, status, limit = 200 } = {}) {
  let rows;
  if (taskId && status) rows = s('rlist2', 'SELECT * FROM ao_regressions WHERE ao_task_id=? AND status=? ORDER BY created_at DESC LIMIT ?').all(taskId, status, limit);
  else if (taskId) rows = s('rlist1', 'SELECT * FROM ao_regressions WHERE ao_task_id=? ORDER BY created_at DESC LIMIT ?').all(taskId, limit);
  else if (status) rows = s('rlistS', 'SELECT * FROM ao_regressions WHERE status=? ORDER BY created_at DESC LIMIT ?').all(status, limit);
  else rows = s('rlist', 'SELECT * FROM ao_regressions ORDER BY created_at DESC LIMIT ?').all(limit);
  return rows.map(hydrate);
}

function hydrate(r) {
  if (!r) return r;
  for (const k of ['params', 'result', 'case_json']) {
    if (r[k]) { try { r[k] = JSON.parse(r[k]); } catch { } }
  }
  return r;
}
