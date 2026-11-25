# -*- coding: utf-8 -*-
"""kb.py —— 解析三套知识库，输出可判定的条目清单。

知识库条目结构（bundle.knowledgeBase[]）：
  standardQuestion    标准问法（如"你贵姓"）
  similarityQuestion  相似问法，逗号分隔（如"开会,正在忙,在开会"）
  keyword             正则（可为字符串或 list），只有 133/290 条有
  action / actionParam 命中后的去向（action=3 表示跳转 sceneNodeName）
  answerList[].knowledge 机器人回答

判定两类问题的依据：
  问题一（框架内未命中）：市民话术语义落在某条知识库的意图内（靠标准/相似问法），
        但实际既没被该条正则命中，也没走到该条对应节点 -> 知识库/正则覆盖不足
  问题二（框架外意图）：市民话术表达了明确意图，但知识库里没有任何一条与之匹配，
        而 AI 却给出了某个答复（往往答非所问）-> 框架外意图
"""
import json, re

S = (__import__("sys").argv[2] if len(__import__("sys").argv) > 2 else "<WORKSPACE>/work/byai-scripts")
OUT = (__import__("sys").argv[1] if len(__import__("sys").argv) > 1 else "<WORKSPACE>/work/byai-calls")


def norm(s):
    return re.sub(r"[\s，。！？、,.!?…~—\-·；：\"'（）()【】\[\]]", "", s or "")


def parse_kw(kw):
    """keyword 可能是字符串、list、或 None。统一成 list。空字符串/[] 视为无。"""
    if not kw:
        return []
    if isinstance(kw, str) and kw.strip() in ("", "[]", "null", "None"):
        return []
    if isinstance(kw, list):
        out = []
        for x in kw:
            if isinstance(x, str):
                out.extend([p.strip() for p in x.split(",") if p.strip()])
            elif isinstance(x, dict):
                v = x.get("keyword")
                if v:
                    out.append(v)
        return out
    if isinstance(kw, str):
        return [p.strip() for p in kw.split(",") if p.strip()]
    return []


def build(bid):
    b = json.load(open(f"{S}/bot_{bid}_bundle.json"))
    out = []
    for k in b.get("knowledgeBase") or []:
        std = (k.get("standardQuestion") or "").strip()
        sim = k.get("similarityQuestion")
        sims = []
        if isinstance(sim, list):
            sims = [str(x).strip() for x in sim if str(x).strip()]
        elif isinstance(sim, str):
            s2 = sim.strip()
            # 脏数据：'[]' / 'null' / 'None' 表示"没有相似问法"
            if s2 not in ("", "[]", "null", "None", "[ ]"):
                if s2.startswith("["):
                    try:
                        arr = json.loads(s2)
                        sims = [str(x).strip() for x in arr if str(x).strip()]
                    except Exception:
                        sims = [x.strip() for x in re.split(r"[,，]", s2) if x.strip()]
                else:
                    sims = [x.strip() for x in re.split(r"[,，]", s2) if x.strip()]
        sims = [x for x in sims if x not in ("[]", "null", "None")]

        tgt = None
        ap = k.get("actionParam")
        if ap:
            try:
                tgt = json.loads(ap).get("sceneNodeName")
            except Exception:
                tgt = None

        answers = []
        for a in k.get("answerList") or []:
            ks = (a.get("knowledge") or "").strip()
            if ks:
                answers.append(ks)

        out.append({
            "id": k.get("knowledgeBaseId"),
            "title": (k.get("title") or "").strip(),
            "standard": std,
            "similars": sims,
            "keywords": parse_kw(k.get("keyword")),
            "action": k.get("action"),
            "target": tgt,
            "answers": answers,
        })
    return out


def main():
    allkb = {}
    for bid in ("2161410", "420469", "420445"):
        kb = build(bid)
        allkb[bid] = kb
        nkw = sum(1 for x in kb if x["keywords"])
        nsim = sum(1 for x in kb if x["similars"])
        print(f"{bid}: {len(kb)} 条 | 有正则 {nkw} | 有相似问法 {nsim} | 有去向 {sum(1 for x in kb if x['target'])}")
    json.dump(allkb, open(f"{OUT}/kb_parsed.json", "w"), ensure_ascii=False, indent=1)
    print("\nsaved kb_parsed.json")

    print("\n=== 2161410 前 5 条 ===")
    for x in allkb["2161410"][:5]:
        print(f"  [{x['title'] or x['standard']}]")
        print(f"    标准问法: {x['standard']}")
        print(f"    相似问法: {x['similars'][:4]}")
        print(f"    正则: {x['keywords'][:2]}")
        print(f"    去向: {x['target']}")


if __name__ == "__main__":
    main()
