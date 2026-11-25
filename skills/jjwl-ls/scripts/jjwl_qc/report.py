# -*- coding: utf-8 -*-
"""把质检结果渲染成面向业务方的 Markdown 报告。"""
from __future__ import annotations
import json
import re
from collections import Counter
from pathlib import Path


def render(detail_path, summary_path, out_path, title="九江文旅 AI 通话质检报告",
           sample_raw=None):
    reports = json.loads(Path(detail_path).read_text(encoding="utf-8"))
    summary = json.loads(Path(summary_path).read_text(encoding="utf-8"))
    L = []
    L.append(f"# {title}\n")
    L.append("## 一、本期结论\n")
    L.append(f"- 本期纳入通话 **{summary['total']}** 通，合格 **{summary['pass']}** 通，"
             f"不合格 **{summary['fail']}** 通，不合格率 **{summary['fail_rate']}%**。")
    L.append(f"- 其中触碰红线（一票否决）**{summary['redline_calls']}** 通，"
             f"平均质检得分 **{summary['avg_score']}** 分。")
    L.append("- 结论口径：红线项一票否决；扣分项累计后低于 80 分判不合格。\n")

    L.append("## 二、问题分布\n")
    L.append("| 规则 | 问题 | 通话量 |")
    L.append("|---|---|---|")
    names = {f["rule_id"]: f["rule_name"]
             for r in reports for f in r["redline_hits"] + r["deductions"]}
    for rid, n in summary["by_rule"].items():
        L.append(f"| {rid} | {names.get(rid, rid)} | {n} |")
    L.append("")

    bad = [r for r in reports if r["verdict"] != "合格"]
    L.append("## 三、待优化通话明细\n")
    if not bad:
        L.append("本期未发现触碰红线或明显扣分的通话。\n")
    for r in bad:
        meta = r.get("meta", {})
        L.append(f"### 通话 {r['call_id']}\n")
        rows = []
        for k in ("通话时间", "归属地", "通话时长", "意向标签", "人工坐席"):
            if meta.get(k) not in (None, "", "None"):
                rows.append(f"{k}：{meta.get(k)}")
        if rows:
            L.append("　".join(rows) + "\n")
        for f in r["redline_hits"] + r["deductions"]:
            L.append(f"- **[{f['rule_id']} {f['rule_name']}]**（{f['level']}）")
            L.append(f"  - 证据：{f['evidence']}")
            L.append(f"  - 判定：{f['detail']}")
            if f.get("suggestion"):
                L.append(f"  - 优化动作：{f['suggestion']}")
        L.append("")

    L.append("## 四、后续优化动作\n")
    acts = []
    for rid in summary["by_rule"]:
        if rid == "R05":
            acts.append("门票与优惠类问答按条款原文逐项输出，补齐票价、资格、证件、"
                        "活动日期、适用范围、办理方式、限制提示，禁止总结压缩。")
        elif rid == "R06":
            acts.append("禁止汇总多人总价或组合总价，只报明确单价并引导官方小程序核实。")
        elif rid == "R12":
            acts.append("用户已作答后不整句复读，按已获信息推进下一问题。")
        elif rid == "R01":
            acts.append("补齐超时/空回复兜底，确保用户每次提问都有可执行答复。")
    for a in dict.fromkeys(acts):
        L.append(f"- {a}")
    L.append("")
    Path(out_path).write_text("\n".join(L), encoding="utf-8")
    return out_path


_CN = {1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六"}


def _cdur(meta: dict) -> int:
    """从 meta 里解析通话时长（秒）。"""
    v = meta.get("通话时长") or meta.get("人工通话时长") or ""
    m = re.search(r"(\d+)", str(v))
    return int(m.group(1)) if m else 0


def _call_stats(reports):
    """统计通话层面的分布指标。"""
    n = len(reports)
    durs = [_cdur(r.get("meta") or {}) for r in reports]
    tags = {}
    for r in reports:
        t = (r.get("meta") or {}).get("意向标签")
        if t:
            tags[t] = tags.get(t, 0) + 1
    dur_sum = sum(durs)
    return {
        "n": n,
        "dur_avg": round(dur_sum / n) if n else 0,
        "dur_max": max(durs) if durs else 0,
        "dur_min": min(durs) if durs else 0,
        "dur_total": dur_sum,
        "tags": dict(sorted(tags.items(), key=lambda x: -x[1])),
    }


def render_slot(slot, summary, reports, out_path, title="九江文旅 AI 通话质检报告"):
    """按单个时段的质检结果渲染独立报告。

    reports 既接受 QualityReport 对象，也接受其 to_dict() 结果。
    报告结构：一、本时段通话情况 / 二、质检发现的问题 / 三、优化建议
    """
    reports = [r.to_dict() if hasattr(r, "to_dict") else r for r in reports]
    st = _call_stats(reports)
    L = []
    L.append(f"# {title}（{slot.label}）\n")
    L.append(f"**统计时段**：{slot.start:%Y-%m-%d %H:%M} — {slot.end:%Y-%m-%d %H:%M}　"
             f"（当日第 {slot.index}/12 段）\n")

    # ---------------- 一、本时段通话情况 ----------------
    L.append("## 一、本时段通话情况\n")
    if summary["total"] == 0:
        L.append("- 本时段无通话记录。\n")
        out_path.write_text("\n".join(L), encoding="utf-8")
        return out_path

    L.append("| 指标 | 数值 |")
    L.append("|---|---|")
    L.append(f"| 通话总量 | {summary['total']} 通 |")
    L.append(f"| 合格 | {summary['pass']} 通 |")
    L.append(f"| 不合格 | {summary['fail']} 通 |")
    L.append(f"| 不合格率 | {summary['fail_rate']}% |")
    L.append(f"| 触碰红线 | {summary['redline_calls']} 通 |")
    L.append(f"| 平均质检得分 | {summary['avg_score']} 分 |")
    L.append(f"| 通话时长 | 平均 {st['dur_avg']} 秒 / 最长 {st['dur_max']} 秒 / "
             f"最短 {st['dur_min']} 秒 |")
    L.append(f"| 累计通话时长 | {st['dur_total']} 秒（约 {round(st['dur_total']/60, 1)} 分钟） |")
    L.append("")

    if st["tags"]:
        L.append("意向分布：" + "，".join(f"{k} {v} 通" for k, v in st["tags"].items()) + "\n")

    if summary["by_rule"]:
        L.append("问题类型分布：\n")
        L.append("| 规则 | 问题 | 命中通话数 |")
        L.append("|---|---|---|")
        for rid, n in summary["by_rule"].items():
            L.append(f"| {rid} | {RULE_NAMES.get(rid, rid)} | {n} |")
        L.append("")

    # ---------------- 二、质检发现的问题 ----------------
    # 只要命中任一规则就属“有问题”，即使分数未跌破阈值也要列出来，
    # 否则会出现「问题分布说命中 N 通、明细却查不到」的自相矛盾。
    bad = [r for r in reports if (r["redline_hits"] or r["deductions"])]
    L.append("## 二、质检发现的问题\n")
    if not bad:
        L.append("本时段未发现触碰红线或明显扣分的通话，AI 回复符合质检口径。\n")
    else:
        nfail = sum(1 for r in bad if r["verdict"] != "合格")
        if nfail == len(bad):
            L.append(f"本时段共 **{len(bad)}** 通通话存在问题，均判不合格。\n")
        elif nfail == 0:
            L.append(f"本时段共 **{len(bad)}** 通通话存在扣分项，"
                     f"但未累计到不合格线（≥80 分），仍判合格。\n")
        else:
            L.append(f"本时段共 **{len(bad)}** 通通话存在问题"
                     f"（其中 **{nfail}** 通判不合格，"
                     f"{len(bad)-nfail} 通为扣分但未低于阈值）。\n")
        for r in bad:
            meta = r.get("meta") or {}
            cid = r["call_id"]
            L.append(f"### 通话记录id：{cid}\n")
            info = []
            for k in ("通话时间", "归属地", "通话时长", "意向标签", "人工坐席"):
                if meta.get(k) not in (None, "", "None"):
                    info.append(f"{k}：{meta.get(k)}")
            if info:
                L.append("　".join(info) + "\n")
            L.append(f"- 质检结论：**{r['verdict']}**，得分 **{r['score']}**\n")
            for f in r["redline_hits"] + r["deductions"]:
                tier = "红线" if f["level"] == "红线" else "扣分"
                L.append(f"- **[{f['rule_id']} {f['rule_name']}]**（{tier}）")
                L.append(f"  - 证据原话：{f['evidence']}")
                L.append(f"  - 问题判定：{f['detail']}")
            L.append("")

    # ---------------- 三、优化建议 ----------------
    L.append("## 三、优化建议\n")
    if not bad:
        L.append("本时段无需整改，保持现有话术与知识库配置即可。\n")
    else:
        # 按规则聚合，给出可执行的整改动作
        agg = {}
        for r in bad:
            for f in r["redline_hits"] + r["deductions"]:
                agg.setdefault(f["rule_id"], {"name": f["rule_name"],
                                              "calls": [], "advice": f.get("suggestion", "")})
                agg[f["rule_id"]]["calls"].append(r["call_id"])
        for rid, d in sorted(agg.items(), key=lambda x: -len(x[1]["calls"])):
            L.append(f"**{rid} {d['name']}**（涉及 {len(d['calls'])} 通）")
            L.append(f"- 涉及通话记录id：{'、'.join(d['calls'])}")
            if d["advice"]:
                L.append(f"- 整改动作：{d['advice']}")
            L.append("")

    L.append("---\n")
    L.append("本报告由 jjwl-ls 质检技能自动生成；规则初判结果建议抽样回看原文后确认。")
    out_path.write_text("\n".join(L), encoding="utf-8")
    return out_path


# 规则名对照，供汇总报告使用
RULE_NAMES = {
    "R01": "AI沉默不回复", "R02": "输出内部依据", "R03": "口吻不符客服",
    "R04": "编造金额/事实", "R05": "门票优惠未完整输出", "R06": "汇总计算总价",
    "R07": "虚假承诺", "R08": "未授权联系方式", "R09": "活动有效期错误",
    "R10": "公告冲突", "R11": "输出Markdown", "R12": "无效重复追问",
    "R13": "转人工未响应", "R14": "无依据未兜底",
}


def render_daily(day_dir, out_path=None, title="九江文旅 AI 通话质检日报"):
    """汇总某日全部时段的质检结果，生成跨时段趋势报告。

    day_dir 下应有 01_* .. 12_* 各时段子目录，每个含 质检汇总.json。
    """
    import json
    from pathlib import Path

    day_dir = Path(day_dir)
    out_path = Path(out_path) if out_path else day_dir / "质检日报.md"

    rows = []
    for sub in sorted(p for p in day_dir.iterdir() if p.is_dir()):
        fp = sub / "质检汇总.json"
        if not fp.exists():
            continue
        s = json.loads(fp.read_text(encoding="utf-8"))
        rows.append((sub.name, s))

    L = []
    L.append(f"# {title}\n")
    L.append(f"**统计日期**：{day_dir.name[:4]}-{day_dir.name[4:6]}-{day_dir.name[6:]}　"
             f"覆盖 **{len(rows)}/12** 个时段\n")

    if not rows:
        L.append("当日尚无任何时段的质检结果。\n")
        out_path.write_text("\n".join(L), encoding="utf-8")
        return out_path

    tot = sum(s["total"] for _, s in rows)
    fail = sum(s["fail"] for _, s in rows)
    red = sum(s["redline_calls"] for _, s in rows)
    weighted = (sum(s["avg_score"] * s["total"] for _, s in rows) / tot) if tot else 0.0
    rate = round(fail / tot * 100, 1) if tot else 0.0

    L.append("## 一、当日结论\n")
    L.append(f"- 全天纳入通话 **{tot}** 通，不合格 **{fail}** 通，不合格率 **{rate}%**。")
    L.append(f"- 触碰红线 **{red}** 通，加权平均得分 **{round(weighted, 1)}** 分。")
    L.append("- 口径：红线一票否决；扣分累计低于 80 分判不合格。\n")

    L.append("## 二、分时段趋势\n")
    L.append("| 时段 | 通话 | 合格 | 不合格 | 不合格率 | 红线 | 均分 |")
    L.append("|---|---|---|---|---|---|---|")
    for name, s in rows:
        L.append(f"| {name} | {s['total']} | {s['pass']} | {s['fail']} | "
                 f"{s['fail_rate']}% | {s['redline_calls']} | {s['avg_score']} |")
    L.append(f"| **合计** | **{tot}** | **{tot - fail}** | **{fail}** | "
             f"**{rate}%** | **{red}** | **{round(weighted, 1)}** |")
    L.append("")

    # 问题分类汇总
    agg = {}
    for _, s in rows:
        for rid, n in s["by_rule"].items():
            agg[rid] = agg.get(rid, 0) + n
    if agg:
        L.append("## 三、问题类型汇总\n")
        L.append("| 规则 | 问题 | 命中通话数 | 占比 |")
        L.append("|---|---|---|---|")
        for rid, n in sorted(agg.items(), key=lambda x: -x[1]):
            L.append(f"| {rid} | {RULE_NAMES.get(rid, rid)} | {n} | "
                     f"{round(n / tot * 100, 1) if tot else 0}% |")
        L.append("")

    # 最差时段提示
    bad = [(n, s) for n, s in rows if s["fail"] > 0]
    L.append("## 四、重点时段\n")
    if not bad:
        L.append("全天各时段均无不合格通话。\n")
    else:
        for name, s in sorted(bad, key=lambda x: -x[1]["fail"]):
            rules = "、".join(f"{r}({c})" for r, c in
                             sorted(s["by_rule"].items(), key=lambda x: -x[1]))
            L.append(f"- **{name}**：不合格 {s['fail']} 通，红线 {s['redline_calls']} 通，"
                     f"问题 {rules}")
        L.append("")

    L.append("---\n")
    L.append("本报告由 jjwl-ls 质检技能自动生成；各时段明细见同目录下各子目录的质检报告。")
    out_path.write_text("\n".join(L), encoding="utf-8")
    return out_path
