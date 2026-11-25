# -*- coding: utf-8 -*-
"""线上质检规则 Agent —— 命令行入口。

用法：
  python3 -m agent.cli --input 通话记录.xlsx --output outputs/
  python3 -m agent.cli --input calls.jsonl --format jsonl
  python3 -m agent.cli --demo            # 用内置样例自检
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .facts import build_factbase, export_facts, MATERIALS
from .rules import RuleEngine, summarize, PASS, FAIL
from .transcript import make_call


def load_calls(path: Path, transcript_col: str | None = None):
    """支持 xlsx / csv / jsonl / json。"""
    suffix = path.suffix.lower()
    calls = []
    if suffix in (".xlsx", ".xlsm"):
        import openpyxl
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        ws = wb.active
        rows = ws.iter_rows(values_only=True)
        header = [str(h).strip() if h is not None else "" for h in next(rows)]
        # 字段定位（容忍别名）
        def pick(*names):
            for n in names:
                if n in header:
                    return header.index(n)
            return None
        i_id = pick("通话记录id", "通话记录ID", "call_id", "通话ID")
        i_tr = pick(transcript_col or "", "通话记录", "对话记录", "transcript", "对话内容", "通话文本")
        if i_tr is None:
            raise SystemExit(f"未找到对话列，表头为：{header}")
        for r in rows:
            if r is None:
                continue
            cid = r[i_id] if i_id is not None else f"row{len(calls)+1}"
            meta = {header[i]: r[i] for i in range(len(header)) if i != i_tr}
            calls.append(make_call(cid, r[i_tr], meta))
    elif suffix == ".jsonl":
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            o = json.loads(line)
            calls.append(make_call(o.get("call_id") or o.get("id"),
                                   o.get("transcript") or o.get("dialog") or o.get("text"),
                                   {k: v for k, v in o.items()
                                    if k not in ("call_id", "id", "transcript", "dialog", "text")}))
    elif suffix == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data = data.get("calls", [])
        for o in data:
            calls.append(make_call(o.get("call_id") or o.get("id"),
                                   o.get("transcript") or o.get("dialog") or o.get("text"), o))
    else:
        raise SystemExit(f"不支持的格式：{suffix}")
    return calls


def run(calls, engine, out_dir: Path, write_outputs=True):
    reports = [engine.inspect(c) for c in calls]
    summary = summarize(reports)
    if write_outputs:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "质检明细.json").write_text(
            json.dumps([r.to_dict() for r in reports], ensure_ascii=False, indent=1),
            encoding="utf-8")
        (out_dir / "质检汇总.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    return reports, summary


def main(argv=None):
    ap = argparse.ArgumentParser(description="九江文旅线上质检规则 Agent")
    ap.add_argument("--input", help="通话记录文件（xlsx/csv/jsonl/json）")
    ap.add_argument("--output", default="outputs", help="输出目录")
    ap.add_argument("--transcript-col", default=None, help="指定对话列名")
    ap.add_argument("--demo", action="store_true", help="使用内置样例自检")
    ap.add_argument("--export-facts", action="store_true", help="导出事实库")
    ap.add_argument("--company-id", type=int, help="线上取数：企业ID")
    ap.add_argument("--robot-ids", default="", help="线上取数：机器人ID，逗号分隔")
    ap.add_argument("--days", type=int, default=7, help="线上取数：最近N天")
    ap.add_argument("--where", default="", help="线上取数：附加SQL过滤条件")
    args = ap.parse_args(argv)

    fb = build_factbase()
    if args.export_facts:
        export_facts(fb, MATERIALS / "事实库.json")

    if not args.input and not args.demo and not args.company_id:
        ap.print_help()
        return 1

    engine = RuleEngine(fb)
    if args.demo:
        from .cases import CASES
        calls = [make_call(cid, tr) for cid, _d, _e, _r, tr in CASES]
    elif args.company_id:
        from .fetch import fetch_calls
        rids = [int(x) for x in args.robot_ids.split(",") if x.strip()]
        rows = fetch_calls(args.company_id, rids, days=args.days,
                           where_extra=args.where, verbose=True)
        calls = [make_call(r["call_id"], r["transcript"]) for r in rows]
    else:
        calls = load_calls(Path(args.input), args.transcript_col)

    reports, summary = run(calls, engine, Path(args.output))
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    print(f"\n明细已写入 {Path(args.output).resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
