# -*- coding: utf-8 -*-
"""tree.py —— 把话术包解析成"决策树节点"序列（规则版话术的正确形态）

核心认识（此前一直搞错）：
  每个业务节点不是"一个有若干分支的平面节点"，而是一棵**决策树**。
  树的每个节点 = 一句固定话术 + 若干分支，每个分支有自己的关键词和去向。
  420469「询问是否安装理财软件」实际有 37 条话术 / 46 个分支，构成一棵 5 层树。

所以巡检的正确单元是"树节点"(step)，判定是：
  用户说了 X → 在当前树节点跑各分支正则 → 命中哪个分支 → 该分支的去向
  → 比对该去向与 AI 下一句实际所在的位置
"""
import json
from collections import defaultdict

S = (__import__("sys").argv[2] if len(__import__("sys").argv) > 2 else "<WORKSPACE>/work/byai-scripts")
OUT = (__import__("sys").argv[1] if len(__import__("sys").argv) > 1 else "<WORKSPACE>/work/byai-calls")


def parse_dnb(dnb, node, path, steps, texts_out):
    """把一个决策节点展开成若干 step（每个 step = 一句话术 + 它的分支集合）。"""
    txts = [(it.get("knowledge") or "").strip()
            for it in (dnb.get("decisionItemList") or [])
            if (it.get("knowledge") or "").strip()]

    # 节点级关键词（作用于本层的分支）
    nk = {}
    try:
        nk = json.loads(dnb.get("answerKeywordDef") or "{}") or {}
    except Exception:
        pass

    # 该决策树层级的 answerRegexSide：分支名 -> 引用的全局具名分支列表
    side_map = {}
    _s = dnb.get("answerRegexSide")
    if _s and _s not in ("{}", ""):
        try:
            side_map = json.loads(_s) or {}
        except Exception:
            side_map = {}

    edges = []
    for ch in dnb.get("childrenList") or []:
        br = (ch.get("answerIds") or [None])[0]
        if not br:
            continue
        tgt = None
        ap = ch.get("actionParam")
        if ap:
            try:
                tgt = json.loads(ap).get("sceneNodeName")
            except Exception:
                tgt = ap
        kws = []
        try:
            own = json.loads(ch.get("answerKeywordDef") or "{}") or {}
            if own.get(br):
                kws = list(own[br])
        except Exception:
            pass
        if not kws and nk.get(br):
            kws = list(nk[br])
        edges.append({
            "branch": br,
            "target": tgt,
            "keywords": kws,
            "regex_side": list(side_map.get(br) or []),
            "child": ch,
        })

    # 一句话术对应一个 step
    for t in txts:
        steps.append({
            "id": f"{node}|{'/'.join(path)}|{len(steps)}",
            "node": node,
            "path": "/".join(path) if path else "(root)",
            "text": t,
            "edges": [{"branch": e["branch"], "target": e["target"],
                       "keywords": e["keywords"], "regex_side": e["regex_side"]}
                      for e in edges],
        })
        texts_out.append(t)

    # 递归进每个分支的子树
    for e in edges:
        parse_dnb(e["child"], node, path + [e["branch"]], steps, texts_out)


def build(bid):
    b = json.load(open(f"{S}/bot_{bid}_bundle.json"))
    layers = {}
    for layer in ("flow", "multi"):
        id2name = {n["sceneNodeId"]: n["sceneNodeName"] for n in b[layer]["nodes"]}
        steps = []
        for t in b[layer]["trees"]:
            nd = t.get("node") or {}
            tr = t.get("tree") or {}
            dnb = tr.get("decisionNodeBO") or {}
            nid = nd.get("sceneNodeId") or dnb.get("sceneNodeId")
            name = id2name.get(nid)
            if not name:
                continue
            parse_dnb(dnb, name, [], steps, [])
        layers[layer] = steps

    kb = [{
        "question": k.get("question"),
        "node": k.get("node"),
        "action": k.get("action"),
        "keyword": k.get("keyword"),
    } for k in (b.get("knowledgeBase") or [])]

    return {"botId": bid, "layers": layers, "kb": kb}


def main():
    allg = {}
    for bid in ("2161410", "420469", "420445"):
        g = build(bid)
        allg[bid] = g
        for lay, steps in g["layers"].items():
            ne = sum(len(s["edges"]) for s in steps)
            kw = sum(len(e["keywords"]) for s in steps for e in s["edges"])
            print(f"{bid} {lay}: step {len(steps):4d} 分支 {ne:4d} 关键词 {kw:4d}")
    json.dump(allg, open(f"{OUT}/flow_tree.json", "w"), ensure_ascii=False)
    print("\nsaved flow_tree.json")

    steps = allg["420469"]["layers"]["flow"]
    print(f"\n420469 flow 前 6 个 step:")
    for s in steps[:6]:
        print(f"  [{s['node']}] path={s['path']}")
        print(f"    话术: {s['text'][:48]}")
        print(f"    分支: {[(e['branch'], e['target'] or '原地', len(e['keywords'])) for e in s['edges']]}")


if __name__ == "__main__":
    main()
