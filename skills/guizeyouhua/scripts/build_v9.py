# -*- coding: utf-8 -*-
"""build_v9.py —— 在 v8 基础上补入知识库两类问题

新增：
  【问题一】框架内未命中   市民命中知识库条目，但 AI 未按该条目去向推进
  【问题二】框架外意图     市民明确发问/诉求，知识库 290 条一条都没匹配上
静态：
  【死条目】               知识库有该意图，但既无正则也无相似问法，结构上永不可能命中
"""
import json, re, collections

W = __import__("sys").argv[1] if len(__import__("sys").argv) > 1 else "<WORKSPACE>/work"
OUT = f"{W}/byai-calls"

v8 = json.load(open(f"{OUT}/v8_tables.json"))
KBP = json.load(open(f"{OUT}/kb_parsed.json"))
iF = json.load(open(f"{OUT}/kb_inframe2.json"))
oF = json.load(open(f"{OUT}/kb_outframe2.json"))
kbst = json.load(open(f"{OUT}/kb_stat2.json"))

BOT = {"2161410": "通用劝阻", "420469": "投资理财", "420445": "刷单兼职"}
DEF = {"默认", "兜底", "其他"}


def clean(t, n=60):
    return re.sub(r"\s+", " ", (t or "").strip())[:n]


def top(counter, n=6):
    ps = [f"{t}（{c}次）" for t, c in counter.most_common(n)]
    return " ｜ ".join(ps) if ps else "—"


detail = v8["detail"]

# ============ 问题一：框架内未命中 ============
g1 = collections.defaultdict(lambda: {"n": 0, "texts": collections.Counter(),
                                      "kb": "", "tgt": "", "act": ""})
for r in iF:
    k = (r["bot"], r["node"], r["kb"], r["kbTarget"])
    g1[k]["n"] += 1
    g1[k]["texts"][clean(r["text"])] += 1
    g1[k]["kb"] = r["kb"]
    g1[k]["tgt"] = r["kbTarget"]
    g1[k]["act"] = r["actual"]

for (bt, node, kbname, tgt), v in sorted(g1.items(), key=lambda kv: -kv[1]["n"]):
    detail.append({
        "问题类型": "5-知识库命中却未按意图走",
        "话术": bt, "节点": node,
        "问题描述": f"市民话术命中知识库「{kbname}」，该条目的去向是「{tgt}」，"
                    f"AI 实际仍在「{v['act']}」——知识库条目存在但未生效（优先级被节点分支抢占）",
        "出现次数": v["n"], "错误问句": top(v["texts"]),
    })

# ============ 问题二：框架外意图 ============
g2 = collections.defaultdict(lambda: {"n": 0, "texts": collections.Counter(),
                                      "reply": collections.Counter()})
for r in oF:
    k = (r["bot"], r["node"], r.get("tag", "其他"))
    g2[k]["n"] += 1
    g2[k]["texts"][clean(r["text"])] += 1
    g2[k]["reply"][clean(r["aiReply"], 40)] += 1

for (bt, node, tag), v in sorted(g2.items(), key=lambda kv: -kv[1]["n"]):
    if v["n"] < 5:
        continue
    detail.append({
        "问题类型": "6-框架外意图（知识库无匹配）",
        "话术": bt, "节点": node,
        "问题描述": f"市民{tag}，知识库 290 条无一条匹配，AI 仍按固定话术回答："
                    f"{top(v['reply'], 2)}",
        "出现次数": v["n"], "错误问句": top(v["texts"]),
    })

detail.sort(key=lambda x: -x["出现次数"])
for i, d in enumerate(detail, 1):
    d["序号"] = i

# ============ 静态：知识库死条目 ============
dead = []
for bid in ("2161410", "420469", "420445"):
    for e in KBP[bid]:
        if e["keywords"] or e["similars"]:
            continue
        dead.append({
            "话术": bid,
            "知识库条目": e["title"] or e["standard"],
            "标准问法": e["standard"],
            "正则": "（空）",
            "相似问法": "（空）",
            "配置去向": e["target"] or "（无）",
            "影响": "有去向却永远无法命中" if e["target"] else "无去向，命中也不会跳转",
        })
dead.sort(key=lambda x: (x["话术"], x["知识库条目"]))

# ============ 概览统计 ============
stat2 = {
    "kb_total": sum(len(KBP[b]) for b in KBP),
    "kb_dead": len(dead),
    "kb_dead_with_target": sum(1 for d in dead if d["配置去向"] != "（无）"),
    "inframe": len(iF),
    "outframe": len(oF),
    "outframe_ask": sum(1 for r in oF if r.get("tag") == "主动发问"),
    "outframe_demand": sum(1 for r in oF if r.get("tag") == "诉求/质疑"),
}

v8["detail"] = detail
v8["deadkb"] = dead
v8["kbst"] = stat2
json.dump(v8, open(f"{OUT}/v9_tables.json", "w"), ensure_ascii=False, indent=1)

print(f"问题明细 {len(detail)} 行")
for k, v in collections.Counter(d["问题类型"] for d in detail).most_common():
    print(f"  {k}: {v}")
print(f"\n知识库死条目 {len(dead)} 条（其中 {stat2['kb_dead_with_target']} 条有去向却永不可能命中）")
print(f"框架内未命中 {len(iF)} 次 / 框架外意图 {len(oF)} 次"
      f"（主动发问 {stat2['outframe_ask']}、诉求质疑 {stat2['outframe_demand']}）")
