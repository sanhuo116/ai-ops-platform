# -*- coding: utf-8 -*-
"""把质检结果渲染成 Word（.docx）报告。

报告结构（与 Markdown 版一致）：
    一、本时段通话情况
    二、质检发现的问题（含通话记录id）
    三、优化建议

依赖 python-docx；中文字体需同时设置 w:eastAsia，否则 Word 里会回退成宋体。
"""
from __future__ import annotations

import datetime as dt
import re
from pathlib import Path

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor, Cm

# 主题色
C_MAIN = RGBColor(0x1F, 0x3B, 0x63)     # 深蓝
C_RED = RGBColor(0xC0, 0x1F, 0x1F)      # 红线
C_ORANGE = RGBColor(0xB5, 0x6A, 0x00)   # 扣分
C_GRAY = RGBColor(0x59, 0x59, 0x59)

RULE_NAMES = {
    "R01": "AI沉默不回复", "R02": "输出内部依据", "R03": "口吻不符客服",
    "R04": "编造金额/事实", "R05": "门票优惠未完整输出", "R06": "汇总计算总价",
    "R07": "虚假承诺", "R08": "未授权联系方式", "R09": "活动有效期错误",
    "R10": "公告冲突", "R11": "输出Markdown", "R12": "无效重复追问",
    "R13": "转人工未响应", "R14": "无依据未兜底",
}


def _cn_font(run, name="PingFang SC", size=None, bold=None, color=None):
    """设置中英文字体，确保中文不回退。"""
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if color is not None:
        run.font.color.rgb = color
    run.font.name = name
    r = run._element.rPr.rFonts
    r.set(qn("w:eastAsia"), name)
    r.set(qn("w:ascii"), name)
    r.set(qn("w:hAnsi"), name)
    return run


def _para(doc, text="", size=10.5, bold=False, color=None, space_after=4,
          align=None, style=None):
    p = doc.add_paragraph(style=style)
    if text:
        _cn_font(p.add_run(text), size=size, bold=bold, color=color)
    p.paragraph_format.space_after = Pt(space_after)
    if align is not None:
        p.alignment = align
    return p


def _heading(doc, text, level=1):
    """自定义标题：避免默认 Heading 样式的中文字体回退。"""
    sizes = {0: 18, 1: 14, 2: 12, 3: 11}
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(10 if level <= 1 else 6)
    p.paragraph_format.space_after = Pt(5)
    _cn_font(p.add_run(text), size=sizes.get(level, 11), bold=True, color=C_MAIN)
    return p


def _kv_table(doc, rows, widths=(6.0, 9.5)):
    """两列指标表。"""
    t = doc.add_table(rows=0, cols=2)
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.LEFT
    for k, v in rows:
        cells = t.add_row().cells
        cells[0].width = Cm(widths[0])
        cells[1].width = Cm(widths[1])
        p0 = cells[0].paragraphs[0]
        p0.paragraph_format.space_after = Pt(1)
        _cn_font(p0.add_run(str(k)), size=9.5, bold=True, color=C_GRAY)
        p1 = cells[1].paragraphs[0]
        p1.paragraph_format.space_after = Pt(1)
        _cn_font(p1.add_run(str(v)), size=9.5)
    return t


def _grid_table(doc, header, rows, widths=None):
    t = doc.add_table(rows=1, cols=len(header))
    t.style = "Table Grid"
    hdr = t.rows[0].cells
    for i, h in enumerate(header):
        if widths:
            hdr[i].width = Cm(widths[i])
        p = hdr[i].paragraphs[0]
        p.paragraph_format.space_after = Pt(1)
        _cn_font(p.add_run(h), size=9, bold=True, color=RGBColor(0xFF, 0xFF, 0xFF))
        # 表头底色
        sh = hdr[i]._tc.get_or_add_tcPr()
        el = sh.makeelement(qn("w:shd"), {qn("w:fill"): "1F3B63"})
        sh.append(el)
    for row in rows:
        cells = t.add_row().cells
        for i, v in enumerate(row):
            if widths:
                cells[i].width = Cm(widths[i])
            p = cells[i].paragraphs[0]
            p.paragraph_format.space_after = Pt(1)
            _cn_font(p.add_run(str(v)), size=9)
    return t


def _cdur(meta: dict) -> int:
    v = meta.get("通话时长") or meta.get("人工通话时长") or ""
    m = re.search(r"(\d+)", str(v))
    return int(m.group(1)) if m else 0


def _stats(reports):
    n = len(reports)
    durs = [_cdur(r.get("meta") or {}) for r in reports]
    tags = {}
    for r in reports:
        t = (r.get("meta") or {}).get("意向标签")
        if t:
            tags[t] = tags.get(t, 0) + 1
    return {
        "dur_avg": round(sum(durs) / n) if n else 0,
        "dur_max": max(durs) if durs else 0,
        "dur_min": min(durs) if durs else 0,
        "dur_total": sum(durs),
        "tags": dict(sorted(tags.items(), key=lambda x: -x[1])),
    }


def _footer(doc, text):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _cn_font(p.add_run(text), size=8, color=C_GRAY)


def slot_report_name(slot) -> str:
    """时段报告的 Word 文件名（带日期与时间，便于多份并存时区分）。

    例：质检报告_2026-11-12_0900-1000.docx
        质检报告_2026-11-11_1900-2026-11-12_0800.docx（跨夜段）
    """
    if slot.start.date() == slot.end.date():
        span = f"{slot.start:%Y-%m-%d_%H%M}-{slot.end:%H%M}"
    else:
        span = f"{slot.start:%Y-%m-%d_%H%M}-{slot.end:%Y-%m-%d_%H%M}"
    return f"质检报告_{span}.docx"


def _slot_span(slot) -> str:
    """时段显示文本：同日写 HH:MM-HH:MM，跨日写完整起止。

    跨夜段（前一日 19:00 → 次日 08:00）必须带两个日期，否则会被误认为当天。
    """
    if slot.start.date() == slot.end.date():
        return f"{slot.start:%Y-%m-%d %H:%M}-{slot.end:%H:%M}"
    return f"{slot.start:%Y-%m-%d %H:%M} 至 {slot.end:%Y-%m-%d %H:%M}"


def render_slot_docx(slot, summary, reports, out_path,
                     title="九江文旅 AI 通话质检报告"):
    """生成单个时段的 Word 质检报告。

    标题带具体日期与时段，便于多份报告并排时区分：
        九江文旅 AI 通话质检报告（2026-11-12 09:00-10:00）
    """
    reports = [r.to_dict() if hasattr(r, "to_dict") else r for r in reports]
    st = _stats(reports)

    doc = Document()
    sec = doc.sections[0]
    sec.left_margin = sec.right_margin = Cm(2.0)
    sec.top_margin = sec.bottom_margin = Cm(1.8)

    # 标题（含日期与时段）
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(2)
    _cn_font(p.add_run(f"{title}（{_slot_span(slot)}）"), size=17,
             bold=True, color=C_MAIN)

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(2)
    _cn_font(p.add_run(f"时段 {slot.label}　当日第 {slot.index}/12 段"),
             size=10.5, color=C_GRAY)

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(10)
    _cn_font(p.add_run(f"统计区间：{slot.start:%Y-%m-%d %H:%M} — {slot.end:%Y-%m-%d %H:%M}"),
             size=9.5, color=C_GRAY)

    # 一、通话情况
    _heading(doc, "一、本时段通话情况", 1)
    if summary["total"] == 0:
        _para(doc, "本时段无通话记录。", size=10.5)
        doc.save(out_path)
        return out_path

    _kv_table(doc, [
        ("通话总量", f"{summary['total']} 通"),
        ("合格", f"{summary['pass']} 通"),
        ("不合格", f"{summary['fail']} 通"),
        ("不合格率", f"{summary['fail_rate']}%"),
        ("触碰红线", f"{summary['redline_calls']} 通"),
        ("平均质检得分", f"{summary['avg_score']} 分"),
        ("通话时长", f"平均 {st['dur_avg']} 秒 / 最长 {st['dur_max']} 秒 / 最短 {st['dur_min']} 秒"),
        ("累计通话时长", f"{st['dur_total']} 秒（约 {round(st['dur_total']/60, 1)} 分钟）"),
    ])

    if st["tags"]:
        _para(doc, "", size=4, space_after=2)
        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(4)
        _cn_font(p.add_run("意向分布："), size=9.5, bold=True, color=C_GRAY)
        _cn_font(p.add_run("，".join(f"{k} {v} 通" for k, v in st["tags"].items())), size=9.5)

    if summary["by_rule"]:
        _para(doc, "", size=4, space_after=2)
        _para(doc, "问题类型分布：", size=9.5, bold=True, color=C_GRAY, space_after=2)
        _grid_table(doc,
                    ["规则", "问题", "命中通话数"],
                    [[rid, RULE_NAMES.get(rid, rid), n]
                     for rid, n in summary["by_rule"].items()],
                    widths=(2.0, 8.0, 3.0))

    # 二、问题明细
    bad = [r for r in reports if (r["redline_hits"] or r["deductions"])]
    _heading(doc, "二、质检发现的问题", 1)
    if not bad:
        _para(doc, "本时段未发现触碰红线或明显扣分的通话，AI 回复符合质检口径。")
    else:
        nfail = sum(1 for r in bad if r["verdict"] != "合格")
        if nfail == len(bad):
            _para(doc, f"本时段共 {len(bad)} 通通话存在问题，均判不合格。", bold=True)
        elif nfail == 0:
            _para(doc, f"本时段共 {len(bad)} 通通话存在扣分项，"
                       f"但未累计到不合格线（≥80 分），仍判合格。", bold=True)
        else:
            _para(doc, f"本时段共 {len(bad)} 通通话存在问题"
                       f"（其中 {nfail} 通判不合格，"
                       f"{len(bad)-nfail} 通为扣分但未低于阈值）。", bold=True)

        for r in bad:
            meta = r.get("meta") or {}
            _para(doc, "", size=3, space_after=1)
            _heading(doc, f"通话记录id：{r['call_id']}", 2)
            info = []
            for k in ("通话时间", "归属地", "通话时长", "意向标签", "人工坐席"):
                if meta.get(k) not in (None, "", "None"):
                    info.append(f"{k}：{meta.get(k)}")
            if info:
                _para(doc, "　".join(info), size=9, color=C_GRAY, space_after=2)

            p = doc.add_paragraph()
            p.paragraph_format.space_after = Pt(2)
            _cn_font(p.add_run("质检结论："), size=9.5, bold=True)
            vc = C_RED if r["verdict"] != "合格" else C_ORANGE
            _cn_font(p.add_run(f"{r['verdict']}　得分 {r['score']}"), size=9.5,
                     bold=True, color=vc)

            for f in r["redline_hits"] + r["deductions"]:
                p = doc.add_paragraph()
                p.paragraph_format.space_after = Pt(1)
                p.paragraph_format.left_indent = Cm(0.4)
                tier = "红线" if f["level"] == "红线" else "扣分"
                _cn_font(p.add_run(f"【{f['rule_id']} {f['rule_name']}】"), size=9.5,
                         bold=True, color=C_RED if tier == "红线" else C_ORANGE)
                _cn_font(p.add_run(f"（{tier}）"), size=9, color=C_GRAY)

                for label, val in (("证据原话", f["evidence"]),
                                   ("问题判定", f["detail"])):
                    q = doc.add_paragraph()
                    q.paragraph_format.space_after = Pt(1)
                    q.paragraph_format.left_indent = Cm(0.8)
                    _cn_font(q.add_run(f"{label}："), size=9, bold=True, color=C_GRAY)
                    _cn_font(q.add_run(val), size=9)

    # 三、优化建议
    _heading(doc, "三、优化建议", 1)
    if not bad:
        _para(doc, "本时段无需整改，保持现有话术与知识库配置即可。")
    else:
        agg = {}
        for r in bad:
            for f in r["redline_hits"] + r["deductions"]:
                d = agg.setdefault(f["rule_id"], {"name": f["rule_name"],
                                                  "calls": [], "advice": f.get("suggestion", "")})
                d["calls"].append(r["call_id"])
        for rid, d in sorted(agg.items(), key=lambda x: -len(x[1]["calls"])):
            p = doc.add_paragraph()
            p.paragraph_format.space_after = Pt(1)
            _cn_font(p.add_run(f"{rid} {d['name']}"), size=10, bold=True, color=C_MAIN)
            _cn_font(p.add_run(f"（涉及 {len(d['calls'])} 通）"), size=9, color=C_GRAY)

            q = doc.add_paragraph()
            q.paragraph_format.space_after = Pt(1)
            q.paragraph_format.left_indent = Cm(0.4)
            _cn_font(q.add_run("涉及通话记录id："), size=9, bold=True, color=C_GRAY)
            _cn_font(q.add_run("、".join(d["calls"])), size=9)

            if d["advice"]:
                q = doc.add_paragraph()
                q.paragraph_format.space_after = Pt(4)
                q.paragraph_format.left_indent = Cm(0.4)
                _cn_font(q.add_run("整改动作："), size=9, bold=True, color=C_GRAY)
                _cn_font(q.add_run(d["advice"]), size=9)

    _para(doc, "", size=4, space_after=2)
    _footer(doc, "本报告由 jjwl-ls 质检技能自动生成；规则初判结果建议抽样回看原文后确认。")
    doc.save(out_path)
    return out_path


def render_daily_docx(day_dir, out_path=None, title="九江文旅 AI 通话质检日报"):
    """生成当日跨时段汇总 Word 报告。"""
    import json
    day_dir = Path(day_dir)
    out_path = Path(out_path) if out_path else day_dir / "质检日报.docx"

    rows = []
    for sub in sorted(p for p in day_dir.iterdir() if p.is_dir()):
        fp = sub / "质检汇总.json"
        if fp.exists():
            rows.append((sub.name, json.loads(fp.read_text(encoding="utf-8"))))

    doc = Document()
    sec = doc.sections[0]
    sec.left_margin = sec.right_margin = Cm(2.0)
    sec.top_margin = sec.bottom_margin = Cm(1.8)

    d = day_dir.name
    day_txt = f"{d[:4]}-{d[4:6]}-{d[6:]}"

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(8)
    _cn_font(p.add_run(f"{title}（{day_txt}）"), size=17, bold=True, color=C_MAIN)

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(10)
    _cn_font(p.add_run(f"统计日期：{day_txt}　覆盖 {len(rows)}/12 个时段"),
             size=10, color=C_GRAY)

    if not rows:
        _para(doc, "当日尚无任何时段的质检结果。")
        doc.save(out_path)
        return out_path

    tot = sum(s["total"] for _, s in rows)
    fail = sum(s["fail"] for _, s in rows)
    red = sum(s["redline_calls"] for _, s in rows)
    weighted = round(sum(s["avg_score"] * s["total"] for _, s in rows) / tot, 1) if tot else 0.0
    rate = round(fail / tot * 100, 1) if tot else 0.0

    _heading(doc, "一、当日结论", 1)
    _kv_table(doc, [
        ("全天通话总量", f"{tot} 通"),
        ("不合格", f"{fail} 通（{rate}%）"),
        ("合格", f"{tot - fail} 通"),
        ("触碰红线", f"{red} 通"),
        ("加权平均得分", f"{weighted} 分"),
        ("覆盖时段", f"{len(rows)}/12 段"),
    ])

    _heading(doc, "二、分时段趋势", 1)
    _grid_table(doc,
                ["时段", "通话", "合格", "不合格", "不合格率", "红线", "均分"],
                [[n, s["total"], s["pass"], s["fail"], f"{s['fail_rate']}%",
                  s["redline_calls"], s["avg_score"]] for n, s in rows]
                + [["合计", tot, tot - fail, fail, f"{rate}%", red, weighted]],
                widths=(4.6, 1.6, 1.6, 1.8, 2.0, 1.5, 1.6))

    agg = {}
    for _, s in rows:
        for rid, n in s["by_rule"].items():
            agg[rid] = agg.get(rid, 0) + n
    if agg:
        _heading(doc, "三、问题类型汇总", 1)
        _grid_table(doc, ["规则", "问题", "命中通话数", "占比"],
                    [[rid, RULE_NAMES.get(rid, rid), n,
                      f"{round(n / tot * 100, 1) if tot else 0}%"]
                     for rid, n in sorted(agg.items(), key=lambda x: -x[1])],
                    widths=(2.0, 8.0, 2.8, 2.0))

    bad = [(n, s) for n, s in rows if s["fail"] > 0]
    _heading(doc, "四、重点时段", 1)
    if not bad:
        _para(doc, "全天各时段均无不合格通话。")
    else:
        for name, s in sorted(bad, key=lambda x: -x[1]["fail"]):
            rules = "、".join(f"{r}({c})" for r, c in
                             sorted(s["by_rule"].items(), key=lambda x: -x[1]))
            p = doc.add_paragraph()
            p.paragraph_format.space_after = Pt(3)
            _cn_font(p.add_run(f"{name}："), size=9.5, bold=True)
            _cn_font(p.add_run(f"不合格 {s['fail']} 通，红线 {s['redline_calls']} 通，"
                               f"问题 {rules}"), size=9.5)

    _para(doc, "", size=4, space_after=2)
    _footer(doc, "本报告由 jjwl-ls 质检技能自动生成；各时段明细见同目录下各时段报告。")
    doc.save(out_path)
    return out_path
