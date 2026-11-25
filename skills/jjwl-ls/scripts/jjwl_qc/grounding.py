# -*- coding: utf-8 -*-
"""依据（grounding）索引。

质检最怕误判。本模块把所有“可以用作依据”的文本汇总成索引，
规则据此判断 AI 的回复是“有据”还是“编造”。

依据来源：
- 大模型提示词中的景区政策条款
- 附件知识库 167 条问答
- 临时公告
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Set

from . import lexicon as LX
from .facts import FactBase
from .transcript import extract_money

_GENERIC = {"景区", "庐山", "门票", "优惠", "价格", "票价", "政策", "活动",
            "居民", "游客", "游客朋友", "服务", "信息", "问题"}


def _norm_money(s: str) -> str:
    m = re.match(r"(\d+(?:\.\d+)?)", s)
    return m.group(1) if m else s


@dataclass
class Grounding:
    money: Set[str] = field(default_factory=set)
    dates: Set[str] = field(default_factory=set)     # 月-日
    times: Set[str] = field(default_factory=set)     # 时:分
    percents: Set[str] = field(default_factory=set)
    spots: Set[str] = field(default_factory=set)
    groups: Set[str] = field(default_factory=set)
    proofs: Set[str] = field(default_factory=set)
    channels: Set[str] = field(default_factory=set)
    clauses: list = field(default_factory=list)
    kb_answers: list = field(default_factory=list)
    announcement_text: str = ""

    @classmethod
    def build(cls, fb: FactBase) -> "Grounding":
        g = cls()
        texts = []
        for c in fb.policy_clauses:
            g.clauses.append({"id": c.clause_id, "name": c.name,
                              "section": c.section, "text": c.text})
            texts.append(c.text)
        for k in fb.kb_entries:
            g.kb_answers.append({"id": k.kb_id, "q": k.question, "a": k.answer})
            texts.append(k.answer)
        for a in fb.announcements:
            g.announcement_text += a.title + " " + a.body + " "
            texts.append(a.body)

        blob = "\n".join(texts)
        for m in extract_money(blob):
            g.money.add(_norm_money(m))
        for m in re.finditer(r"(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]", blob):
            g.dates.add(f"{int(m.group(1))}-{int(m.group(2))}")
        for m in re.finditer(r"(\d{1,2})\s*[:：]\s*(\d{2})", blob):
            g.times.add(f"{int(m.group(1))}:{m.group(2)}")
        for m in re.finditer(r"(\d+)\s*[%％]|(\d+)\s*折", blob):
            g.percents.add(m.group(1) or m.group(0))
        g.spots = {w for w in LX.SPOTS if w in blob}
        g.groups = {w for w in LX.GROUPS if w in blob}
        g.proofs = {w for w in LX.PROOFS if w in blob}
        g.channels = {w for w in LX.CHANNELS if w in blob}
        return g

    # ------------------------------------------------------------------
    def money_supported(self, text: str) -> List[str]:
        """返回文本中“有依据”的金额，以及无依据的金额。"""
        ok, bad = [], []
        for m in extract_money(text):
            v = _norm_money(m)
            (ok if v in self.money else bad).append(v)
        return ok, bad

    def date_supported(self, text: str) -> bool:
        for m in re.finditer(r"(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]", text):
            if f"{int(m.group(1))}-{int(m.group(2))}" in self.dates:
                return True
        return False

    def time_supported(self, text: str) -> bool:
        for m in re.finditer(r"(\d{1,2})\s*[:：]\s*(\d{2})", text):
            if f"{int(m.group(1))}:{m.group(2)}" in self.times:
                return True
        return False

    def entity_overlap(self, text: str) -> Set[str]:
        return {w for w in (LX.SPOTS + LX.GROUPS + LX.PROOFS + LX.CHANNELS)
                if w in text and w not in _GENERIC}

    # ------------------------------------------------------------------
    def best_kb(self, question: str) -> List[dict]:
        """按问题实体重合度召回知识库条目。"""
        q_ent = self.entity_overlap(question)
        scored = []
        for e in self.kb_answers:
            ent = self.entity_overlap(e["q"] + e["a"])
            if not ent:
                continue
            ov = len(q_ent & ent)
            if ov == 0:
                continue
            scored.append((ov / max(1, len(q_ent)), e))
        scored.sort(key=lambda x: -x[0])
        return [e for s, e in scored[:3] if s >= 0.34]
