// xjstore.mjs —— 巡检报告中心存储：请求表 + 报告记录
import { db } from './store.mjs';

db.exec(`
CREATE TABLE IF NOT EXISTS xj_requests (
  id TEXT PRIMARY KEY,                -- 任务编号，xj 前缀
  tenant TEXT NOT NULL,               -- 租户名称
  scenario TEXT NOT NULL,             -- 文本 | 语音 - SaaS | 语音 - 私有化
  template_id TEXT NOT NULL,          -- 模板ID（templateCatalog 键）
  template TEXT NOT NULL,             -- 模板名称
  skill TEXT NOT NULL,                -- 执行的 skill 名
  task_name TEXT,                     -- 展示用任务名
  period_start TEXT NOT NULL,         -- 周期开始 YYYY-MM-DD
  period_end TEXT NOT NULL,           -- 周期结束 YYYY-MM-DD
  period TEXT,                        -- 展示周期（如 2025.1.1-12.23）
  remarks TEXT,
  status TEXT NOT NULL DEFAULT 'processing',  -- processing|success|failed
  stage TEXT NOT NULL DEFAULT 'queued',       -- queued|generating|done
  error TEXT,
  files TEXT,                         -- 上传文件清单 JSON
  report_path TEXT,                   -- 生成的 DOCX 相对路径
  report_name TEXT,                   -- 报告文件名
  executor_log TEXT,                  -- 执行日志尾部
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_xj_req_status ON xj_requests(status);
CREATE INDEX IF NOT EXISTS idx_xj_req_tenant ON xj_requests(tenant);
`);

const now = () => new Date().toISOString();

export function createRequest(id, data) {
  db.prepare(`
    INSERT INTO xj_requests (id, tenant, scenario, template_id, template, skill, task_name,
      period_start, period_end, period, remarks, status, stage, files, created_at, updated_at)
    VALUES (@id, @tenant, @scenario, @templateId, @template, @skill, @taskName,
      @periodStart, @periodEnd, @period, @remarks, 'processing', 'queued', @files, @t, @t)
  `).run({ ...data, id, t: now() });
  return getRequest(id);
}

export function updateRequest(id, fields) {
  const allowed = ['status', 'stage', 'error', 'report_path', 'report_name', 'executor_log', 'period'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return;
  db.prepare(`UPDATE xj_requests SET ${keys.map(k => `${k} = @${k}`).join(', ')}, updated_at = @t WHERE id = @id`)
    .run({ ...fields, t: now(), id });
}

export function getRequest(id) {
  return db.prepare('SELECT * FROM xj_requests WHERE id = ?').get(id) || null;
}

export function listRequests() {
  return db.prepare('SELECT * FROM xj_requests ORDER BY created_at DESC').all();
}

export function countByStatus() {
  return db.prepare(`SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END) AS processing,
    SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
  FROM xj_requests
  `).get();
}
