// llm.mjs —— LLM 适配层：调用窗口同款大模型（provider: byai / model: deepseek-v4.1-flash）
// 凭据链：环境变量 BYAI_API_KEY → macOS 钥匙串(dsh-llm/BYAI_API_KEY)；密钥不落代码、不进日志
import { spawnSync } from 'node:child_process';

const BASE = process.env.BYAI_BASE_URL || 'https://model.indata.cc/v1';
const MODEL = process.env.BYAI_MODEL || 'deepseek-v4.1-flash';

let _key = null;
export function getKey() {
  if (_key) return _key;
  if (process.env.BYAI_API_KEY) return (_key = process.env.BYAI_API_KEY);
  try {
    const r = spawnSync('security', ['find-generic-password', '-a', 'dsh-llm', '-s', 'BYAI_API_KEY', '-w'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return (_key = r.stdout.trim());
  } catch { }
  return null;
}

// OpenAI 兼容 chat/completions；网关会做模型别名映射，按窗口配置请求 MODEL 即可
// extra: 透传额外请求参数（如 chat_template_kwargs 关闭思考模式）；5xx/504 自动重试
export async function chat(messages, { maxTokens = 4096, temperature = 0.3, timeoutMs = 65000, retries = 2, extra = {} } = {}) {
  const key = getKey();
  if (!key) throw new Error('未找到 BYAI_API_KEY（环境变量或钥匙串 dsh-llm/BYAI_API_KEY 均无）');
  const body = JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature, ...extra });
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body, signal: ctrl.signal,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        // 限流/网关超时等 5xx 可重试；4xx 参数错误不重试
        if (res.status >= 500) throw new Error(`LLM HTTP ${res.status}: ${t.slice(0, 160)}`);
        throw Object.assign(new Error(`LLM HTTP ${res.status}: ${t.slice(0, 200)}`), { noRetry: true });
      }
      const d = await res.json();
      const msg = d.choices?.[0]?.message || {};
      const text = msg.content || msg.reasoning_content || '';
      if (!text) throw new Error('LLM 返回内容为空');
      return { text, model: d.model || MODEL, finishReason: d.choices?.[0]?.finish_reason || '', usage: d.usage || null };
    } catch (e) {
      lastErr = e;
      if (e.noRetry || attempt >= retries) break;
      await new Promise(r => setTimeout(r, 1200)); // 退避后重试
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
}

// 从模型回复里宽松抠 JSON：思考文本可能混进 content，逐个 { 从后往前试，取最后一个能解析的平衡对象
export function parseJSONLoose(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const s = fence ? fence[1] : text;
  const opens = [];
  for (let i = 0; i < s.length; i++) if (s[i] === '{') opens.push(i);
  for (let k = opens.length - 1; k >= 0; k--) {
    const start = opens[k];
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { break; } } }
    }
  }
  return null;
}
