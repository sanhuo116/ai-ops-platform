// xsstore.mjs —— 相似问泛化任务存储（复用 store.mjs 的 SQLite 连接）
import { db } from './store.mjs';

db.exec(`
CREATE TABLE IF NOT EXISTS xs_tasks (
  id TEXT PRIMARY KEY,
  name TEXT,
  tenant_id TEXT,
  bot_id TEXT,
  scene TEXT,
  scene_label TEXT,
  per_kb INTEGER,
  kb_count INTEGER,
  need_total INTEGER,
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
CREATE INDEX IF NOT EXISTS idx_xs_status ON xs_tasks(status);
`);

const stmts = {};
function s(key, sql) { return stmts[key] ||= db.prepare(sql); }

export function createXsTask(id, fields) {
  s('ins', `INSERT INTO xs_tasks (id,name,tenant_id,bot_id,scene,scene_label,per_kb,kb_count,need_total,params) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, fields.name || '', String(fields.tenantId || ''), String(fields.botId || ''), fields.scene || '', fields.sceneLabel || '', fields.perKb || 5, fields.kbCount || 0, fields.needTotal || 0, JSON.stringify(fields.params || {}));
}

export function updateXsTask(id, fields) {
  const keys = Object.keys(fields).filter(k => k !== 'id');
  if (!keys.length) return;
  const set = keys.map(k => `${k}=?`).join(',');
  const vals = keys.map(k => (typeof fields[k] === 'object' && fields[k] !== null ? JSON.stringify(fields[k]) : fields[k]));
  // 缓存键必须含 set 子句（不同字段数的语句不能复用同一预编译对象）
  s('upd:' + set, `UPDATE xs_tasks SET ${set}, updated_at=datetime('now','localtime') WHERE id=?`).run(...vals, id);
}

export function getXsTask(id) {
  const r = s('get', 'SELECT * FROM xs_tasks WHERE id=?').get(id);
  return hydrate(r);
}

export function listXsTasks({ limit = 100 } = {}) {
  return s('list', 'SELECT * FROM xs_tasks ORDER BY created_at DESC LIMIT ?').all(limit).map(hydrate);
}

function hydrate(r) {
  if (!r) return r;
  if (r.params) { try { r.params = JSON.parse(r.params); } catch { } }
  if (r.result) { try { r.result = JSON.parse(r.result); } catch { } }
  return r;
}
