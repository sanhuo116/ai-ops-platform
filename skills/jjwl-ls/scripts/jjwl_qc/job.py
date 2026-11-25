# -*- coding: utf-8 -*-
"""九江文旅定时巡检任务。

调度设计
--------
一天 12 个时段，每个时段结束后抓取并质检，各出一份独立报告：

    08:05  抓 前一日19:00–当日08:00（跨夜段）
    09:05  抓 08:00–09:00
    10:05  抓 09:00–10:00
    ...
    19:05  抓 18:00–19:00

用法
----
    # 由 launchd / cron 每小时调用（自动匹配当前应抓的时段）
    python3 -m jjwl_qc.job --config config.json --run-now

    # 手动补跑某天全部 12 段
    python3 -m jjwl_qc.job --config config.json --day 2026-11-12 --all

    # 只跑指定时段
    python3 -m jjwl_qc.job --config config.json --day 2026-11-12 --slot 3
"""
from __future__ import annotations

import datetime as dt
import json
import sys
import traceback
from pathlib import Path

from .facts import build_factbase
from .report import render_slot
from .rules import RuleEngine, summarize
from .slots import Slot, build_slots, slot_for_now
from .transcript import make_call

ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_CONFIG = ROOT / "config.json"


def load_config(path: Path) -> dict:
    if not path.exists():
        raise SystemExit(f"缺少配置文件：{path}\n"
                         f"请先复制 config.example.json 为 config.json 并填写。")
    return json.loads(path.read_text(encoding="utf-8"))


def _today_root(cfg: dict, day: dt.date) -> Path:
    base = Path(cfg.get("output_dir", "outputs"))
    return base / day.strftime("%Y%m%d")


def _fetch_one(slot: Slot, cfg: dict) -> Path:
    """抓取单个时段的数据文件。"""
    out_dir = Path(cfg.get("data_dir", "data"))
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / slot.filename

    if out_path.exists() and cfg.get("skip_existing", True):
        print(f"  已存在，跳过取数：{out_path}")
        return out_path

    source = cfg.get("source", "platform")
    if source == "platform":
        from .platform import export_calls
        print(f"  取数（平台导出）：{slot.start:%m-%d %H:%M} → {slot.end:%m-%d %H:%M}")
        export_calls(slot, out_path, cfg.get("platform", {}))
    elif source == "dlc":
        from .fetch import fetch_calls
        print(f"  取数（DLC）：{slot.start:%m-%d %H:%M} → {slot.end:%m-%d %H:%M}")
        rows = fetch_calls(
            company_id=cfg["dlc"]["company_id"],
            robot_ids=cfg["dlc"].get("robot_ids"),
            dt_from=slot.start.strftime("%Y%m%d%H%M%S"),
            dt_to=slot.end.strftime("%Y%m%d%H%M%S"),
            where_extra=cfg["dlc"].get("where", ""),
            verbose=False,
        )
        import openpyxl
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(["通话记录id", "通话记录"])
        for r in rows:
            ws.append([r["call_id"], r["transcript"]])
        wb.save(out_path)
    else:
        raise SystemExit(f"未知数据源：{source}")
    return out_path


def _inspect_file(path: Path, engine: RuleEngine):
    """读一个数据文件并质检。"""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from .cli import load_calls
    calls = load_calls(path)
    reports = [engine.inspect(c) for c in calls]
    return calls, reports, summarize(reports)


def run_slot(slot: Slot, cfg: dict, engine: RuleEngine, day: dt.date,
             day_slots: list[Slot]):
    print(f"\n{'='*64}")
    print(f"时段 {slot.index}/{len(day_slots)}  {slot.label}  "
          f"{slot.start:%m-%d %H:%M} → {slot.end:%m-%d %H:%M}")
    print("=" * 64)

    day_root = _today_root(cfg, day)
    slot_out = day_root / f"{slot.index:02d}_{slot.label}"
    slot_out.mkdir(parents=True, exist_ok=True)

    try:
        data = _fetch_one(slot, cfg)
    except Exception as e:
        print(f"  [取数失败] {e}", file=sys.stderr)
        (slot_out / "ERROR.txt").write_text(
            f"取数失败\n时段：{slot.label}\n错误：{e}\n", encoding="utf-8")
        if not cfg.get("continue_on_error", True):
            raise
        return None

    try:
        calls, reports, summary = _inspect_file(data, engine)
    except Exception as e:
        print(f"  [质检失败] {e}", file=sys.stderr)
        traceback.print_exc()
        (slot_out / "ERROR.txt").write_text(
            f"质检失败\n时段：{slot.label}\n数据：{data}\n错误：{e}\n", encoding="utf-8")
        if not cfg.get("continue_on_error", True):
            raise
        return None

    (slot_out / "质检明细.json").write_text(
        json.dumps([r.to_dict() for r in reports], ensure_ascii=False, indent=1),
        encoding="utf-8")
    (slot_out / "质检汇总.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")

    title = cfg.get("report_title", "九江文旅 AI 通话质检报告")

    # 主交付物：Word 报告
    docx_path = slot_out / "质检报告.docx"
    try:
        from .docx_report import render_slot_docx
        render_slot_docx(slot, summary, reports, docx_path, title=title)
        report = docx_path
    except Exception as e:            # python-docx 缺失时回退到 Markdown
        print(f"  [Word 生成失败，回退 Markdown] {e}", file=sys.stderr)
        report = slot_out / "质检报告.md"
        render_slot(slot, summary, reports, report, title=title)

    # 同时保留 Markdown，便于检索与版本比对
    render_slot(slot, summary, reports, slot_out / "质检报告.md", title=title)

    print(f"  通话 {summary['total']} 通，不合格 {summary['fail']} 通"
          f"（{summary['fail_rate']}%），红线 {summary['redline_calls']} 通")
    print(f"  报告：{report}")
    return summary


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="九江文旅定时巡检任务")
    ap.add_argument("--config", default=str(DEFAULT_CONFIG))
    ap.add_argument("--day", help="日期 YYYY-MM-DD，默认今天")
    ap.add_argument("--slot", help="只跑该时段（index 或 label）")
    ap.add_argument("--all", action="store_true", help="跑该日全部 12 段（补数据用）")
    ap.add_argument("--run-now", action="store_true",
                    help="按当前时间自动匹配应抓时段（调度器用这个）")
    a = ap.parse_args(argv)

    cfg = load_config(Path(a.config))
    engine = RuleEngine(build_factbase())

    if a.run_now and not (a.day or a.slot or a.all):
        slot = slot_for_now()
        # 跨夜段归属到它结束的那一天
        day = slot.end.date() if slot.end.date() != slot.start.date() else slot.start.date()
        day_slots = build_slots(day)
        idx = next((i for i, s in enumerate(day_slots, 1) if s.label == slot.label), slot.index)
        slot.index = idx
        print(f"当前应抓时段：{slot.index} {slot.label} "
              f"{slot.start:%m-%d %H:%M}→{slot.end:%m-%d %H:%M}")
        run_slot(slot, cfg, engine, day, day_slots)
        return 0

    day = dt.date.fromisoformat(a.day) if a.day else dt.date.today()
    slots = build_slots(day)
    if a.slot:
        slots = [s for s in slots if a.slot in (s.label, str(s.index))] or \
            [s for s in slots if s.label == a.slot]
        if not slots:
            raise SystemExit(f"未找到时段 {a.slot}")
    elif not a.all:
        slots = [slot_for_now()]

    ok = 0
    for s in slots:
        if run_slot(s, cfg, engine, day, build_slots(day)) is not None:
            ok += 1
    print(f"\n完成：{ok}/{len(slots)} 个时段成功")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
