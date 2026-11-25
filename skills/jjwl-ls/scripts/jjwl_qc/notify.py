# -*- coding: utf-8 -*-
"""质检结果推送飞书群。

两个场景：
    1. 时段报告完成 → 推送该时段报告全文
    2. 时段超时未完成 → 推送告警

依赖本机 lark-cli（已登录），聊天群通过名称解析 chat_id 后缓存。

用法：
    python3 notify.py --slot-dir output/qc/20261112/03_0900-1000
    python3 notify.py --alert-json output/qc/20261112/ALERT.json
    python3 notify.py --test            # 连通性自测
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
from pathlib import Path

BASE = Path(os.path.expanduser(
    os.environ.get("JJWL_HOME", "~/Library/Application Support/dsh-inbound")))
CHAT_NAME = "九江文旅内部质检测试"
CHAT_CACHE = BASE / "chat_id.txt"
LOG = BASE / "logs" / "notify.log"

# 飞书单条消息长度上限保守值（post 消息整体限制较宽松）
MAX_LEN = 12000

# 规则编号与中文名，用于群消息摘要
RULE_NAMES = {
    "R01": "AI沉默不回复", "R02": "输出内部依据", "R03": "口吻不符客服",
    "R04": "编造金额/事实", "R05": "门票优惠未完整输出", "R06": "汇总计算总价",
    "R07": "虚假承诺", "R08": "未授权联系方式", "R09": "活动有效期错误",
    "R10": "公告冲突", "R11": "输出Markdown", "R12": "无效重复追问",
    "R13": "转人工未响应", "R14": "无依据未兜底",
}


def log(msg: str):
    line = f"[{dt.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def _run(args: list[str], timeout: int = 60,
         cwd: Path | None = None) -> tuple[bool, str]:
    """调用 lark-cli，返回 (是否成功, 输出)。"""
    try:
        r = subprocess.run(args, capture_output=True, text=True,
                           timeout=timeout,
                           cwd=str(cwd) if cwd else None)
    except FileNotFoundError:
        return False, "未找到 lark-cli，请确认已安装并在 PATH 中"
    except subprocess.TimeoutExpired:
        return False, f"lark-cli 超时（>{timeout}s）"
    out = (r.stdout or "") + (r.stderr or "")
    try:
        d = json.loads(r.stdout)
        return bool(d.get("ok")), out
    except Exception:
        return r.returncode == 0 and '"ok": true' in out, out


def resolve_chat(force: bool = False) -> str | None:
    """解析群 chat_id，成功结果缓存到本地。"""
    if not force and CHAT_CACHE.exists():
        cid = CHAT_CACHE.read_text(encoding="utf-8").strip()
        if cid.startswith("oc_"):
            return cid

    ok, out = _run(["lark-cli", "im", "+chat-search", "--query", CHAT_NAME])
    if not ok:
        log(f"群聊搜索失败：{out[:200]}")
        return None
    try:
        d = json.loads(out[out.index("{"):])
        chats = (d.get("data") or {}).get("chats") or []
        hit = next((c for c in chats if c.get("name") == CHAT_NAME), None)
        if not hit:
            log(f"未找到名为「{CHAT_NAME}」的群聊")
            return None
        cid = hit["chat_id"]
        CHAT_CACHE.write_text(cid, encoding="utf-8")
        log(f"已解析群聊 {CHAT_NAME} -> {cid}")
        return cid
    except Exception as e:
        log(f"解析群聊返回异常：{e}")
        return None


def send_markdown(md: str, chat_id: str | None = None, retries: int = 3) -> bool:
    """发送 Markdown 消息，超长自动分片。"""
    cid = chat_id or resolve_chat()
    if not cid:
        return False

    chunks = _split(md, MAX_LEN)
    for i, chunk in enumerate(chunks, 1):
        head = f"（{i}/{len(chunks)}）\n" if len(chunks) > 1 else ""
        body = head + chunk
        for attempt in range(1, retries + 1):
            ok, out = _run(["lark-cli", "im", "+messages-send",
                            "--chat-id", cid, "--markdown", body], timeout=90)
            if ok:
                break
            log(f"发送失败（第 {attempt}/{retries} 次）：{out[:200]}")
            if attempt == retries:
                return False
    return True


def _split(md: str, limit: int) -> list[str]:
    """按段落边界切分，避免截断表格或代码块。"""
    if len(md) <= limit:
        return [md]
    parts, cur = [], ""
    for block in re.split(r"\n(?=#{1,3} )", md):
        if len(cur) + len(block) + 1 > limit and cur:
            parts.append(cur.rstrip())
            cur = block
        else:
            cur = (cur + "\n" + block).strip("\n") if cur else block
    if cur.strip():
        parts.append(cur.rstrip())
    return parts or [md[:limit]]


def send_file(path: Path, chat_id: str | None = None, retries: int = 3) -> bool:
    """发送文件附件（用 bot 身份；bot 已入群故有上传权限）。

    lark-cli 的 --file 拒绝绝对路径与 `..`，因此切换到文件所在目录，
    只传文件名。
    """
    cid = chat_id or resolve_chat()
    if not cid:
        return False

    path = Path(path).resolve()
    if not path.exists():
        log(f"文件不存在：{path}")
        return False

    for attempt in range(1, retries + 1):
        ok, out = _run(["lark-cli", "im", "+messages-send",
                        "--as", "bot", "--chat-id", cid,
                        "--file", path.name],
                       cwd=path.parent, timeout=180)
        if ok:
            return True
        log(f"文件发送失败（第 {attempt}/{retries} 次）：{out[:200]}")
    return False


def _slot_title(slot_dir: Path) -> str:
    """从目录名构造「日期 时段」，如 2026-11-12 09:00-10:00。

    目录结构：output/qc/<YYYYMMDD>/<NN>_<label>/
    label 可能是 0900-1000，也可能是 night_1900_0800（跨夜段）。
    """
    day = slot_dir.parent.name
    date = f"{day[:4]}-{day[4:6]}-{day[6:]}" if len(day) == 8 and day.isdigit() else ""
    label = slot_dir.name.split("_", 1)[1] if "_" in slot_dir.name else slot_dir.name

    m = re.fullmatch(r"(\d{2})(\d{2})-(\d{2})(\d{2})", label)
    if m:
        h1, m1, h2, m2 = m.groups()
        return f"{date} {h1}:{m1}-{h2}:{m2}".strip()

    m = re.fullmatch(r"night_(\d{2})(\d{2})_(\d{2})(\d{2})", label)
    if m:
        h1, m1, h2, m2 = m.groups()
        return f"{date} 前一日 {h1}:{m1} 至 {h2}:{m2}".strip()

    return f"{date} {label}".strip()


def render_slot_summary(slot_dir: Path) -> str:
    """群消息摘要：结论 + 问题清单，详情看 Word 附件。"""
    sm = json.loads((slot_dir / "质检汇总.json").read_text(encoding="utf-8"))
    name = slot_dir.name
    label = name.split("_", 1)[1] if "_" in name else name

    span = _slot_title(slot_dir)
    lines = [
        f"【九江文旅质检】{span}",
        "",
        f"- 通话总量：**{sm['total']}** 通",
        f"- 合格：{sm['pass']} 通　不合格：**{sm['fail']}** 通"
        f"（{sm['fail_rate']}%）",
        f"- 触碰红线：{sm['redline_calls']} 通",
        f"- 平均得分：{sm['avg_score']} 分",
    ]

    if sm.get("by_rule"):
        lines += ["", "**问题类型：**"]
        for rid, n in sm["by_rule"].items():
            lines.append(f"- {rid} {RULE_NAMES.get(rid, rid)}：{n} 通")

    # 列出异常通话 id，便于直接定位
    detail = slot_dir / "质检明细.json"
    if detail.exists():
        reps = json.loads(detail.read_text(encoding="utf-8"))
        bad = [r for r in reps if r.get("redline_hits") or r.get("deductions")]
        if bad:
            lines += ["", "**问题通话记录id：**"]
            for r in bad:
                rules = [f["rule_id"] for f in
                         (r.get("redline_hits") or []) + (r.get("deductions") or [])]
                lines.append(f"- `{r['call_id']}`　{r['verdict']}　"
                             f"{r['score']} 分　{'/'.join(rules)}")

    lines += ["", "> 详细证据与优化建议见上方 Word 报告附件。"]
    return "\n".join(lines)


def send_slot_report(slot_dir: Path, mark: bool = True) -> bool:
    """推送单个时段报告：先发 Word 附件，再发摘要说明。"""
    slot_dir = Path(slot_dir)
    flag = slot_dir / ".notified"
    if mark and flag.exists():
        log(f"{slot_dir.name} 已推送过，跳过")
        return True

    # 优先发送带日期时间的报告，便于群内多份文件区分
    stamped = sorted(slot_dir.glob("质检报告_*.docx"),
                     key=lambda p: p.stat().st_mtime, reverse=True)
    docx = stamped[0] if stamped else slot_dir / "质检报告.docx"
    ok_file = send_file(docx) if docx.exists() else False
    if not ok_file:
        # Word 附件失败时，退化为发送摘要文本（不再产出 Markdown 报告文件）
        log(f"{slot_dir.name} Word 附件发送失败，改为发送摘要文本")
        try:
            if not send_markdown(render_slot_summary(slot_dir)):
                log(f"推送失败 {slot_dir.name}")
                return False
        except Exception as e:
            log(f"摘要发送异常：{e}")
            return False
    else:
        # 附件已发出，再补一条摘要（失败不影响整体成功）
        try:
            send_markdown(render_slot_summary(slot_dir))
        except Exception as e:
            log(f"摘要发送异常（不影响附件送达）：{e}")

    log(f"已推送时段报告 {slot_dir.name}"
        f"（{'Word附件' if ok_file else '文本'}）")
    if mark:
        flag.write_text(dt.datetime.now().isoformat(), encoding="utf-8")
    return True


def send_alert(result: dict, dedup: bool = True) -> bool:
    """推送完成度告警；同一缺失清单只推一次，避免每次巡检重复刷屏。

    返回 True 表示「已送达或无需重发」，False 表示发送失败。
    是否真正发送可通过 dedup 参数与日志区分。
    """
    if dedup:
        sig = _alert_signature(result)
        marker = BASE / "logs" / ".alert_sent"
        if marker.exists() and marker.read_text(encoding="utf-8").strip() == sig:
            log("该缺失清单已推送过，跳过（去重）")
            return True

    ok = _send_alert_body(result)
    if ok and dedup:
        (BASE / "logs" / ".alert_sent").write_text(_alert_signature(result),
                                                   encoding="utf-8")
    return ok


def _alert_signature(result: dict) -> str:
    """告警指纹：日期 + 缺失/异常时段集合。"""
    m = ",".join(str(x.get("slot")) for x in (result.get("missing") or []))
    e = ",".join(str(x.get("slot")) for x in (result.get("errored") or []))
    return f"{result.get('day','')}|{m}|{e}"


def _send_alert_body(result: dict) -> bool:
    """实际拼装并发送告警内容。"""
    day = result.get("day", "")
    due = result.get("due_count", 0)
    done = result.get("done_count", 0)
    missing = result.get("missing") or []
    errored = result.get("errored") or []

    lines = [
        f"【质检告警】{day} 时段未按时完成",
        "",
        f"应完成 **{due}** 段，实际完成 **{done}** 段，"
        f"缺失 **{len(missing)}** 段，异常 **{len(errored)}** 段",
        "",
    ]
    if missing:
        lines.append("**缺失时段：**")
        for m in missing:
            lines.append(f"- 第 {m['slot']:02d} 段 `{m['label']}` "
                         f"应于 {m['should_finish_by']} 前完成")
        lines.append("")
    if errored:
        lines.append("**异常时段：**")
        for e in errored:
            lines.append(f"- 第 {e['slot']:02d} 段 `{e['label']}`：{e['reason'][:120]}")
        lines.append("")
    lines.append(f"检查时间：{result.get('now','')}")
    lines.append("")
    lines.append("> 若为取数或登录故障，可运行 "
                 "`python3 health.py --repair` 补跑。")

    return send_markdown("\n".join(lines))


def main(argv=None):
    ap = argparse.ArgumentParser(description="质检结果推送飞书")
    ap.add_argument("--slot-dir", help="时段报告目录")
    ap.add_argument("--alert-json", help="告警 JSON 文件")
    ap.add_argument("--all-pending", action="store_true",
                    help="推送当日所有未推送的时段报告")
    ap.add_argument("--test", action="store_true", help="连通性自测")
    ap.add_argument("--force", action="store_true", help="忽略已推送标记")
    a = ap.parse_args(argv)

    if a.test:
        cid = resolve_chat(force=True)
        if not cid:
            log("群聊不可达")
            return 1
        ok = send_markdown(
            f"**推送通道自测**\n\n时间：{dt.datetime.now():%Y-%m-%d %H:%M:%S}\n"
            f"群聊：{CHAT_NAME}\n状态：正常", cid)
        log("自测" + ("成功" if ok else "失败"))
        return 0 if ok else 1

    if a.alert_json:
        res = json.loads(Path(a.alert_json).read_text(encoding="utf-8"))
        ok = send_alert(res)
        # send_alert 内部已记录「已发送」或「去重跳过」，此处不再重复宣称成功
        if not ok:
            log(f"告警推送失败（缺失 {len(res.get('missing') or [])} 段）")
        return 0 if ok else 1

    if a.slot_dir:
        return 0 if send_slot_report(Path(a.slot_dir), mark=not a.force) else 1

    if a.all_pending:
        root = BASE / "output" / "qc" / dt.date.today().strftime("%Y%m%d")
        n_ok = 0
        for d in sorted(p for p in root.iterdir() if p.is_dir()) if root.exists() else []:
            if list(d.glob("质检报告*.docx")) and send_slot_report(d):
                n_ok += 1
        log(f"共推送 {n_ok} 份")
        return 0 if n_ok else 1

    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
