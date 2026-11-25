# -*- coding: utf-8 -*-
"""线上取数适配器：从百应 DLC 主表拉取通话记录，交给质检引擎。

依赖 data-sanhuo 技能的腾讯云 DLC 取数脚本（只读）。若本机无该技能或
无凭据，本模块会明确报错，不会静默返回空数据。

用法：
    python3 -m agent.fetch --company-id 90867 --robot-ids 2161410 --days 7 \
        --out outputs/online_calls.jsonl
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

SKILL = Path(os.path.expanduser("~/.agents/skills/data-sanhuo"))
TABLE = "DataLakeCatalog.byai_bigdata.dwd_call_call_instance_sh_di"
PAGE = 2000


def _available() -> bool:
    return (SKILL / "scripts" / "tencent_query.py").exists()


def fetch_calls(company_id: int, robot_ids: list[int] | None = None,
                dt_from: str | None = None, dt_to: str | None = None,
                days: int | None = None, where_extra: str = "",
                page: int = PAGE, verbose=True):
    """拉取通话记录。返回 [{call_id, transcript, ...}]。"""
    if not _available():
        raise RuntimeError(
            f"未找到 DLC 取数脚本：{SKILL}/scripts/tencent_query.py\n"
            "请先安装/配置 data-sanhuo 技能，或改用 --input 传入导出文件。")

    if days and not (dt_from and dt_to):
        import datetime as _dt
        today = _dt.datetime.now()
        dt_to = today.strftime("%Y%m%d")
        dt_from = (today - _dt.timedelta(days=days)).strftime("%Y%m%d")
    if not (dt_from and dt_to):
        raise ValueError("需要 dt_from/dt_to，或指定 days")

    cond = [f"dt >= '{dt_from}'", f"dt <= '{dt_to}'", f"company_id = {company_id}"]
    if robot_ids:
        cond.append("robot_def_id IN (%s)" % ",".join(str(i) for i in robot_ids))
    if where_extra:
        cond.append(f"({where_extra})")
    where = " AND ".join(cond)

    rows, offset = [], 0
    while True:
        sql = (f"SELECT call_instance_id, content FROM {TABLE} WHERE {where} "
               f"ORDER BY call_instance_id LIMIT {page} OFFSET {offset}")
        cmd = ["python3", "scripts/tencent_query.py", "--config", "references/config.json",
               "--operation", "submit", "--authorized-table", TABLE,
               "--credentials-keychain", "--sql", sql]
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=str(SKILL))
        if r.returncode != 0:
            raise RuntimeError(f"DLC 取数失败：{r.stdout[:400]} {r.stderr[:400]}")
        d = json.loads(r.stdout)
        if not d.get("ok"):
            raise RuntimeError(f"DLC 返回错误：{json.dumps(d, ensure_ascii=False)[:600]}")
        batch = d.get("rows") or []
        rows.extend(batch)
        if verbose:
            print(f"  offset {offset}: +{len(batch)}，累计 {len(rows)}", file=sys.stderr)
        if len(batch) < page:
            break
        offset += page

    out = []
    for r in rows:
        if isinstance(r, dict):
            cid = r.get("call_instance_id")
            content = r.get("content")
        else:
            cid, content = r[0], r[1]
        out.append({"call_id": str(cid), "transcript": content})
    return out


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="从 DLC 拉取通话记录")
    ap.add_argument("--company-id", type=int, required=True)
    ap.add_argument("--robot-ids", default="")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--from", dest="dt_from")
    ap.add_argument("--to", dest="dt_to")
    ap.add_argument("--where", default="")
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)

    rids = [int(x) for x in a.robot_ids.split(",") if x.strip()]
    calls = fetch_calls(a.company_id, rids, a.dt_from, a.dt_to, a.days,
                        a.where, verbose=True)
    outp = Path(a.out)
    outp.parent.mkdir(parents=True, exist_ok=True)
    with outp.open("w", encoding="utf-8") as f:
        for c in calls:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    print(f"已写入 {outp}（{len(calls)} 通）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
