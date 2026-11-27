// xsrunner.mjs —— 相似问泛化五步流程
// ①黑名单 ②场景规范（九大场景+其他） ③LLM 分批并行生成 ④全局唯一性五项断言 ⑤三件套交付
import fs from 'node:fs';
import path from 'node:path';
import { chat, parseJSONLoose, getKey } from './llm.mjs';
import { getXsTask, updateXsTask, listXsTasks } from './xsstore.mjs';
import { buildXsDeliverables, buildXsText } from './xsdeliver.mjs';

const DATA = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data');
const XS_DIR = path.join(DATA, 'xs-tasks');
export const XS_UPLOAD_DIR = path.join(DATA, 'xs-uploads');
fs.mkdirSync(XS_DIR, { recursive: true });
fs.mkdirSync(XS_UPLOAD_DIR, { recursive: true });

// ---------- 场景规范（九大场景 + 其他） ----------
export const SCENES = [
  { key: 'wenlv', label: '文旅景区', confirm: 0.40, open: 0.25, identity: 0.15, short: 0.10, narrative: 0.08, p50: 10 },
  { key: 'ranqi', label: '燃气', confirm: 0.15, open: 0.10, identity: 0.10, short: 0.25, narrative: 0.05, p50: 5, special: '故障陈述类 40%+（"家里没气了""灶打不着火"）' },
  { key: 'yiyuan', label: '医院', confirm: 0.30, open: 0.25, identity: 0.15, short: 0.15, narrative: 0.05, p50: 9 },
  { key: 'shebao', label: '社保', confirm: 0.30, open: 0.20, identity: 0.15, short: 0.10, narrative: 0.20, p50: 8 },
  { key: 'fanzha', label: '反诈外呼', confirm: 0, open: 0, identity: 0, short: 0.60, narrative: 0, p50: 4, special: '接听方应答语料：短平快拒绝/质疑/部分承认' },
  { key: 'yibao', label: '医保', confirm: 0.35, open: 0.25, identity: 0.15, short: 0.10, narrative: 0.08, p50: 9, special: '俗称双轨（报账/报销、门槛费/起付线）' },
  { key: 'xinfang', label: '信访', confirm: 0.20, open: 0.20, identity: 0.15, short: 0.05, narrative: 0.25, p50: 18, special: '叙事铺垫开场 25%+' },
  { key: 'yunyingshang', label: '运营商', confirm: 0.25, open: 0.25, identity: 0.10, short: 0.20, narrative: 0.05, p50: 7 },
  { key: 'yinhang', label: '银行', confirm: 0.35, open: 0.20, identity: 0.15, short: 0.10, narrative: 0.10, p50: 9, special: '冻结敏感/代办继承类' },
  { key: 'other', label: '其他', confirm: 0.35, open: 0.25, identity: 0.15, short: 0.15, narrative: 0.08, p50: 9 },
];

const norm = t => String(t || '').replace(/[，。？！、,\.\?\!\s“”‘’"'：:；;（）()【】\[\]《》<>·—\-_～~]/g, '');

function scenePrompt(scene) {
  const sc = SCENES.find(x => x.key === scene) || SCENES[SCENES.length - 1];
  const pct = x => `${Math.round(x * 100)}%`;
  return [
    `目标场景：${sc.label}。`,
    `句式配比要求（针对每个 KB 条目的相似问集合整体）：封闭确认问（…吗/是不是/能不能）约 ${pct(sc.confirm)}；开放问约 ${pct(sc.open)}；带身份/代问（我帮我妈问/我爸的卡）约 ${pct(sc.identity)}；省略短句（3-8字，如"能报吗""多少钱"）约 ${pct(sc.short)}；叙事铺垫长问约 ${pct(sc.narrative)}。`,
    sc.special ? `场景特有类：${sc.special}。` : '',
    `中位句长约 ${sc.p50} 字。`,
  ].filter(Boolean).join('\n');
}

// ---------- ① 黑名单 ----------
function buildBlacklist(task, kb, dir, log) {
  const bl = new Map(); // norm -> 原文
  const add = t => { const n = norm(t); if (n && !bl.has(n)) bl.set(n, t); };
  // 1) 标准问本身
  for (const it of kb) add(it.title);
  // 2) 线上已有相似问（文件可选）
  const onlineFile = path.join(dir, 'online_similar.json');
  if (fs.existsSync(onlineFile)) {
    try { for (const arr of JSON.parse(fs.readFileSync(onlineFile, 'utf8'))) (arr || []).forEach(add); } catch { }
  }
  // 3) 历史 xs 任务产出（同 bot，跨批次/跨任务并入）
  try {
    for (const t of listXsTasks({ limit: 500 })) {
      if (String(t.bot_id) !== String(task.bot_id) || t.id === task.id) continue;
      for (const it of (t.result?.items || [])) for (const q of it.sims || []) add(q);
    }
  } catch { }
  // 4) 真实通话语料（可选上传）
  const corpusFile = path.join(dir, 'corpus.txt');
  if (fs.existsSync(corpusFile)) {
    for (const l of fs.readFileSync(corpusFile, 'utf8').split('\n')) add(l.trim());
  }
  const out = path.join(dir, 'blacklist.json');
  fs.writeFileSync(out, JSON.stringify({ norm: [...bl.keys()], raw: [...bl.values()] }));
  log(`黑名单：${bl.size} 条已占用问句（标准问 ${kb.length} + 线上/历史/语料并入）`);
  return bl;
}

// ---------- ③ LLM 批量生成 ----------
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

// 宽容解析模型输出：兼容 results[].idx/sims、[{标准问,相似问}]、{标准问:[...]} 等形态
function parseGenOut(text, batch) {
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = parseJSONLoose(text); }
  if (!parsed) return null;
  const simsOf = el => {
    if (Array.isArray(el)) return el.filter(x => typeof x === 'string');
    if (typeof el === 'string') return el.split(/[；;|\n]+/).map(s => s.trim()).filter(s => s.length >= 3);
    if (el && typeof el === 'object') {
      for (const k of ['sims', '相似问', 'similar', 'questions', '列表', 'q', 'items']) {
        if (Array.isArray(el[k])) return el[k].filter(x => typeof x === 'string');
        if (typeof el[k] === 'string') return el[k].split(/[；;|\n]+/).map(s => s.trim()).filter(s => s.length >= 3);
      }
      // 兜底：任意值是数组的字段
      for (const v of Object.values(el)) if (Array.isArray(v) && v.length && v.every(x => typeof x === 'string')) return v;
    }
    return [];
  };
  const out = new Map(); // idx → sims
  const norm = t => String(t || '').replace(/[，。？！、,\.\?\!\s“”‘’"'：:；;（）()【】\[\]《》<>·—\-_～~]/g, '');
  const assign = (key, sims) => {
    let idx = null;
    if (typeof key === 'number') idx = key;
    else if (typeof key === 'string') {
      const n = norm(key);
      const hit = batch.find(b => norm(b.title) === n);
      if (hit) idx = hit.idx;
    }
    if (!idx) return;
    out.set(idx, sims);
  };
  if (Array.isArray(parsed)) {
    parsed.forEach((el, i) => {
      if (el && typeof el === 'object') {
        const key = ['idx', '序号'].map(k => el[k]).find(v => typeof v === 'number') || el['标准问'] || el.title;
        assign(key === undefined ? i + 1 : key, simsOf(el));
      } else if (typeof el === 'string') assign(i + 1, [el]);
    });
  } else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.results)) {
      parsed.results.forEach((r, i) => assign(Number(r?.idx) || (r?.标准问 ?? i + 1), simsOf(r)));
    } else if (typeof parsed['标准问'] === 'string' || typeof parsed.title === 'string') {
      // 单条形态：{"标准问":"...","相似问":[...]}
      assign(parsed['标准问'] || parsed.title, simsOf(parsed));
    } else {
      for (const [k, v] of Object.entries(parsed)) assign(isNaN(Number(k)) ? k : Number(k), simsOf(v));
    }
  }
  return batch.map(b => ({ ...b, raw: out.get(b.idx) || [] }));
}

async function genBatch(batch, blNormSet, scene, perKb, outPath, log) {
  const lines = batch.map((it, i) => `${i + 1}. 标准问：${it.title}${it.answer ? `｜答案要点：${String(it.answer).slice(0, 60)}` : ''}｜需生成 ${it.need} 条`).join('\n');
  const sys = `你是电话客服知识库相似问写作专家。为每条标准问生成口语化相似问，严格遵守：
1. 数量精确：每条正好生成要求的条数，不多不少。
2. 全局唯一：不得与【禁用问句列表】中任何一条语义+文字重复（归一化后完全一致即违规）；同一批次内各条目之间也不得重复。
3. 不编造：相似问中不得出现答案之外的价格/日期/证件号/承诺性表述；缺失信息用泛指（"多少钱""啥时候"）。
4. 区分度：锁定本条主体词，与同批其他条目明显区分。
5. 口语化：电话语感，可用"的话/是不是/能不能/帮我问一下"等结构；保留少量省略短句。
${scenePrompt(scene)}
输出 JSON：{"results":[{"idx":1,"sims":["...","..."]}]}，idx 对应上面编号，只输出 JSON。`;
  const blSample = [...blNormSet].slice(0, 30); // 仅提示用途，强制查重在本地 sanitize
  const user = `【已占用问句示例（前 ${blSample.length} 条，不得重复）】\n${blSample.join(' | ')}\n\n【本批条目】\n${lines}`;

  // 网关 60s 硬切对策：关思考 + JSON 输出（长 prompt 首字延迟才不超 504）
  const NOTHINK = { chat_template_kwargs: { enable_thinking: false }, response_format: { type: 'json_object' } };
  const { text } = await chat([
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ], { maxTokens: 8000, temperature: 0.55, timeoutMs: 115000, retries: 3, extra: NOTHINK });
  const out = parseGenOut(text, batch);
  if (!out || out.every(x => !x.raw.length)) {
    log(`解析失败样本（前240字）：${String(text).slice(0, 240).replace(/\s+/g, ' ')}`);
    throw new Error('LLM 输出无法解析出相似问');
  }
  fs.writeFileSync(outPath, JSON.stringify(out));
  log(`批完成：${batch.length} 条 KB，产出 ${out.reduce((a, b) => a + b.raw.length, 0)} 条候选`);
  return out;
}

// ---------- ④ 清洗 + 五项断言 ----------
function sanitizeBatch(out, blNormSet, localSeen, kbNormTitles, verifyRows) {
  for (const it of out) {
    let dupRemoved = 0, blHit = 0;
    const kept = [];
    const seenInKb = new Set();
    for (let q of (it.raw || [])) {
      q = String(q).trim().replace(/^[，、,]+|[，、,]+$/g, ''); // 只剥首尾逗号，保留问号
      if (!q) continue;
      const n = norm(q);
      if (!n) { dupRemoved++; continue; }
      // 与标准问重复
      if (kbNormTitles.has(n)) { blHit++; continue; }
      // 撞黑名单（线上已有+历史生成+语料）
      if (blNormSet.has(n)) { blHit++; continue; }
      // 条目内重复
      if (seenInKb.has(n)) { dupRemoved++; continue; }
      // 跨条目/跨批重复（本地累积）
      if (localSeen.has(n)) { dupRemoved++; continue; }
      // 红线：价格/证件号编造（粗筛：8位以上连续数字=证件/号码嫌疑）
      const redline = [];
      const mNum = q.match(/\d{8,}/);
      if (mNum) redline.push(`含长数字串 ${mNum[0]}`);
      if (redline.length) {
        verifyRows.redline.push({ title: it.title, q, why: redline.join(';') });
        continue;
      }
      seenInKb.add(n); localSeen.add(n); kept.push(q);
      if (kept.length >= it.need) break;
    }
    it.dupRemoved = dupRemoved; it.blacklistHit = blHit;
    it.sims = kept;
    // 不足补齐标记
    it.shortfall = Math.max(0, it.need - kept.length);
  }
  return out;
}

// ---------- 主流程 ----------
export async function runXsTask(taskId, task, { log = console.log } = {}) {
  const dir = path.join(XS_DIR, taskId);
  fs.mkdirSync(dir, { recursive: true });
  const kbFile = path.join(dir, 'kb.json');
  const kb = JSON.parse(fs.readFileSync(kbFile, 'utf8')); // [{title, group, answer}]
  const perKb = task.per_kb || 5;
  const scene = task.scene || 'other';

  try {
    if (!getKey()) throw new Error('LLM 未配置（BYAI_API_KEY）：请检查环境变量或钥匙串 dsh-llm/BYAI_API_KEY');
    updateXsTask(taskId, { status: 'running', stage: 'blacklist', stage_detail: '构建全局黑名单…', progress: 5 });
    // ① 黑名单
    const bl = buildBlacklist(task, kb, dir, log);
    const blNormSet = new Set(bl ? [...bl.keys()] : []);
    // ② 场景规范（已并入 prompt）
    updateXsTask(taskId, { stage: 'generate', stage_detail: 'LLM 分批并行生成…', progress: 15 });

    // ③ 分批生成（首批 6 条 KB 防网关 60s 超时；失败自动对半拆重试到 1 条/批）
    const genOne = async (batch, tag) => {
      let out = null;
      try { out = await genBatch(batch, blNormSet, scene, perKb, path.join(dir, `gen_${tag}.json`), log); }
      catch (e) {
        log(`批 ${tag} 失败：${String(e.message || e).slice(0, 100)}`);
        if (batch.length > 1) {
          const half = Math.ceil(batch.length / 2);
          log(`批 ${tag} 对半拆分重试（${half}+${batch.length - half}）`);
          const a = await genOne(batch.slice(0, half), `${tag}a`);
          const b = await genOne(batch.slice(half), `${tag}b`);
          return [...a, ...b];
        }
        log(`批 ${tag} 单条仍失败，该条记为未产出`);
        return batch.map(x => ({ ...x, raw: [] }));
      }
      return out;
    };
    const verifyRows = { redline: [] };
    const localSeen = new Set();
    const kbNormTitles = new Set(kb.map(it => norm(it.title)));
    const all = [];
    const batches = chunk(kb.map((it, i) => ({ ...it, need: perKb, idx: i + 1 })), 3);
    for (let bi = 0; bi < batches.length; bi++) {
      const out = await genOne(batches[bi], `b${bi}`);
      sanitizeBatch(out, blNormSet, localSeen, kbNormTitles, verifyRows);
      all.push(...out);
      const got = all.reduce((a, b) => a + (b.sims?.length || 0), 0);
      const needT = all.reduce((a, b) => a + b.need, 0);
      updateXsTask(taskId, { progress: Math.min(78, 15 + Math.round(60 * (bi + 1) / batches.length)), stage_detail: `生成与校验 ${bi + 1}/${batches.length} 批（已采纳 ${got}/${needT}）` });
    }

    // ③b 缺口补跑轮：未达标条目按单条重试（最多 2 轮，应对网关坏窗口期）
    for (let round = 1; round <= 2; round++) {
      const shortfall = all.filter(it => it.sims.length < it.need);
      if (!shortfall.length) break;
      updateXsTask(taskId, { stage_detail: `缺口补跑轮 ${round}（${shortfall.length} 条未达标）`, progress: Math.min(86, 70 + round * 8) });
      log(`补跑轮 ${round}：${shortfall.length} 条未达标，逐条重试`);
      for (let i = 0; i < shortfall.length; i++) {
        const it = shortfall[i];
        // need 改为当前缺口，黑名单/本地去重仍在 sanitize 生效
        const one = [{ ...it, need: it.need - it.sims.length }];
        try {
          const out = await genBatch(one, blNormSet, scene, perKb, path.join(dir, `gen_fix${round}_${it.idx}.json`), log);
          sanitizeBatch(out, blNormSet, localSeen, kbNormTitles, verifyRows);
          it.sims.push(...out[0].sims.slice(0, it.need - it.sims.length));
        } catch (e) { log(`补跑 ${it.title} 失败：${String(e.message || e).slice(0, 80)}`); }
      }
    }

    // ④ 断言统计
    updateXsTask(taskId, { stage: 'verify', stage_detail: '五项断言校验…', progress: 90 });
    const verify = all.map(it => ({
      title: it.title, need: it.need, got: it.sims.length,
      dupRemoved: it.dupRemoved || 0, blacklistHit: it.blacklistHit || 0,
      redline: (verifyRows.redline || []).filter(r => r.title === it.title).map(r => `${r.q}(${r.why})`),
      distinct: it.sims.length && it.sims.every(q => !norm(q).startsWith(norm(it.title).slice(0, 4))) ? '主体词偏弱' : '',
      verdict: it.sims.length >= it.need ? '达标' : (it.sims.length ? '部分达标' : '未产出'),
    }));
    const items = all.map(it => ({ title: it.title, group: it.group || '', answer: it.answer || '', sims: it.sims }));
    const stat = {
      kbCount: kb.length, perKb, needTotal: kb.length * perKb,
      gotTotal: items.reduce((a, b) => a + b.sims.length, 0),
      dupRemoved: verify.reduce((a, b) => a + b.dupRemoved, 0),
      blacklistHit: verify.reduce((a, b) => a + b.blacklistHit, 0),
      redlineCount: verifyRows.redline.length,
      scene: SCENES.find(x => x.key === scene)?.label || scene,
      botId: task.bot_id,
    };
    const fullPass = stat.gotTotal === stat.needTotal && stat.blacklistHit === 0;

    // ⑤ 三件套
    updateXsTask(taskId, { stage: 'deliver', stage_detail: '生成交付物…', progress: 94 });
    const stamp = new Date().toISOString().slice(0, 10);
    const xlsx = path.join(dir, `相似问泛化_${(task.name || taskId).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30)}_${stamp}.xlsx`);
    const tpl = path.join(dir, `知识库导入模板_${stamp}.xlsx`);
    buildXsDeliverables({ items, verify, stat }, xlsx, tpl);
    const txt = path.join(dir, `相似问文本版_${stamp}.txt`);
    fs.writeFileSync(txt, buildXsText(items, { sceneLabel: stat.scene, perKb, botId: task.bot_id }));
    fs.writeFileSync(path.join(dir, 'verify_report.json'), JSON.stringify({ verify, stat, redline: verifyRows.redline }, null, 1));

    updateXsTask(taskId, {
      status: 'done', stage: 'deliver', stage_detail: '完成', progress: 100,
      result: {
        stat, items,
        deliverables: { xlsx: path.basename(xlsx), tpl: path.basename(tpl), txt: path.basename(txt) },
        fullPass,
      },
    });
    log(`任务完成：${stat.gotTotal}/${stat.needTotal} 条，黑名单撞车 ${stat.blacklistHit}，红线 ${stat.redlineCount}`);
  } catch (e) {
    console.error(`[xs ${taskId}] 失败:`, e);
    updateXsTask(taskId, { status: 'failed', error: String(e.message || e).slice(0, 400), stage_detail: '失败' });
  }
}
