# -*- coding: utf-8 -*-
"""通话记录解析：把原始对话文本切成结构化轮次。"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import List, Optional

ROLE_AI = "AI"
ROLE_ME = "ME"

# 支持三种格式：
#   1) '["0000:AI:…","0001:ME:…"]' 的 JSON 数组
#   2) 换行分隔的 “0000:AI:…” 文本
#   3) 无序号前缀的 “AI:…” / “ME:…” 文本（线上导出的默认真实格式）
_TURN_PAT = re.compile(
    r"^\s*(?:(\d{3,4})\s*[:：]\s*)?"
    r"(AI|ME|USER|CUSTOMER|客户|用户|坐席|机器人|智能助手)\s*[:：]\s*(.*)$", re.I)


@dataclass
class Turn:
    idx: int
    role: str
    text: str

    @property
    def is_ai(self) -> bool:
        return self.role == ROLE_AI

    def to_dict(self):
        return {"idx": self.idx, "role": self.role, "text": self.text}


@dataclass
class Call:
    call_id: str
    transcript: str
    turns: List[Turn] = field(default_factory=list)
    meta: dict = field(default_factory=dict)

    @property
    def ai_turns(self) -> List[Turn]:
        return [t for t in self.turns if t.is_ai]

    @property
    def me_turns(self) -> List[Turn]:
        return [t for t in self.turns if t.role == ROLE_ME]

    @property
    def ai_text(self) -> str:
        return "\n".join(t.text for t in self.ai_turns)

    @property
    def me_text(self) -> str:
        return "\n".join(t.text for t in self.me_turns)

    @property
    def full_text(self) -> str:
        return "\n".join(f"{t.role}:{t.text}" for t in self.turns)

    def to_dict(self):
        return {"call_id": self.call_id, "meta": self.meta,
                "turns": [t.to_dict() for t in self.turns]}


def _normalize_raw(raw) -> str:
    if raw is None:
        return ""
    s = str(raw)
    if s.strip().lower() in ("none", "nan", ""):
        return ""
    s = s.strip()
    if s.startswith("["):
        try:
            arr = json.loads(s)
            if isinstance(arr, list):
                return "\n".join(str(x) for x in arr)
        except Exception:
            pass
    return s


def parse_transcript(raw) -> List[Turn]:
    text = _normalize_raw(raw)
    turns: List[Turn] = []
    if not text:
        return turns
    buf: Optional[Turn] = None
    for line in text.splitlines():
        line = line.replace("\u200b", "").rstrip()
        if not line.strip():
            continue
        m = _TURN_PAT.match(line)
        if m:
            role_raw = m.group(2).upper()
            role = ROLE_ME if role_raw in ("ME", "USER", "CUSTOMER", "客户", "用户") else ROLE_AI
            buf = Turn(idx=int(m.group(1)) if m.group(1) else len(turns),
                       role=role, text=m.group(3).strip())
            turns.append(buf)
        else:
            # 无前缀的行并入上一轮（模型输出可能换行）
            if buf is not None:
                buf.text = (buf.text + " " + line.strip()).strip()
            else:
                turns.append(Turn(idx=len(turns), role=ROLE_AI, text=line.strip()))
    # 重排 idx 保证连续
    for i, t in enumerate(turns):
        t.idx = i
    return turns


def make_call(call_id: str, raw_transcript, meta: dict | None = None) -> Call:
    return Call(call_id=str(call_id), transcript=_normalize_raw(raw_transcript),
                turns=parse_transcript(raw_transcript), meta=meta or {})


# ---------- 文本工具 ----------

_CN_NUM = {"零": 0, "一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5,
           "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}


def cn_to_int(s: str) -> Optional[int]:
    s = s.strip()
    if not s:
        return None
    if s.isdigit():
        return int(s)
    if s == "十":
        return 10
    if s.startswith("十"):
        return 10 + _CN_NUM.get(s[1], 0)
    if len(s) >= 2 and s[0] in _CN_NUM and s[1] == "十":
        return _CN_NUM[s[0]] * 10 + (_CN_NUM.get(s[2], 0) if len(s) > 2 else 0)
    if len(s) == 1 and s in _CN_NUM:
        return _CN_NUM[s]
    return None


_MONEY_PAT = re.compile(r"(\d+(?:\.\d+)?|\d+|[零一两二三四五六七八九十百]+)\s*(?:元|块|块钱|人民币)")
_PHONE_PAT = re.compile(r"(?<!\d)(?:400[-\s]?\d{3}[-\s]?\d{4}|0\d{2,3}[-\s]?\d{7,8}|1[3-9]\d{9})(?!\d)")
_PCT_PAT = re.compile(r"(\d+)\s*[%％]")
_DATE_PAT = re.compile(r"(20\d{2}\s*年)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]")
_RANGE_PAT = re.compile(r"(\d{1,2}\s*月\s*\d{1,2}\s*[日号]?)\s*(?:至|到|-|—|~)\s*(\d{1,2}\s*月\s*\d{1,2}\s*[日号]?|次年\s*\d{1,2}\s*月\s*\d{1,2}\s*[日号]?)")
_TIME_PAT = re.compile(r"(\d{1,2})\s*[:：]\s*(\d{2})")
_DUR_PAT = re.compile(r"(\d+|[\u4e00-\u9fa5]{1,3})\s*(?:分钟|分钟以内|分钟内)")


def extract_money(text: str) -> List[str]:
    return [m.group(0) for m in _MONEY_PAT.finditer(text)]


def extract_phones(text: str) -> List[str]:
    return [re.sub(r"[\s-]", "", m.group(0)) for m in _PHONE_PAT.finditer(text)]


def has_question(text: str) -> bool:
    return ("?" in text) or ("？" in text) or bool(re.search(
        r"(吗|呢|多少|几点|怎么|如何|是否|能不能|可不可以|有没有|什么|哪里|哪个|请问)", text))


def question_count(text: str) -> int:
    n = text.count("?") + text.count("？")
    if n == 0 and has_question(text):
        n = 1
    return n


def sentences(text: str) -> List[str]:
    parts = re.split(r"[。！？!?；;\n]+", text)
    return [p.strip() for p in parts if p.strip()]


def contains_any(text: str, words) -> List[str]:
    return [w for w in words if w and w in text]
