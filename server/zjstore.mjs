// zjstore.mjs —— Agent质检任务存储（复用 store.mjs 的 db 连接）
import { db, now } from './store.mjs';

db.exec(`CREATE TABLE IF NOT EXISTS zj_tasks (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  bot_name TEXT DEFAULT '',
  tenant_name TEXT DEFAULT '',
  status TEXT DEFAULT 'queued',
  stage TEXT DEFAULT 'pending',
  stage_detail TEXT DEFAULT '',
  progress INTEGER DEFAULT 0,
  call_count INTEGER DEFAULT 0,
  params TEXT DEFAULT '{}',
  result TEXT,
  error TEXT,
  created_at TEXT,
  updated_at TEXT
)`);

const stmts = {
  insert: db.prepare(`INSERT INTO zj_tasks (id,bot_id,status,stage,stage_detail,progress,params,created_at,updated_at)
                      VALUES (?,?, 'queued','pending','排队中',0,?,?,?)`),
  update: db.prepare(`UPDATE zj_tasks SET bot_name=?,tenant_name=?,status=?,stage=?,stage_detail=?,progress=?,call_count=?,result=?,error=?,updated_at=?
                      WHERE id=?`),
  get: db.prepare('SELECT * FROM zj_tasks WHERE id=?'),
  list: db.prepare('SELECT * FROM zj_tasks ORDER BY created_at DESC LIMIT ? OFFSET ?'),
};

export function createZjTask(id, botId, params) {
  stmts.insert.run(id, String(botId), JSON.stringify(params || {}), now(), now());
}

export function updateZjTask(id, fields) {
  const cur = stmts.get.get(id);
  if (!cur) return;
  const m = { ...cur, ...fields, updated_at: now() };
  const resultJson = (m.result === null || m.result === undefined) ? null
    : (typeof m.result === 'string' ? m.result : JSON.stringify(m.result));
  stmts.update.run(String(m.bot_name ?? ''), String(m.tenant_name ?? ''), String(m.status), String(m.stage), String(m.stage_detail ?? ''),
    Number(m.progress ?? 0), Number(m.call_count ?? 0), resultJson, String(m.error ?? ''), String(m.updated_at), String(id));
}

export function getZjTask(id) { return stmts.get.get(id); }
export function listZjTasks({ limit = 100, offset = 0 } = {}) {
  return stmts.list.all(limit, offset);
}
