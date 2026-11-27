// zjnotify.mjs —— 质检结果飞书推送（lark-cli，参考 jjwl-ls notify.py 模式）
// 推送内容：按天先发 Word 报告附件，再发摘要文本（总量/合格/不合格/红线/均分/问题类型/问题通话id）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

// 推送目标群：默认「客户成功」；配置文件 data/zj-config.json 可覆盖 {"feishuChatId":"oc_xxx","feishuChatName":"..."}
const DEFAULT_CHAT_NAME = '客户成功';
const CONFIG_PATH = path.join(process.cwd(), 'data', 'zj-config.json');
const HOME = path.join(os.homedir(), '.zj-qc');
const CHAT_CACHE = path.join(HOME, 'chat_id.txt');
const LOG_DIR = path.join(HOME, 'logs');
const MAX_LEN = 12000;

export const RULE_NAMES = {
  R01: 'AI沉默不回复', R02: '输出内部流程或依据', R03: '口吻不符客服',
  R04: '超出知识范围联想生成', R06: '汇总计算总价', R07: '虚假处置或结果承诺',
  R08: '给出未授权的联系方式', R09: '活动有效期错误', R10: '公告冲突',
  R11: '输出Markdown或内部格式', R12: '无效重复追问', R13: '转人工未响应', R14: '无依据未兜底',
};

function log(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'notify.log'),
      `[${new Date().toISOString()}] ${msg}\n`);
  } catch { }
}

export function loadZjConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

function _run(args, opts = {}) {
  try {
    const r = spawnSync('lark-cli', args, { encoding: 'utf8', timeout: 120000, ...opts });
    const out = (r.stdout || '') + (r.stderr || '');
    try {
      const d = JSON.parse(r.stdout || '{}');
      return { ok: !!d.ok, out };
    } catch {
      return { ok: r.status === 0 && out.includes('"ok": true'), out };
    }
  } catch (e) {
    return { ok: false, out: String(e) };
  }
}

export function resolveChat(force = false) {
  if (!force) {
    try {
      const cid = fs.readFileSync(CHAT_CACHE, 'utf8').trim();
      if (cid.startsWith('oc_')) return cid;
    } catch { }
  }
  const cfg = loadZjConfig();
  if (cfg.feishuChatId && String(cfg.feishuChatId).startsWith('oc_')) return cfg.feishuChatId;
  const name = cfg.feishuChatName || DEFAULT_CHAT_NAME;
  const r = _run(['im', '+chat-search', '--query', name]);
  const m = (r.out || '').match(/oc_[0-9a-f]{32}/);
  if (r.ok && m) {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(CHAT_CACHE, m[0]);
    return m[0];
  }
  log(`群解析失败：${(r.out || '').slice(0, 200)}`);
  return null;
}

function sendMarkdown(md, chatId, retries = 3) {
  const cid = chatId || resolveChat();
  if (!cid) return false;
  // 超长按标题边界分片
  const chunks = [];
  if (md.length <= MAX_LEN) chunks.push(md);
  else {
    let cur = '';
    for (const block of md.split(/\n(?=#{1,3} )/)) {
      if (cur.length + block.length + 1 > MAX_LEN && cur) { chunks.push(cur.trimEnd()); cur = block; }
      else cur = cur ? `${cur}\n${block}` : block;
    }
    if (cur.trim()) chunks.push(cur.trimEnd());
  }
  for (let i = 0; i < chunks.length; i++) {
    const body = chunks.length > 1 ? `（${i + 1}/${chunks.length}）\n${chunks[i]}` : chunks[i];
    let sent = false;
    for (let a = 1; a <= retries; a++) {
      const r = _run(['im', '+messages-send', '--chat-id', cid, '--markdown', body]);
      if (r.ok) { sent = true; break; }
      log(`markdown 发送失败（第 ${a} 次）：${(r.out || '').slice(0, 200)}`);
    }
    if (!sent) return false;
  }
  return true;
}

function sendFile(filePath, chatId, retries = 3) {
  const cid = chatId || resolveChat();
  if (!cid || !fs.existsSync(filePath)) return false;
  // lark-cli --file 拒绝绝对路径：cd 到文件所在目录只传文件名
  for (let a = 1; a <= retries; a++) {
    const r = _run(['im', '+messages-send', '--chat-id', cid, '--file', path.basename(filePath)],
      { cwd: path.dirname(filePath) });
    if (r.ok) return true;
    log(`文件发送失败（第 ${a} 次）：${(r.out || '').slice(0, 200)}`);
  }
  return false;
}

// 按天摘要 → 飞书 markdown
export function renderDaySummary(day, dayData, botLabel) {
  const sm = dayData.summary;
  const lines = [
    `【Agent质检】${botLabel} · ${day}`,
    '',
    `- 通话总量：**${sm.total}** 通`,
    `- 合格：${sm.pass} 通　不合格：**${sm.fail}** 通（不合格率 ${sm.fail_rate ? (sm.fail_rate * 100).toFixed(1) : 0}%）`,
    `- 触碰红线：${sm.redline_calls} 通`,
    `- 平均得分：${sm.avg_score} 分`,
  ];
  if (sm.by_rule && Object.keys(sm.by_rule).length) {
    lines.push('', '**问题类型：**');
    for (const [rid, n] of Object.entries(sm.by_rule)) {
      lines.push(`- ${rid} ${RULE_NAMES[rid] || '自定义规则'}：${n} 通`);
    }
  }
  const bad = dayData.reports.filter(r => (r.redline_hits?.length || 0) + (r.deductions?.length || 0) > 0);
  if (bad.length) {
    lines.push('', `**问题通话记录id（${bad.length} 通）：**`);
    for (const r of bad.slice(0, 40)) {
      const rules = [...(r.redline_hits || []), ...(r.deductions || [])].map(f => f.rule_id);
      lines.push(`- \`${r.call_id}\`　${r.verdict}　${r.score} 分　${[...new Set(rules)].join('/')}`);
    }
    if (bad.length > 40) lines.push(`- …其余 ${bad.length - 40} 通见平台「质检问题清单」`);
  }
  lines.push('', `> 按天质检报告与逐条证据见平台：Agent质检 → 任务库 → ${botLabel}`);
  return lines.join('\n');
}

// 任务完成推送：逐天发 Word 附件 + 摘要；返回 {ok, sent, fails}
export async function pushZjTaskReport(task, dayFiles) {
  const chatId = resolveChat();
  const botLabel = task.bot_name ? `${task.bot_name}（bot ${task.bot_id}）` : `bot ${task.bot_id}`;
  if (!chatId) {
    log('未解析到推送群，跳过飞书推送');
    return { ok: false, reason: 'no-chat' };
  }
  const days = Object.keys(dayFiles).sort();
  let sent = 0;
  const fails = [];
  for (const day of days) {
    const { file, dayData } = dayFiles[day];
    // 先发附件（成功或失败都继续发摘要文本，保证消息可达）
    const fileOk = sendFile(file, chatId);
    const md = renderDaySummary(day, dayData, botLabel);
    const mdOk = sendMarkdown(md, chatId);
    if (fileOk && mdOk) sent++;
    else fails.push(day);
    log(`推送 ${day}：附件${fileOk ? '✓' : '✗'} 摘要${mdOk ? '✓' : '✗'}`);
  }
  return { ok: fails.length === 0, sent, fails };
}
