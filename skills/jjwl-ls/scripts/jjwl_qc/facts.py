# -*- coding: utf-8 -*-
"""把提示词 + 知识库解析成结构化事实库。

本模块只做“结构化”，不做判断。质检规则在 rules.py 中消费这里的事实。

事实类型：
- PolicyClause  提示词“景区政策与服务信息”里的单条政策条款
- KBEntry       附件知识库的问答条目
- Announcement  临时公告
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

# 政策材料目录：从模块位置向上探测含「大模型提示词_全文.md」的 assets 目录。
# 兼容两种部署：<skill>/scripts/jjwl_qc/ 与 <job>/jjwl_qc/（平铺部署）。
def _find_assets() -> Path:
    here = Path(__file__).resolve().parent
    for base in (here, *here.parents):
        for cand in (base / "assets", base / "materials"):
            if (cand / "大模型提示词_全文.md").exists():
                return cand
    # 兜底：沿用原约定
    return here.parent.parent.parent / "assets"


ASSETS = _find_assets()
ROOT = ASSETS.parent
MATERIALS = ASSETS  # 兼容旧命名


@dataclass
class PolicyClause:
    clause_id: str
    section: str          # 门票与优惠 / 交通与费用 / 开放时间 / 自驾与预约 / 景区内位置说明
    name: str             # 粗体条款名，如 “进山通票”
    text: str             # 条款原文

    def to_dict(self):
        return {"clause_id": self.clause_id, "section": self.section,
                "name": self.name, "text": self.text}


@dataclass
class KBEntry:
    kb_id: str
    question: str
    answer: str

    def to_dict(self):
        return {"kb_id": self.kb_id, "question": self.question, "answer": self.answer}


@dataclass
class Announcement:
    title: str
    body: str

    def to_dict(self):
        return {"title": self.title, "body": self.body}


@dataclass
class FactBase:
    prompt_raw: str
    policy_clauses: List[PolicyClause] = field(default_factory=list)
    kb_entries: List[KBEntry] = field(default_factory=list)
    announcements: List[Announcement] = field(default_factory=list)
    rules_by_section: dict = field(default_factory=dict)
    output_rules: List[str] = field(default_factory=list)
    scenario_rules: dict = field(default_factory=dict)
    boundary_rules: List[str] = field(default_factory=list)
    disclaimer: str = ""

    # ---------- 查询辅助 ----------
    def clause(self, cid: str) -> Optional[PolicyClause]:
        for c in self.policy_clauses:
            if c.clause_id == cid:
                return c
        return None

    def clauses_in(self, section: str) -> List[PolicyClause]:
        return [c for c in self.policy_clauses if c.section == section]

    def stats(self) -> dict:
        return {
            "policy_clauses": len(self.policy_clauses),
            "kb_entries": len(self.kb_entries),
            "announcements": len(self.announcements),
            "output_rules": len(self.output_rules),
            "scenario_rules": len(self.scenario_rules),
            "prompt_chars": len(self.prompt_raw),
        }


# 提示词中的二级标题（政策章节）
_POLICY_SECTIONS = ["门票与优惠", "交通与费用", "开放时间", "自驾与预约", "景区内位置说明"]
# 提示词中的顶级章节
_TOP_SECTIONS = ["角色", "回答依据与边界", "临时公告", "当前日期与日期处理",
                 "景区政策与服务信息", "接待与输出", "场景处理"]

_BOLD_CLAUSE = re.compile(r"^-\s+\*\*(.+?)\*\*[：:]?\s*(.*)$")
_BULLET = re.compile(r"^-\s+(.*)$")
_ORDERED = re.compile(r"^(\d+)\.\s*(.*)$")


def _clean(text: str) -> str:
    return text.replace("\u200b", "").replace("\xa0", " ").strip()


# 没有独立标题、只是上一条款的子项（如音乐节优惠下的“景区门票/索道/酒店/餐饮/接驳”）
_SUBITEM_NAMES = {"景区门票", "庐山交通索道", "酒店", "餐饮", "免费接驳"}


def parse_prompt(text: str) -> FactBase:
    """解析大模型提示词全文。"""
    fb = FactBase(prompt_raw=text)
    lines = [_clean(l) for l in text.splitlines()]

    top = None      # 当前一级章节
    sub = None      # 当前二级章节

    for raw in lines:
        line = raw
        if line.startswith("# "):
            top = line[2:].strip()
            sub = None
            fb.rules_by_section.setdefault(top, [])
            continue
        if line.startswith("## "):
            sub = line[3:].strip()
            continue

        if top == "回答依据与边界" and _ORDERED.match(line):
            fb.boundary_rules.append(_ORDERED.match(line).group(2))
            continue

        if top == "接待与输出" and _ORDERED.match(line):
            fb.output_rules.append(_ORDERED.match(line).group(2))
            continue

        if top == "场景处理" and line.startswith("- **"):
            m = re.match(r"^-\s+\*\*(.+?)\*\*[：:]\s*(.*)$", line)
            if m:
                fb.scenario_rules[m.group(1)] = m.group(2)
                continue

        if top == "景区政策与服务信息" and sub in _POLICY_SECTIONS:
            if line.startswith("- **"):
                m = _BOLD_CLAUSE.match(line)
                if m:
                    name = m.group(1).strip()
                    # 音乐节等活动的子项并入上一条款，避免把子项当成独立政策
                    if name in _SUBITEM_NAMES and fb.policy_clauses \
                            and fb.policy_clauses[-1].section == sub:
                        prev = fb.policy_clauses[-1]
                        prev.text += "\n" + line
                    else:
                        fb.policy_clauses.append(PolicyClause(
                            clause_id=f"P{len(fb.policy_clauses)+1:03d}",
                            section=sub, name=name, text=line,
                        ))
                continue
            if line.startswith("- ") and sub == "门票与优惠":
                # “节日优惠”下的子项：1月10日警察节…
                fb.policy_clauses.append(PolicyClause(
                    clause_id=f"P{len(fb.policy_clauses)+1:03d}",
                    section=sub, name="节日优惠-" + line[2:].split("：")[0][:20],
                    text=line[2:],
                ))
            continue

        if top == "临时公告":
            if line and not line.startswith("## "):
                if line.startswith("## "):
                    continue
                fb.announcements.append(Announcement(title=sub or "", body=line))
            continue

    # 合并同一公告名下的多行
    merged = {}
    for a in fb.announcements:
        merged.setdefault(a.title, []).append(a.body)
    fb.announcements = [Announcement(t, "\n".join(b)) for t, b in merged.items()]

    fb.disclaimer = next((l for l in lines if l.startswith("**完整输出要求**")), "")
    return fb


def parse_kb(path: Path | None = None) -> List[KBEntry]:
    """读取附件知识库 xls。"""
    import pandas as pd
    p = path or (MATERIALS / "九江文旅知识库.xls")
    df = pd.read_excel(p, header=0)
    df.columns = [str(c).strip() for c in df.columns]
    qcol, acol = df.columns[0], df.columns[1]
    out = []
    for _, row in df.iterrows():
        q = _clean(str(row[qcol]))
        a = _clean(str(row[acol]))
        if not q or q.lower() == "nan":
            continue
        if a.lower() == "nan":
            a = ""
        out.append(KBEntry(kb_id=f"K{len(out)+1:04d}", question=q, answer=a))
    return out


def build_factbase() -> FactBase:
    prompt_p = MATERIALS / "大模型提示词_全文.md"
    fb = parse_prompt(prompt_p.read_text(encoding="utf-8"))
    fb.kb_entries = parse_kb()
    return fb


def export_facts(fb: FactBase, out: Path):
    payload = {
        "stats": fb.stats(),
        "boundary_rules": fb.boundary_rules,
        "output_rules": fb.output_rules,
        "scenario_rules": fb.scenario_rules,
        "announcements": [a.to_dict() for a in fb.announcements],
        "policy_clauses": [c.to_dict() for c in fb.policy_clauses],
        "kb_entries": [k.to_dict() for k in fb.kb_entries],
    }
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    fb = build_factbase()
    print(json.dumps(fb.stats(), ensure_ascii=False, indent=1))
    export_facts(fb, MATERIALS / "事实库.json")
    print("saved", MATERIALS / "事实库.json")
