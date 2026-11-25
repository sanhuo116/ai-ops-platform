# -*- coding: utf-8 -*-
"""build_v8.py —— 决策树口径的最终巡检数据（保留原表结构）

判定逻辑（规则版话术，精确可判）：
  1. AI 话术与话术包原文精确匹配 -> 定位到具体 step（一句固定话术 + 其分支集合）
  2. 用户回复在该 step 的各分支正则上跑
  3. 命中分支 -> 该分支去向（childrenList.actionParam.sceneNodeName）
  4. 比对 AI 下一句所在的 step
  5. 排除三类正常行为：
       - step 只有默认/原地分支（纯告知话术，72.6%）
       - 分支去向为 None 且在节点内顺序推进（树内续说）
       - 开场白节点回"喂/你好"（正常接听）
"""
import json, re, collections

W = __import__("sys").argv[1] if len(__import__("sys").argv) > 1 else "<WORKSPACE>/work"
OUT = f"{W}/byai-calls"

problems = json.load(open(f"{OUT}/tree_problems.json"))
gaps = json.load(open(f"{OUT}/tree_gaps.json"))
stat = json.load(open(f"{OUT}/tree_stat.json"))
tree = json.load(open(f"{OUT}/flow_tree.json"))
LIB = json.load(open(f"{OUT}/branch_lib_kw.json"))

DEF = {"默认", "兜底", "其他"}
BOT = {"2161410": "通用劝阻", "420469": "投资理财", "420445": "刷单兼职"}


def clean(t):
    return re.sub(r"\s+", " ", (t or "").strip())[:60]


def top(counter, n=6, wc=True):
    ps = [f"{t}（{c}次）" if wc else t for t, c in counter.most_common(n)]
    return " ｜ ".join(ps) if ps else "—"


def lib_n(b):
    v = LIB.get(b)
    if not v:
        return 0
    k = v.get("keywords")
    return len(k) if isinstance(k, list) else 0


GREET_RE = re.compile(r"^(喂|你好|喂喂|哎|诶|啊|哦|嗯|嗯嗯)+$")


def is_greet(t):
    s = re.sub(r"[\s，。！？、,.!?…~—·]", "", t or "")
    return bool(s) and len(s) <= 8 and GREET_RE.match(s)


SEM = [
    ("接听", r"^(喂|你好|哎|诶|啊|哦|嗯|呣|唔)[。！!，,]?$"),
    ("否定", r"^(没|不|无|未|也没|没有|并没有)"),
    ("肯定", r"^(对|是|好|行|可以|嗯对|没错|ok|OK)"),
    ("知晓", r"^(明白|知道|清楚|了解|懂了|记住|晓得了)"),
    ("礼貌", r"^(谢谢|感谢|辛苦了)"),
]


def sem_of(t):
    s = re.sub(r"[\s，。！？、,.!?…~—·]", "", t or "")
    for name, pat in SEM:
        if re.search(pat, s):
            return name
    return "其他"


# 找 step 定义
STEP = {}
for bid in tree:
    for lay in ("flow", "multi"):
        for s in tree[bid]["layers"][lay]:
            STEP[(bid, s["node"], s["path"])] = s

# ================= 问题明细 =================
detail = []

# 类型 1/2：跳跃判定错误
g12 = collections.defaultdict(lambda: {"n": 0, "texts": collections.Counter()})
for r in problems:
    k = (r["kind"], r["bot"], r["node"], r["expected"], r["actual"])
    g12[k]["n"] += 1
    g12[k]["texts"][clean(r["text"])] += 1
for (kind, bt, node, exp, act), v in sorted(g12.items(), key=lambda kv: -kv[1]["n"]):
    detail.append({
        "问题类型": kind, "话术": bt, "节点": node,
        "问题描述": f"本应走向「{exp}」，实际走向「{act}」",
        "出现次数": v["n"], "错误问句": top(v["texts"]),
    })

# 类型 3：该命中却未命中（弱监督可反推分支）
gap = collections.defaultdict(collections.Counter)
gap_sem = collections.defaultdict(collections.Counter)
skip_greet = 0
for r in gaps:
    if not r["cands"]:
        continue
    if is_greet(r["text"]) and r["node"] == "开场白":
        skip_greet += 1
        continue
    for br in r["cands"].split(","):
        if not br or br in DEF:
            continue
        k = (r["bot"], r["node"], br)
        gap[k][clean(r["text"])] += 1
        gap_sem[k][sem_of(r["text"])] += 1

for (bt, node, br), cnt in gap.items():
    n = sum(cnt.values())
    if n < 30:
        continue
    # 找该分支定义
    tgt, own = None, 0
    for (b, nd, p), s in STEP.items():
        if b != bt or nd != node:
            continue
        for e in s["edges"]:
            if e["branch"] == br:
                if e["target"] or tgt is None:
                    tgt = e["target"] or tgt
                own = max(own, len(e.get("keywords") or []))
    ln = lib_n(br)
    has = "两侧均无关键词" if (own == 0 and ln == 0) else f"已有本节点{own}条 / 全局库{ln}条，覆盖不足"
    semdesc = "、".join(f"{k}{v}句" for k, v in gap_sem[(bt, node, br)].most_common(4))
    detail.append({
        "问题类型": "3-该命中分支却未命中", "话术": bt, "节点": node,
        "问题描述": f"分支【{br}】→「{tgt or '原地'}」，{has}；AI 实际已按该分支推进。语义构成：{semdesc}",
        "出现次数": n, "错误问句": top(cnt),
    })

detail.sort(key=lambda x: -x["出现次数"])

# ================= 优化建议 =================
ALLOW = {
    "肯定": {"肯定", "接听"}, "否定": {"否定", "接听"},
    "未受骗": {"否定", "接听"}, "拒绝": {"否定"}, "有收益": {"肯定"},
}
SEM_TMPL = {
    "否定": [r"^(没有|没|不用|不需要|没兴趣|不感兴趣|不考虑)[。！!，,]?$",
             r"^(没有|没)[，,]?(没有|没)+[。！!]?$"],
    "肯定": [r"^(对|是|对呀|是的|对啊)[。！!，,]?$",
             r"^(好|行|可以|好的|好呀|行吧)[。！!，,]?$"],
    "知晓": [r"^(明白|知道了|清楚了|了解了|懂了|晓得了)(了|啊|呀)?[。！!，,]?$"],
    "礼貌": [r"^(谢谢|感谢|辛苦了|好的?谢谢)[。！!，,]?$"],
    "接听": [r"^(喂|喂喂|你好|哎|诶|啊|哦|嗯)[。！!，,]?$"],
}

kw_rows = []
PURE = re.compile(r"^(嗯|哦|啊|呃|诶|哎|喂|嗯嗯|哦哦|啊啊|喂喂|嗯嗯嗯)?$")


def punc(t):
    return re.sub(r"[\s，。！？、,.!?…~—·]", "", t or "")


for (bt, node, br), cnt in sorted(gap.items(), key=lambda kv: -sum(kv[1].values())):
    n = sum(cnt.values())
    if n < 30:
        continue
    # 若样本以纯语气词为主（>55%），说明这是"用户只是应了一声"，
    # AI 走哪个分支都不算错，不构成关键词缺陷
    pure = sum(c for t, c in cnt.items() if PURE.match(punc(t)))
    if pure / n > 0.55:
        continue
    allowed = ALLOW.get(br, {"肯定", "否定"})
    # 该分支样本里，与本分支语义相符的比例
    semd = gap_sem[(bt, node, br)]
    match_share = sum(c for sm, c in semd.items() if sm in allowed) / max(1, n)
    if match_share < 0.35:
        # 用户说的话大多与这个分支语义对不上 -> 疑似分支关键词/语义配错，
        # 而不是"缺词"，不给补词建议，改报配置质疑
        detail.append({
            "问题类型": "4-分支语义疑似配错", "话术": bt, "节点": node,
            "问题描述": f"分支【{br}】被触发 {n} 次，但用户话术仅 {match_share*100:.0f}% 与该分支语义相符"
                        f"（{'、'.join(f'{k}{v}句' for k, v in semd.most_common(3))}），疑似关键词指向了错误分支",
            "出现次数": n, "错误问句": top(cnt),
        })
        continue
    chosen = []
    for sem, c in gap_sem[(bt, node, br)].most_common():
        if c / n < 0.05 or sem not in allowed:
            continue
        if sem == "接听" and node != "开场白":
            continue
        for p in SEM_TMPL.get(sem, [])[:2]:
            if p not in chosen:
                chosen.append(p)
    # 补充实测高频整句（限语义明确、长度<=6、且当前确实未命中的）
    if not chosen:
        continue
    ln = lib_n(br)
    own = 0
    tgt = None
    for (b, nd, p), s in STEP.items():
        if b == bt and nd == node:
            for e in s["edges"]:
                if e["branch"] == br:
                    own = max(own, len(e.get("keywords") or []))
                    tgt = e["target"] or tgt
    kw_rows.append({
        "话术": bt, "层": "flow", "节点": node, "分支": br,
        "目标节点": tgt or "（原地）",
        "原版本关键词": "（空）" if (own == 0 and ln == 0) else f"本节点{own}条 / 全局库{ln}条",
        "优化后关键词": " ｜ ".join(chosen),
        "新增条数": len(chosen),
        "来源": f"通话漏判 {n} 句；语义构成 " + "、".join(f"{k}{c}句" for k, c in gap_sem[(bt, node, br)].most_common(3)),
        "失败证据": top(cnt, 6, False),
        "涉及句次": n,
    })
kw_rows.sort(key=lambda x: -x["涉及句次"])
for i, r in enumerate(kw_rows, 1):
    r["序号"] = i

# ================= 结构缺口 =================
struct = []
seen = set()
for bid in ("2161410", "420469", "420445"):
    for lay in ("flow", "multi"):
        for s in tree[bid]["layers"][lay]:
            for e in s["edges"]:
                if e["branch"] in DEF:
                    continue
                own = len(e.get("keywords") or [])
                side = e.get("regex_side") or []
                side_n = sum(len((LIB.get(x) or {}).get("keywords") or []) for x in side)
                if own == 0 and side_n == 0 and lib_n(e["branch"]) == 0:
                    k = (bid, s["node"], e["branch"])
                    if k in seen:
                        continue
                    seen.add(k)
                    struct.append({"话术": bid, "层": lay, "节点": s["node"],
                                   "分支": e["branch"],
                                   "目标节点": e["target"] or "（原地续说）"})
# ================= 弱肯定误判（全局库规则缺陷） =================
WEAK = re.compile(r"^(嗯|哦|啊|呃|诶|哎|喂|好|行|对|是)$")


def strip_punc(t):
    return re.sub(r"[\s，。！？、,.!?…~—·]", "", t or "")


weak_stat = collections.Counter()
weak_examples = {}
for r in problems:
    if "肯定" not in (r.get("branches") or ""):
        continue
    s0 = strip_punc(r["text"])
    if WEAK.match(s0):
        weak_stat[(r["bot"], r["node"], s0)] += 1
        weak_examples.setdefault((r["bot"], r["node"], s0), (r.get("expected"), r.get("actual")))

weak_rows = []
for (bt, node, s0), n in weak_stat.most_common():
    if n < 20:
        continue
    exp, act = weak_examples[(bt, node, s0)]
    weak_rows.append({
        "话术": bt, "节点": node, "误判话术": r["text"] if False else s0,
        "错误被命中为": "肯定",
        "应属语义": "接听/语气", "出现次数": n,
        "问题描述": f"全局分支库【肯定】含 ^嗯。$ 这类规则，把纯语气应答判成肯定；本应去「{exp}」，实际去「{act}」",
        "建议": f"从全局【肯定】移除匹配「{s0}」的规则；纯语气应答应由【默认】处理",
    })
for i, w in enumerate(weak_rows, 1):
    w["序号"] = i

struct.sort(key=lambda x: (x["话术"], x["节点"]))

for i, _d in enumerate(detail, 1):
    _d["序号"] = i

json.dump({"detail": detail, "kw": kw_rows, "struct": struct, "weak": weak_rows, "stat": stat},
          open(f"{OUT}/v8_tables.json", "w"), ensure_ascii=False, indent=1)

print(f"（开场白纯接听已排除 {skip_greet} 句；无判定分支的 step 跳过 {stat.get('skipNoJudge', 0)} 次）")
print(f"问题明细 {len(detail)} 行")
for k, v in collections.Counter(d["问题类型"] for d in detail).most_common():
    print(f"  {k}: {v}")
print(f"优化建议 {len(kw_rows)} 条，覆盖 {sum(r['涉及句次'] for r in kw_rows)} 句")
print(f"结构缺口 {len(struct)} 个")
print(f"弱肯定误判 {len(weak_rows)} 组，涉及 {sum(w['出现次数'] for w in weak_rows)} 句")
print("\nTOP6:")
for d in detail[:6]:
    print(f"  [{d['出现次数']:6d}] {d['问题类型'][:2]} {BOT.get(d['话术'],d['话术'])} {d['节点']} :: {d['问题描述'][:50]}")
