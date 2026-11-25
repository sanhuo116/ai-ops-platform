// gen.mjs —— 单句关键词生成引擎（zhengze-shengcheng 方法论）
// 分工：LLM 负责语义（意图/泛化15条/规避10条/词元提取），引擎负责三段式正则的确定性组装、变体搜索与验证修复
// 三段式对齐示例：(?<!(没|不|现))在[呢呀啊的](?!.{0,8}[哪没])  =  左环视规避 + 核心词 + 右环视规避
// 交付标准：泛化 15/15 命中 + 规避 10/10 不命中；修复收敛不了的结果标记 failed，不推给用户
import { chat, parseJSONLoose } from './llm.mjs';

// ---------- 第一段 prompt：意图 + 泛化 + 规避（tokens 由第二段小调用/本地推导） ----------
const LIST_PROMPT = (q) => `你是客服话术关键词生成专家。对用户问句完成三件事：
【1】理解句意与意图（一句话概括）。
【2】场景泛化：不脱离原意，写出恰好 15 条同义说法（口语省略、语气词呀啦哦、宾语前置、完成态变化好了/完了/过了/成功了/搞定了、主语省略等）。泛化句一律用陈述/感叹句式，禁止出现 疑问词（吗/没/怎么/哪/吧）与否定词（没/不/别/未）——完成态一律用肯定表达。每条泛化句必须保留问句中的核心动词/名词字面或其单字缩略（如 下载→下、报警→报、缴费→缴），不要换成字面完全不同的说法（如 报警→找警察），关键词正则要靠这些字面命中。
【3】规避案例：恰好 10 条——加入规避关键词后【原句意改变】的句子，按句意从这些维度取：否定（没/不/未/别）、疑问（吗/没有/怎么/哪）、意愿指令（要/想/去/不用/请/记得/先/等）、索取资源（链接/地址/包）。
只输出一个 JSON 对象，general 恰好 15 个真实中文句子、negatives 恰好 10 个真实中文句子，每句不超过 15 个字，禁止占位符文字：
{"intent":"一句话意图","general":["泛化句1","泛化句2","泛化句3","泛化句4","泛化句5","泛化句6","泛化句7","泛化句8","泛化句9","泛化句10","泛化句11","泛化句12","泛化句13","泛化句14","泛化句15"],"negatives":["规避句1","规避句2","规避句3","规避句4","规避句5","规避句6","规避句7","规避句8","规避句9","规避句10"]}
用户问句：${q}
【重要】禁止任何分析、翻译或解释，不要输出思考过程，第一步就直接输出 JSON 对象。`;

// ---------- 第二段 prompt：词元提取（独立小调用，输出很小） ----------
const TOKENS_PROMPT = (q, general, negatives) => `问句「${q}」的泛化句：${general.join('；')}。规避案例：${negatives.join('；')}。
提取正则设计词元（只输出 JSON）：core=泛化句中表达核心动作/话题的词及口语缩略（如 下载/下）；state=完成态字词（好/完/过/了/成功/上了…按句意）；left=规避案例中出现在核心词前使句意改变的词（1-2字，如 没/不/别/要/想/去/不用/请/记得/先/怎么/有/法）；right=出现在核心词后使句意改变的疑问/索取词（如 吗/没有/链接/地址）；rightDist=右扫距离(5~20整数)；obj=对象词（app/软件等，可空数组）。
输出：{"core":[".."],"state":[".."],"left":[".."],"right":[".."],"rightDist":12,"obj":[".."]}
【重要】禁止任何分析或解释，第一步就直接输出 JSON 对象。`;

// ---------- 词元候选常量 ----------
const STATE_CANDS = ['成功', '好了', '完了', '上了', '好', '完', '过', '毕', '了', '定', '妥', '结', '清', '上', '啦', '喽', '咯', '哦', '噢', '呀', '哈'];
const LEFT_CANDS = ['没', '不', '未', '别', '怎', '么', '咋', '哪', '何', '不用', '要', '想', '去', '来', '得', '记', '先', '等', '请', '帮我', '有', '无'];
const CORE_DICT = ['下载', '安装', '收到', '打开', '登录', '注册', '缴费', '充值', '办理', '取消', '确认', '同意', '咨询', '投诉', '查询', '购买', '预约', '签字', '体检', '理赔', '续保', '退款', '到账', '发货', '签收', '报警', '付款', '发货', '激活', '审核', '通过', '生效', '到账'];
const BRIDGE_RE = /^(弄|搞|办|处理|给|帮|安排|操作|解决|开始|继续)$/;

// 本地词元推导（tokens 调用失败时的确定性兜底）
export function deriveTokensLocally(q, general, nList) {
  const OBJ_WORDS = ['app', 'APP', '软件', '应用', '程序', '平台', '系统', '小程序', '链接'];
  const obj0 = OBJ_WORDS.filter(w => q.toLowerCase().includes(w.toLowerCase()));
  // 统计泛化句中的 2 字组合频率，取非停用词最高频为核心词
  const freq = new Map();
  for (const s of general || []) {
    const t = String(s);
    for (let i = 0; i < t.length - 1; i++) {
      const bi = t.slice(i, i + 2);
      if (/[\u4e00-\u9fa5]{2}/.test(bi) && !/我|的|了|吗|呢|这|那|个|呀|啊|啦|吧|好|完|过|没|不|吗/.test(bi)) {
        freq.set(bi, (freq.get(bi) || 0) + 1);
      }
    }
  }
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  const src = [q, ...(general || [])];
  const cores = new Set();
  for (const w of CORE_DICT) if (src.some(t => t.includes(w))) { cores.add(w); if (w.length > 1) cores.add(w[0]); }
  if (!cores.size && sorted[0]) { cores.add(sorted[0]); cores.add(sorted[0][0]); }
  if (!cores.size) {
    const stripped = q.replace(/[我你他她它您吗呢吧呀啊啦哦哈的了个这那有和跟就是也都很被把让向对着说完\s]/g, '');
    if (stripped) cores.add(stripped);
  }
  // 右扫词：从规避案例里实际出现的疑问/追问/索取词自适应提取；
  // 若某词也出现在泛化句中（问句型问句的"吗"等），说明它不改变句意 → 剔除，避免误杀泛化
  const RIGHT_CANDS = ['吗', '没有', '好没', '没好', '怎么', '怎样', '咋样', '如何', '哪', '链接', '地址', '二维码', '入口', '包', '资料', '攻略', '教程'];
  const negText = (nList || []).join('|');
  const genText = (general || []).join('|');
  const right = RIGHT_CANDS.filter(w => negText.includes(w) && !genText.includes(w));
  // obj 提取：泛化句中「核心词…状态词」之间的名词短语（如 收到[短信]了、下载[这个app]了）
  const MOOD = /[吗呢吧啦哦噢喔哈啊呀的了吗没不别怎哪]/;
  const STATE_RE = /(成功|好了|完了|上了|好|完|过|毕|了|定|妥|结|清|上|啦|喽|咯)/;
  const objs = new Set(obj0);
  const mainCore = [...cores].sort((a, b) => b.length - a.length)[0];   // 只用最长核心词提取，避免子串误配
  for (const sent of general || []) {
    const i = String(sent).indexOf(mainCore);
    if (i < 0 || !mainCore) continue;
    const rest = String(sent).slice(i + mainCore.length);
    const m = rest.match(STATE_RE);
    if (!m || m.index === 0 || m.index > 8) continue;
    const seg = rest.slice(0, m.index);
    const FUNC = /[我你他她它您们这那就还都已经马上立刻即将要很挺越把让被跟和与同向对着从是了着过搞弄办给]/;
    if (seg && seg.length <= 4 && seg.length >= 2 && !MOOD.test(seg) && !STATE_RE.test(seg)
        && !BRIDGE_RE.test(seg) && !FUNC.test(seg)
        && /^[\u4e00-\u9fa5a-zA-Z]+$/.test(seg) && !cores.has(seg)) objs.add(seg);
  }
  return {
    obj: [...objs],
    core: [...cores],
    state: [...STATE_CANDS],
    left: LEFT_CANDS.filter(w => !genText.includes(w)),
    right, rightDist: 15,
  };
}

// 过滤占位符/无效项
const badItem = s => !s || s.length < 2 || /^恰好|^泛化句\d|^规避句\d|^核心词$|^状态词$|^左规避词$|^右规避词$|^对象词$|^\.\.\.+$|^…+$/.test(s);

// ---------- 本地验证 ----------
export function verifyRegex(regex, positives, negatives) {
  let re;
  try { re = new RegExp(regex); } catch (e) {
    return { error: `正则编译失败：${e.message}`, general: [], negatives: [], ok: false };
  }
  const test = (list) => (list || []).map(t => {
    let m = null;
    try { m = re.exec(String(t)); } catch { }
    return { text: String(t), hit: !!m, seg: m ? m[0] : '' };
  });
  const general = test(positives), negRes = test(negatives);
  const ok = general.length > 0 && general.every(x => x.hit) && negRes.every(x => !x.hit);
  return { general, negatives: negRes, ok };
}

// ---------- 三段式组装 ----------
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alt = (arr) => {
  const uniq = [...new Set((arr || []).map(s => String(s).trim()).filter(Boolean))];
  uniq.sort((a, b) => b.length - a.length);      // 长词优先，避免短分支抢先
  return uniq.join('|');
};

// 左规避（参考风格）：一个括号集合装下所有规避词（混合宽度分支合法于 JS/百应方言），
// 尾部 .{0,N} 允许规避词与核心词之间隔任意字 —— 能挡「我不打算下载」「懒得下载」这类间隔形态
export function leftGroup(words, gap = 10) {
  const ws = [...new Set(words.filter(Boolean))];
  if (!ws.length) return '';
  return `(?<!(${ws.map(esc).join('|')}).{0,${gap}})`;
}

export function assemble(t, opt = {}) {
  const leftGap = opt.leftGap ?? t.leftGap ?? 10;
  const left = leftGroup([...(t.left || []), ...(opt.extraLeft || [])], leftGap);
  const core = alt(opt.core || t.core);
  if (!core) return null;
  const state = alt([...(opt.state || t.state || []), ...(opt.extraState || [])]);
  const rightWords = [...new Set([...(t.right || []), ...(opt.extraRight || [])])].filter(Boolean);
  const dist = opt.dist ?? t.rightDist ?? 12;
  // 核心词与状态词之间的弹性 filler：0-10 个任意字符，但每个位置不得开启否定/疑问词
  //（参考风格 ((?!不|没|什么|啥|鬼|毛|龟|爸|妈|逼|其他|另外|别).){0,10}）
  const FILLER_BLOCK = ['不', '没', '未', '别', '无', '怎么', '啥', '哪', '吗', '干嘛', '什么时候', '如何', '难道'];
  const filler = opt.noFiller ? '' : `((?!${[...new Set(FILLER_BLOCK)].map(esc).join('|')}).){0,10}`;
  // 右侧右扫（含索取资源兜底并入同一风格）
  const rightAll = [...new Set([...rightWords, '地址', '链接', '二维码', '入口', '包', '资料', '攻略'])].filter(Boolean);
  return left
    + `(${core})`
    + filler                                                   // 弹性中段：收到(那条)短信(了)/付款已经搞定(了)
    + (state ? `(${state})` : '')
    + `了?(?!.{0,${dist}}(${rightAll.map(esc).join('|')}))`;    // 疑问/追问/索取右扫
}

// 变体搜索：状态集（含裸核心词）× 右扫距离 × 左 gap × filler 开关
function variants(t) {
  const stateFull = t.state || [];
  const stateMin = stateFull.filter(w => '了好完过'.includes(w) || w === '成功');
  const v = [];
  for (const state of [stateFull, stateMin, []]) {   // [] = 裸核心词（无完成态句式，如「我要投诉」）
    for (const dist of [t.rightDist ?? 12, 8, 16]) {
      for (const leftGap of [10, 6, 0]) {            // 0 = 紧邻 lookbehind（挡核心词紧前缀）
        for (const noFiller of [false, true]) {
          v.push({ state, dist, leftGap, noFiller });
        }
      }
    }
  }
  return v;
}

// 评分：全过=0 分最优；规避误中权重更高（比漏报更危害）
function score(v, nGeneral, nNeg) {
  if (!v || v.error || !v.general.length) return 9999;
  const miss = v.general.filter(x => !x.hit).length;
  const falseHit = v.negatives.filter(x => x.hit).length;
  return miss + falseHit === 0 ? 0 : (miss * 2 + falseHit * 4) * 100 + nGeneral + nNeg;
}

// 统一变体搜索：返回最优 {正则, 验证, 得分}
function searchBest(tokens, general, negatives) {
  let best = null, bestScore = Infinity, bestRegex = '';
  for (const opt of variants(tokens)) {
    const regex = assemble(tokens, opt);
    if (!regex) continue;
    const v = verifyRegex(regex, general, negatives);
    const s = score(v, general.length, negatives.length);
    if (s < bestScore) { bestScore = s; best = v; bestRegex = regex; }
    if (s === 0) break;
  }
  return { best, bestScore, bestRegex };
}

// 候选动作生成：从违规明细反推「单步」可尝试的改动（一次只动一个词，避免整批提交互相污染）
function candidateMoves(tokens, v) {
  const moves = [];
  const cores = (tokens.core || []).filter(Boolean);
  const WORD_RE = /^[\u4e00-\u9fa5a-zA-Z]+$/;
  for (const x of (v.negatives || []).filter(x => x.hit && x.seg)) {
    const idx = x.text.indexOf(x.seg);
    if (idx < 0) continue;
    // 误中句：匹配起点前 1-2 字 → 左规避候选
    for (const len of [2, 1]) {
      const w = x.text.slice(Math.max(0, idx - len), idx);
      if (w && WORD_RE.test(w) && !tokens.left.includes(w)) moves.push({ type: 'addLeft', w });
    }
    // 匹配终点后 1-2 字 → 右扫候选
    const end = idx + x.seg.length;
    for (const len of [2, 1]) {
      const w = x.text.slice(end, end + len);
      if (w && /^[\u4e00-\u9fa5]+$/.test(w) && !tokens.right.includes(w)) moves.push({ type: 'addRight', w });
    }
    // 疑问/否定前置型规避句（哪条短信收到了）：句首 1-2 字 → 右扫候选
    if (/^(哪|啥|什么|几|多|谁|怎|吗|没|不|别)/.test(x.text)) {
      for (const len of [2, 1]) {
        const w = x.text.slice(0, len);
        if (w && !tokens.right.includes(w)) moves.push({ type: 'addRight', w });
      }
    }
  }
  for (const x of (v.general || []).filter(x => !x.hit)) {
    // 未中句：核心词后 3 字找状态词候选
    let found = false, stdState = false;
    for (const c of cores) {
      const i = x.text.indexOf(c);
      if (i >= 0) {
        found = true;
        const after = x.text.slice(i + c.length, i + c.length + 3);
        for (const st of STATE_CANDS) if (after.includes(st) && !tokens.state.includes(st)) { moves.push({ type: 'addState', w: st }); stdState = true; }
      }
    }
    // 核心词后无标准状态词 → 句尾字符兜底候选（如「正在派出所呢」的「呢」），试评筛选，
    // 会误中规避句的候选自动弃用
    if (found && !stdState) {
      for (const ch of [...new Set([...x.text.slice(-2)])]) {
        if (/[\u4e00-\u9fa5]/.test(ch) && !tokens.state.includes(ch) && !'了吗过啊吧嘛呀哦噢哈啦'.includes(ch)) {
          moves.push({ type: 'addState', w: ch });
        }
      }
    }
    // 未中句不含核心词 → 新核心词候选（字典词优先，其次状态词前的动作主干）
    if (!found) {
      const dictHit = CORE_DICT.find(w => x.text.includes(w));
      if (dictHit && !tokens.core.includes(dictHit)) moves.push({ type: 'addCore', w: dictHit });
      else {
        const m = x.text.match(/(成功|好了|完了|上了|好|完|过|了)/);
        if (m && m.index > 0) {
          const SKIP = /[我你他她它您们都也已经早就刚刚才又还再很挺越被把让向对着和跟或者是有的了过完好]/;
          for (const len of [2, 1]) {
            const cand = x.text.slice(Math.max(0, m.index - len), m.index);
            if (cand && /^[\u4e00-\u9fa5]+$/.test(cand) && !SKIP.test(cand) && !tokens.core.includes(cand)) moves.push({ type: 'addCore', w: cand });
          }
        }
      }
    }
    // 疑问词嵌在句中的未中句（保单什么时候生效）：把嵌入的疑问词抽出来同时做两件事——
    // 加进 right（右扫挡规避句）+ 从 left 剔除（左环视不再误杀泛化句中合法出现的疑问词）
    for (const qw of ['怎么', '哪', '啥', '吗', '么']) {
      if (x.text.includes(qw)) {
        if (!tokens.right.includes(qw)) moves.push({ type: 'addRight', w: qw });
        if (tokens.left.includes(qw)) moves.push({ type: 'delLeft', w: qw });
        if (tokens.left.includes(qw + '么') ) moves.push({ type: 'delLeft', w: qw + '么' });
      }
    }
    // 无字典词、无状态锚点的未中句（医保费搞定啦）：句中每个非停用单字都试作核心词候选，
    // 由试评筛选（加了会误中规避的候选分数变差被自动弃用）
    if (!found && !CORE_DICT.some(w => x.text.includes(w))) {
      const STOPC = '的我你他她它您们这那了个是也很都被把让向对着和跟或者是有在很挺越呀啦哦噢哈呗嘛吧呢吗没不别还未要想去来记得先等请帮我用过完好定妥结清上上了';
      for (const ch of new Set(x.text)) {
        if (/[\u4e00-\u9fa5]/.test(ch) && !STOPC.includes(ch) && !tokens.core.includes(ch)) moves.push({ type: 'addCore', w: ch });
      }
    }
  }
  // 移除类动作：现有词可能过度拦截（挡了泛化）——逐个试着删
  for (const w of tokens.left) moves.push({ type: 'delLeft', w });
  for (const w of tokens.right) moves.push({ type: 'delRight', w });
  return moves;
}

function applyMove(tokens, mv) {
  const t = { ...tokens, left: [...tokens.left], right: [...tokens.right], state: [...tokens.state], core: [...tokens.core] };
  if (mv.type === 'addLeft') { if (t.left.includes(mv.w)) return null; t.left.push(mv.w); }
  else if (mv.type === 'addRight') { if (t.right.includes(mv.w)) return null; t.right.push(mv.w); }
  else if (mv.type === 'addState') { if (t.state.includes(mv.w)) return null; t.state.push(mv.w); }
  else if (mv.type === 'addCore') { if (t.core.includes(mv.w)) return null; t.core.push(mv.w); }
  else if (mv.type === 'delLeft') { if (!t.left.includes(mv.w)) return null; t.left = t.left.filter(w => w !== mv.w); }
  else if (mv.type === 'delRight') { if (!t.right.includes(mv.w)) return null; t.right = t.right.filter(w => w !== mv.w); }
  else return null;
  return t;
}

// 增量修复搜索：单步动作逐个试评，只保留严格改进的；修不好如实返回（不硬凑）
export function repairSearch(tokens0, general, negatives, { rounds = 4, log = () => { } } = {}) {
  let tokens = tokens0;
  let cur = searchBest(tokens, general, negatives);
  let used = 0;
  while (cur.bestScore > 0 && used < rounds) {
    used++;
    const miss = cur.best.general.filter(x => !x.hit).length;
    const falseHit = cur.best.negatives.filter(x => x.hit).length;
    log(`修复第 ${used} 轮（泛化未中 ${miss}，规避误中 ${falseHit}）——增量试评候选词`);
    const moves = candidateMoves(tokens, cur.best);
    // 优先级：堵误中（addLeft/addRight）> 补未中（addState/addCore）> 放宽（del）
    const rank = m => (m.type === 'addLeft' || m.type === 'addRight') ? 0 : m.type.startsWith('del') ? 2 : 1;
    moves.sort((a, b) => rank(a) - rank(b));
    let improved = false;
    for (const mv of moves) {
      const t2 = applyMove(tokens, mv);
      if (!t2) continue;
      // 每个动作全变体重搜：正确修复常是「改词 + 换变体」的组合（如 加么+裸核心词），单配置评估看不到收益
      const r2 = searchBest(t2, general, negatives);
      if (r2.bestScore < cur.bestScore) {
        log(`  采纳 ${mv.type}:${mv.w}（${r2.bestScore} < ${cur.bestScore}）`);
        tokens = t2;
        cur = r2;
        improved = true;
        if (cur.bestScore === 0) break;
      }
    }
    if (!improved) break;
  }
  return { ...cur, rounds: used, tokens };
}

// ---------- 用户编辑后重跑：给定用户改过的泛化/规避列表，适配出全过的正则 ----------
// 用户新增句子后不是简单回测，而是把用户列表当作新的验证集，走同一套 变体搜索+增量修复 管线
export async function adaptToUserLists(q, general, negatives, { prevRegex = '', rounds = 6, log = () => { } } = {}) {
  const t0 = Date.now();
  if (!general.length || !negatives.length) throw new Error('泛化与规避列表不能为空');

  // 1) 词元：本地推导（结合新列表自适应提取 left/right/obj），并继承旧正则的核心词分支
  const tokens = deriveTokensLocally(q, general, negatives);
  if (prevRegex) {
    const m = prevRegex.match(/\(([^()]+)\)\(\(\?!/) || prevRegex.match(/\(([^()]+)\)\(\?:/);
    const coreFromPrev = m ? m[1].split('|').map(s => s.trim())
      .filter(s => s && s.length <= 4 && !/^[一二两三四五六七八九十半几多每个条]+$/.test(s) && !/^(下来|起来|出来|上去|弄|搞|办|处理|给|已经|都|搞定|弄好|办妥|这|那)$/.test(s)) : [];
    for (const w of coreFromPrev) if (!tokens.core.includes(w)) tokens.core.push(w);
  }
  log(`词元: core=[${tokens.core.join(',')}] left=${tokens.left.length}词 right=[${tokens.right.join(',')}]`);

  // 2) 变体搜索 + 增量修复（用户列表为验证集；上限默认 6 轮，适配新句子余量更大）
  const rep = repairSearch(tokens, general, negatives, { rounds, log });
  if (rep.bestScore !== 0) {
    const miss = rep.best.general.filter(x => !x.hit).map(x => x.text);
    const falseHit = rep.best.negatives.filter(x => x.hit).map(x => x.text);
    const reason = `适配未收敛：泛化未中 ${miss.length}（${miss.slice(0, 3).join('、')}），规避误中 ${falseHit.length}（${falseHit.slice(0, 3).join('、')}）`;
    log(reason);
    return { regex: rep.bestRegex, verified: rep.best, ok: false, reason, rounds: rep.rounds, elapsedMs: Date.now() - t0 };
  }
  return { regex: rep.bestRegex, verified: rep.best, ok: true, reason: '', rounds: rep.rounds, elapsedMs: Date.now() - t0 };
}

// ---------- 主流程 ----------
export async function generateOne(q, { rounds = 4, retryHint = 1, log = () => { } } = {}) {
  const t0 = Date.now();
  const NOTHINK = { chat_template_kwargs: { enable_thinking: false }, response_format: { type: 'json_object' } };
  // 重试递进：retryHint>1 时提高采样温度换一批列表、放宽每句字数；修复轮上限同步提高
  const temp = retryHint > 1 ? Math.min(0.9, 0.4 + 0.2 * (retryHint - 1)) : 0.4;
  const maxLen = retryHint > 1 ? 18 : 15;
  const effRounds = retryHint > 1 ? rounds + 2 * (retryHint - 1) : rounds;
  const listPrompt = retryHint > 1
    ? LIST_PROMPT(q).replace('每句不超过 15 个字', `每句不超过 ${maxLen} 个字`) + `\n【重试注意】上一轮结果未能通过验证，请换一组更贴近口语、且核心动词字面突出的说法。`
    : LIST_PROMPT(q);

  // 第一段：意图 + 泛化 + 规避（三次尝试：先关思考求快，再开思考求稳）
  let lists = null, srcErr = '';
  for (let attempt = 1; attempt <= 3 && !lists; attempt++) {
    try {
      if (attempt > 1) await new Promise(r => setTimeout(r, 1000));
      const r1 = await chat([{ role: 'user', content: listPrompt }],
        { maxTokens: 2400, temperature: temp, extra: attempt === 1 ? NOTHINK : { response_format: { type: 'json_object' } }, timeoutMs: 70000 });
      const p = parseJSONLoose(r1.text);
      if (!p || !Array.isArray(p.general) || !Array.isArray(p.negatives)) throw new Error('列表格式不符');
      lists = p;
    } catch (e) { srcErr = e.message; }
  }

  if (!lists) {
    log(`LLM 生成失败（${srcErr}），使用本地兜底`);
    return fallback(q, t0, srcErr);
  }

  const general = lists.general.map(s => String(s).trim()).filter(s => !badItem(s));
  const negatives = lists.negatives.map(s => String(s).trim()).filter(s => !badItem(s));
  if (general.length < 5 || negatives.length < 3) {
    log(`LLM 列表过少（泛化${general.length}/规避${negatives.length}），使用本地兜底`);
    return fallback(q, t0, '列表条数不足', general, negatives);
  }

  // 词元：小调用（快、输出小），失败则本地推导——不阻塞主链路
  let tokens = null;
  try {
    const r2 = await chat([{ role: 'user', content: TOKENS_PROMPT(q, general, negatives) }],
      { maxTokens: 600, temperature: 0.2, extra: NOTHINK, timeoutMs: 60000 });
    tokens = normalizeTokens(parseJSONLoose(r2.text));
    if (tokens) log('词元(来自LLM): ' + JSON.stringify(tokens));
  } catch { /* 本地推导 */ }
  if (!tokens) { tokens = deriveTokensLocally(q, general, negatives); log('词元(本地推导): ' + JSON.stringify(tokens)); }

  // 变体搜索 + 增量修复
  const rep = repairSearch(tokens, general, negatives, { rounds: effRounds, log });
  const passed = rep.bestScore === 0;
  if (!passed) {
    const miss = rep.best.general.filter(x => !x.hit).length;
    const falseHit = rep.best.negatives.filter(x => x.hit).length;
    log(`修复未收敛：泛化未中 ${miss}，规避误中 ${falseHit} —— 标记为未通过，不作为合格交付`);
  }

  return {
    intent: String(lists.intent || '').trim() || `用户问句「${q}」的意图陈述`,
    notes: String(lists.notes || '').trim(),
    general, negatives, regex: rep.bestRegex,
    verified: rep.best, rounds: rep.rounds, source: 'llm+engine',
    passed, elapsedMs: Date.now() - t0,
  };
}

function normalizeTokens(t) {
  if (!t || typeof t !== 'object') return null;
  const arr = x => Array.isArray(x) ? x.map(s => String(s).trim()).filter(Boolean) : [];
  const out = { core: arr(t.core), state: arr(t.state), left: arr(t.left), right: arr(t.right), obj: arr(t.obj), rightDist: Number(t.rightDist) || 12 };
  if (!out.core.length) return null;
  if (!out.state.length) out.state = ['好', '完', '过', '了'];
  if (!out.right.length) out.right = ['吗', '没有', '怎么'];
  return out;
}

// ---------- 本地兜底（LLM 不可用时保底可用；同一条搜索修复管线，不硬凑） ----------
function fallback(q, t0, err, gList, nList) {
  const core0 = q.replace(/[我你他她它您吗呢吧呀啊啦哦哈的了个这那有和跟就是也都很被把让向对着说完\s]/g, '') || q;
  const general = (gList && gList.length ? gList : [q, `我已经${core0}了`, `${core0}了`, `已经${q}`, `${q}呀`].filter(Boolean));
  // 自适应负例：正例（问句/泛化）本身含疑问词时，用同款疑问词做规避模板必然误杀（关键词正则无法区分
  // 「保单什么时候生效」与「我怎么生效」）——此时换成右扫可挡的模板（吗/没有/链接）
  const qHasQW = /[什么时候怎么哪如何]/.test(q) || (gList || []).some(s => /[什么时候怎么哪如何]/.test(s));
  const negatives = (nList && nList.length ? nList :
    [`我没${core0}`, `不用${core0}`, `${core0}了吗`, `${core0}了没有`, qHasQW ? `${core0}进度怎么样了` : `怎么${core0}`,
     `先别${core0}`, `我去${core0}`, `${core0}的链接发我`, `别${core0}`, `先${core0}`].slice(0, 10));
  // 先定列表再推词元：right/left 的自适应提取依赖规避案例文本
  const tokens = deriveTokensLocally(q, general, negatives);
  const rep = repairSearch(tokens, general, negatives, { rounds: 4 });
  return {
    intent: `（兜底）用户陈述：${q}`, notes: 'LLM 不可用，本地兜底生成，结果可能不达标',
    general, negatives, regex: rep.bestRegex,
    verified: rep.best, rounds: rep.rounds, source: 'fallback', passed: rep.bestScore === 0,
    error: err, elapsedMs: Date.now() - t0,
  };
}

// CLI 自测：node server/gen.mjs "我下载了这个app"
if (import.meta.url === `file://${process.argv[1]}`) {
  const q = process.argv[2] || '我下载了这个app';
  console.log(`[gen] 问句：${q}`);
  generateOne(q, { log: console.log }).then(r => {
    console.log('意图:', r.intent, '| 来源:', r.source, '| 修复轮数:', r.rounds, '| 耗时:', r.elapsedMs, 'ms');
    console.log('正则:', r.regex);
    console.log('验证:', r.verified.ok ? '全部通过 ✔' : '未全部通过 ✘');
    if (!r.verified.ok) {
      r.verified.general.filter(x => !x.hit).forEach(x => console.log('  未命中:', x.text));
      r.verified.negatives.filter(x => x.hit).forEach(x => console.log('  误中:', x.text, '片段:', x.seg));
    }
    console.log('泛化', r.general.length, '条;', '规避', r.negatives.length, '条');
    process.exit(0);
  }).catch(e => { console.error(e); process.exit(1); });
}
