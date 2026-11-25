# -*- coding: utf-8 -*-
"""九江文旅 · 分时段取数。

把一天切成 12 个时段：
    前一日 19:00 – 当日 08:00   合并为第 1 个文件（跨夜 13 小时）
    当日 08:00 – 09:00         第 2 个文件
    当日 09:00 – 10:00         第 3 个文件
    ...
    当日 18:00 – 19:00         第 12 个文件

取数来源：百应运营平台「通话记录导出」接口（按时间段导出 xlsx）。
"""
from __future__ import annotations

import datetime as dt
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

# 夜间合并段开始小时 / 白天起始小时 / 白天结束小时
NIGHT_START_HOUR = 19   # 前一日 19:00
DAY_START_HOUR = 8      # 当日 08:00
DAY_END_HOUR = 19       # 当日 19:00


@dataclass
class Slot:
    """一个取数时段。"""
    index: int          # 1..12
    label: str          # 显示名，如 "0800-0900"
    start: dt.datetime
    end: dt.datetime

    @property
    def filename(self) -> str:
        return f"calls_{self.label}.xlsx"

    def to_dict(self):
        return {"index": self.index, "label": self.label,
                "start": self.start.strftime("%Y-%m-%d %H:%M:%S"),
                "end": self.end.strftime("%Y-%m-%d %H:%M:%S")}


def build_slots(day: dt.date) -> List[Slot]:
    """构造某日的 12 个取数时段。

    第 1 段：前一日 19:00 → 当日 08:00
    第 2..12 段：当日 08:00–19:00 每小时一段（共 11 段）
    合计 12 段。
    """
    slots: List[Slot] = []
    night_start = dt.datetime.combine(day - dt.timedelta(days=1),
                                      dt.time(NIGHT_START_HOUR, 0))
    day_start = dt.datetime.combine(day, dt.time(DAY_START_HOUR, 0))
    day_end = dt.datetime.combine(day, dt.time(DAY_END_HOUR, 0))

    slots.append(Slot(1, "night_1900_0800", night_start, day_start))

    cur = day_start
    idx = 2
    while cur < day_end:
        nxt = min(cur + dt.timedelta(hours=1), day_end)
        slots.append(Slot(idx, f"{cur:%H%M}-{nxt:%H%M}", cur, nxt))
        cur = nxt
        idx += 1
    return slots


def slot_for_now(now: Optional[dt.datetime] = None) -> Slot:
    """当前时刻应抓取哪个时段（用于每小时触发）。

    语义是「抓刚结束的上一段」，而不是「抓正在进行的一段」：
        08:05 → 前一日19:00–当日08:00（跨夜段）
        09:05 → 08:00–09:00
        ...
        19:05 → 18:00–19:00

    这样每次抓到的都是已经完整落库的时段，不会拿到半截数据。
    """
    now = now or dt.datetime.now()
    best = None
    for day in (now.date() - dt.timedelta(days=1),
                now.date(),
                now.date() + dt.timedelta(days=1)):
        for s in build_slots(day):
            if s.end <= now and (best is None or s.end > best.end):
                best = s
    if best is None:
        raise ValueError(f"无法为 {now} 匹配取数时段")
    return best


# ---------------------------------------------------------------------------
# 取数执行器
# ---------------------------------------------------------------------------
class Fetcher:
    """按平台导出接口取数。具体 HTTP 细节由 fetch_impl 注入，便于替换。"""

    def __init__(self, fetch_impl=None, out_dir: Path | None = None):
        self.fetch_impl = fetch_impl
        self.out_dir = out_dir or Path("data")

    def fetch(self, slot: Slot) -> Path:
        self.out_dir.mkdir(parents=True, exist_ok=True)
        out = self.out_dir / slot.filename
        if self.fetch_impl is None:
            raise RuntimeError(
                "未配置取数实现。请提供 fetch_impl(slot, out_path)，"
                "或在 config.json 中配置平台接口后使用 fetch_slot_via_platform()。")
        self.fetch_impl(slot, out)
        return out


def fetch_slot_via_platform(slot: Slot, out_path: Path, cfg: dict):
    """通过百应平台导出接口按时间段导出通话记录 xlsx。

    cfg 需要包含：
        base_url   平台域名，如 https://97702720.cos.byai.com
        company_id 租户ID
        robot_ids  机器人ID列表（用于圈定九江文旅）
        cookie     登录态 Cookie（或由浏览器 CDP 注入）
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from .platform import export_calls
    return export_calls(slot, out_path, cfg)


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="按 12 时段切分并取数")
    ap.add_argument("--day", help="日期 YYYY-MM-DD，默认 today")
    ap.add_argument("--list", action="store_true", help="只打印时段，不取数")
    ap.add_argument("--slot", help="只取某个时段（label 或 index）")
    ap.add_argument("--out", default="data", help="数据输出目录")
    a = ap.parse_args(argv)

    day = dt.date.fromisoformat(a.day) if a.day else dt.date.today()
    slots = build_slots(day)

    if a.list:
        for s in slots:
            print(f"{s.index:2d}  {s.label:18s} {s.start:%m-%d %H:%M} → {s.end:%m-%d %H:%M}")
        print(f"\n共 {len(slots)} 个时段")
        return 0

    if a.slot:
        sel = [s for s in slots if a.slot in (s.label, str(s.index))]
        if not sel:
            print(f"未找到时段 {a.slot}", file=sys.stderr)
            return 1
        slots = sel

    for s in slots:
        print(f"[{s.index}/{len(slots)}] {s.label} {s.start:%m-%d %H:%M}→{s.end:%m-%d %H:%M}",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
