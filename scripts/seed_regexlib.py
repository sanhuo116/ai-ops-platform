# -*- coding: utf-8 -*-
"""从已抓取的全量数据生成平台种子库（67966 租户正则库+问题库）。

来源：
  work/byai-branch/branches_raw.json  全局分支库 327 个（companyId=67966）
  work/byai-branch/questions_raw.json 问题库 128 个（companyId=67966）
"""
import json, os

W = os.path.expanduser("~/Documents/deepseek-harness/default-workspace")
OUT = f"{W}/regex-opt-platform/data/seed"

branches = json.load(open(f"{W}/work/byai-branch/branches_raw.json"))
questions = json.load(open(f"{W}/work/byai-branch/questions_raw.json"))

def rows(src, kind):
    out = []
    for x in src:
        l, d = x.get("list") or {}, x.get("detail") or {}
        kws = []
        for k in (d.get("keywordList") or []):
            kw = (k.get("keyword") or "").strip()
            if kw:
                kws.append({"id": k.get("id"), "text": kw})
        out.append({
            "id": d.get("id") or l.get("id"),
            "kind": kind,
            "name": (d.get("name") or l.get("name") or "").strip(),
            "label": (d.get("labelName") or "未分类").strip(),
            "scenes": d.get("botSceneNames") or [],
            "status": d.get("status"),
            "kwCount": len(kws),
            "kwList": kws,
            "gmtModified": d.get("gmtModified"),
        })
    return out

lib = {"branches": rows(branches, "branch"), "questions": rows(questions, "question")}
os.makedirs(OUT, exist_ok=True)
json.dump(lib, open(f"{OUT}/regexlib.json", "w"), ensure_ascii=False, indent=1)

bk, qk = sum(x["kwCount"] for x in lib["branches"]), sum(x["kwCount"] for x in lib["questions"])
print(f"分支库 {len(lib['branches'])} 组 / {bk} 条正则")
print(f"问题库 {len(lib['questions'])} 组 / {qk} 条正则")
print("saved", f"{OUT}/regexlib.json")
