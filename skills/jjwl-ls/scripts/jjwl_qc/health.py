# -*- coding: utf-8 -*-
"""当日质检完成度自检 + 缺失补位 + 告警。

判定口径
--------
按当前时刻推算「今天应该已经完成哪些时段」：
    08:05 起应完成第 1 段（跨夜），09:05 起应完成第 2 段，……，19:05 起应完成第 12 段。
若某时段已过点但缺少 Word 报告（质检报告_*.docx），即视为缺失。

动作
----
1. 修复配置文件/模块等结构性故障的能力有限，但会明确报告原因；
2. 对缺失时段可按 --repair 触发补跑（复用 run_slot.sh）；
3. --alert 时在报告目录写告警文件并在日志留痕，便于外部监控抓取。

用法
----
    python3 health.py                 # 只体检，打印结果
    python3 health.py --repair        # 体检并补跑缺失时段
    python3 health.py --alert         # 体检并在有缺失时写告警文件
    python3 health.py --json          # 机器可读输出
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path

BASE = Path(os.path.expanduser(
    os.environ.get("JJWL_HOME", "~/Library/Application Support/dsh-inbound")))
sys.path.insert(0, str(BASE))

from jjwl_qc.slots import build_slots  # noqa: E402

QC_ROOT = Path(os.environ.get("JJWL_QC_ROOT", BASE / "output" / "qc"))
LOG = BASE / "logs" / "health.log"


def log(msg: str):
    line = f"[{dt.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def due_slots(now: dt.datetime | None = None, grace_min: int = 5):
    """返回今天「应该已完成」的时段列表（含应完成时间点）。"""
    now = now or dt.datetime.now()
    out = []
    for s in build_slots(now.date()):
        # 时段结束后 grace_min 分钟才算应完成
        must_by = s.end + dt.timedelta(minutes=grace_min)
        if must_by <= now:
            out.append((s, must_by))
    return out


def slot_dir(day: dt.date, s) -> Path:
    return QC_ROOT / day.strftime("%Y%m%d") / f"{s.index:02d}_{s.label}"


def is_done(d: Path) -> bool:
    """该时段是否已产出报告（docx 优先，回退 md）。"""
    # 只看 Word 报告；Markdown 已废弃
    return any(d.glob("质检报告*.docx"))


def has_error(d: Path) -> bool:
    return (d / "ERROR.txt").exists()


def check(now: dt.datetime | None = None, grace_min: int = 5):
    now = now or dt.datetime.now()
    day = now.date()
    due = due_slots(now, grace_min)

    done, missing, errored = [], [], []
    for s, must_by in due:
        d = slot_dir(day, s)
        if is_done(d):
            done.append((s, d))
        elif has_error(d):
            errored.append((s, d, (d / "ERROR.txt").read_text(encoding="utf-8").strip()))
        else:
            missing.append((s, must_by, d))

    # 实际存在报告但未到点的时段（多跑/补跑）也统计
    # 按目录数统计（每段可能同时存在带时间名与固定名两份 docx，不重复计）
    day_root = QC_ROOT / day.strftime("%Y%m%d")
    total_reports = sum(
        1 for sub in day_root.glob("*/")
        if any(sub.glob("质检报告*.docx"))) if day_root.exists() else 0

    return {
        "now": now.strftime("%Y-%m-%d %H:%M:%S"),
        "day": day.strftime("%Y-%m-%d"),
        "due_count": len(due),
        "done_count": len(done),
        "missing_count": len(missing),
        "error_count": len(errored),
        "total_reports": total_reports,
        "missing": [
            {"slot": s.index, "label": s.label,
             "should_finish_by": must_by.strftime("%H:%M"),
             "dir": str(d), "start": s.start.strftime("%Y-%m-%d %H:%M:%S"),
             "end": s.end.strftime("%Y-%m-%d %H:%M:%S")}
            for s, must_by, d in missing
        ],
        "errored": [
            {"slot": s.index, "label": s.label, "reason": reason[:300]}
            for s, d, reason in errored
        ],
        "ok": not missing and not errored,
    }


def repair(result: dict, runner: Path, timeout: int = 900):
    """对缺失时段逐个补跑。"""
    fixed = []
    for m in result["missing"]:
        log(f"补跑缺失时段 {m['slot']:02d} {m['label']} "
            f"({m['start']} ~ {m['end']})")
        cmd = ["bash", str(runner), m["start"], m["end"],
               str(m["slot"]), m["label"]]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            ok = is_done(Path(m["dir"]))
            log(f"  补跑{'成功' if ok else '失败'} exit={r.returncode}")
            if not ok and r.stderr:
                log(f"  stderr: {r.stderr.strip()[:300]}")
            fixed.append({"slot": m["slot"], "ok": ok, "exit": r.returncode})
        except subprocess.TimeoutExpired:
            log(f"  补跑超时（>{timeout}s）")
            fixed.append({"slot": m["slot"], "ok": False, "exit": "timeout"})
    return fixed


def main(argv=None):
    ap = argparse.ArgumentParser(description="当日质检完成度自检")
    ap.add_argument("--repair", action="store_true", help="补跑缺失时段")
    ap.add_argument("--alert", action="store_true", help="有缺失时写告警文件")
    ap.add_argument("--json", action="store_true", help="JSON 输出")
    ap.add_argument("--grace-min", type=int, default=5,
                    help="时段结束后等待分钟数才算应完成（默认 5）")
    a = ap.parse_args(argv)

    res = check(grace_min=a.grace_min)

    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=1))
    else:
        log(f"日期 {res['day']}　应完成 {res['due_count']} 段，"
            f"已完成 {res['done_count']} 段，缺失 {res['missing_count']} 段，"
            f"异常 {res['error_count']} 段（目录内报告共 {res['total_reports']} 份）")
        for m in res["missing"]:
            log(f"  缺失：第 {m['slot']:02d} 段 {m['label']}（应于 {m['should_finish_by']} 前完成）")
        for e in res["errored"]:
            log(f"  异常：第 {e['slot']:02d} 段 {e['label']} → {e['reason'][:150]}")

    if a.repair and (res["missing"] or res["errored"]):
        runner = BASE / "run_slot.sh"
        if not runner.exists():
            log(f"缺少补跑脚本：{runner}")
        else:
            fixed = repair(res, runner)
            res["repaired"] = fixed
            res = check(grace_min=a.grace_min)
            log(f"补跑后：已完成 {res['done_count']}/{res['due_count']} 段，"
                f"仍缺失 {res['missing_count']} 段")

    # 体检通过时清除历史告警，避免残留文件造成误判
    if res["ok"]:
        stale = QC_ROOT / res["day"].replace("-", "") / "ALERT.json"
        if stale.exists():
            stale.unlink()
            log(f"已清除过期告警：{stale}")

    if a.alert and not res["ok"]:
        alert_file = QC_ROOT / res["day"].replace("-", "") / "ALERT.json"
        alert_file.parent.mkdir(parents=True, exist_ok=True)
        alert_file.write_text(json.dumps(res, ensure_ascii=False, indent=1),
                              encoding="utf-8")
        log(f"已写告警文件：{alert_file}")

    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
