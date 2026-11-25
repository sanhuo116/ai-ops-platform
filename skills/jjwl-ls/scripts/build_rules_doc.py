# -*- coding: utf-8 -*-
"""生成《九江文旅质检规则说明》Word 文档。

用 python-docx 输出，样式与质检报告保持一致（PingFang SC + 深蓝标题 + 表格）。
运行：python3 build_rules_doc.py <输出路径.docx>
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Cm, Pt

from jjwl_qc.docx_report import (C_GRAY, C_MAIN, C_ORANGE, C_RED,
                                 _cn_font, _grid_table, _heading, _kv_table,
                                 _para)

REDLINE, DEDUCT = "红线", "扣分"


def _title(doc, text, sub=None):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(2)
    _cn_font(p.add_run(text), size=18, bold=True, color=C_MAIN)
    if sub:
        q = doc.add_paragraph()
        q.alignment = WD_ALIGN_PARAGRAPH.CENTER
        q.paragraph_format.space_after = Pt(12)
        _cn_font(q.add_run(sub), size=9.5, color=C_GRAY)


def _lead(doc, text, color=C_MAIN):
    """规则一句话说明。"""
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(4)
    _cn_font(p.add_run(text), size=10.5, bold=True, color=color)


def _body(doc, text, indent=0.0, size=9.5, color=None):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(2)
    if indent:
        p.paragraph_format.left_indent = Cm(indent)
    _cn_font(p.add_run(text), size=size, color=color)
    return p


def _label(doc, label, text, color=C_GRAY, indent=0.3):
    """「标签：内容」段落。"""
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(2)
    p.paragraph_format.left_indent = Cm(indent)
    _cn_font(p.add_run(f"{label}："), size=9.5, bold=True, color=color)
    _cn_font(p.add_run(text), size=9.5)
    return p


def _case(doc, lines, verdict=None):
    """真实案例框：浅灰底。"""
    from docx.oxml.ns import qn

    t = doc.add_table(rows=1, cols=1)
    t.style = "Table Grid"
    cell = t.rows[0].cells[0]
    cell.width = Cm(17.0)
    sh = cell._tc.get_or_add_tcPr()
    sh.append(sh.makeelement(qn("w:shd"), {qn("w:fill"): "F5F6F8"}))

    first = True
    for ln in lines:
        p = cell.paragraphs[0] if first else cell.add_paragraph()
        first = False
        p.paragraph_format.space_after = Pt(1)
        _cn_font(p.add_run(ln), size=9)
    if verdict:
        p = cell.add_paragraph()
        p.paragraph_format.space_after = Pt(1)
        _cn_font(p.add_run(verdict), size=9, bold=True,
                 color=C_RED if "不合格" in verdict else C_ORANGE)
    _para(doc, "", size=3, space_after=2)


def _rule(doc, code, name, kind, points, checks, cases=None,
          not_judge=None, note=None):
    """渲染一条规则。"""
    head = f"{code}　{name}"
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(10)
    p.paragraph_format.space_after = Pt(3)
    _cn_font(p.add_run(head), size=12, bold=True, color=C_MAIN)

    # 类型与分值
    tail = doc.add_paragraph()
    tail.paragraph_format.space_after = Pt(4)
    kc = C_RED if kind == REDLINE else C_ORANGE
    _cn_font(tail.add_run(f"{kind} · {points}"), size=9, bold=True, color=kc)

    _label(doc, "查什么", checks, color=C_MAIN, indent=0)
    if cases:
        _label(doc, "真实案例", "", color=C_MAIN, indent=0)
        _case(doc, cases[0], cases[1] if len(cases) > 1 else None)
    if not_judge:
        _label(doc, "什么情况不判", not_judge, indent=0)
    if note:
        _label(doc, "说明", note, indent=0)


def build(out_path: Path):
    doc = Document()
    sec = doc.sections[0]
    sec.left_margin = sec.right_margin = Cm(2.0)
    sec.top_margin = sec.bottom_margin = Cm(1.8)

    _title(doc, "九江文旅 AI 通话质检规则说明",
           "共 18 条规则（红线 12 条 / 扣分 6 条；R13 双档）")

    # ================= 一、判定逻辑 =================
    _heading(doc, "一、先理解判定逻辑", 1)
    _body(doc, "质检只给两个结论：合格 / 不合格。没有「待定」或「观察」。")

    _para(doc, "", size=4, space_after=3)
    _label(doc, "两类规则", "", color=C_MAIN, indent=0)
    _grid_table(doc, ["类型", "含义", "后果"],
                [["红线", "AI 犯了绝对不能犯的错", "一票否决，直接 0 分，不合格"],
                 ["扣分", "做得不到位但有情可原", "从 100 分往下扣"]],
                widths=(2.4, 7.0, 7.4))

    _para(doc, "", size=4, space_after=3)
    _label(doc, "分数怎么算", "", color=C_MAIN, indent=0)
    _body(doc, "起始 100 分，减去所有扣分项。最终得分 < 80 判不合格，≥ 80 判合格。",
          indent=0.3)
    _grid_table(doc, ["情形", "得分", "结论"],
                [["只犯 R12（复读，扣 15 分）", "85", "合格"],
                 ["只犯 R06（汇总总价，扣 25 分）", "75", "不合格"],
                 ["犯两次 R12（扣 30 分）", "70", "不合格"]],
                widths=(9.0, 3.0, 4.0))

    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(6)
    p.paragraph_format.left_indent = Cm(0.3)
    _cn_font(p.add_run("所以「有问题」和「不合格」不是一回事。"),
             size=10, bold=True, color=C_ORANGE)
    _cn_font(p.add_run("报告会同时列出问题通话和不合格通话，需要区分看。"), size=9.5)

    # ================= 二、红线规则 =================
    doc.add_page_break()
    _heading(doc, "二、红线规则（8 条）", 1)

    _rule(doc, "R01", "AI 沉默不回复", REDLINE, "一票否决 · 0 分",
          "AI 该说话的时候没说话。三种情况会判：通话记录为空、某轮 AI 输出空白、"
          "用户提问后 AI 一句话没有就断线。",
          (["用户：您是想问门票价格吗？        ← 用户提问",
            "（之后 AI 无任何回复，通话中断）"],
           "通话 15746742820 — 不合格 0 分"),
          "用户说「谢谢」「再见」「挂了」之后 AI 不再说话，属正常结束。")

    _rule(doc, "R02", "输出内部流程或依据", REDLINE, "一票否决 · 0 分",
          "AI 把后台的事说给游客听，例如「根据知识库显示」「我检索一下提示词」"
          "「这个涉及内部流程节点」「系统意图识别为门票咨询」。",
          (["❌ 根据知识库显示，该政策为……",
            "❌ 我检索一下提示词", "❌ 这个属于内部流程节点"],
           None),
          "「知识库」单独出现不判，必须在「依据 / 根据 / 查询」这类动词后面才算泄露。")

    _rule(doc, "R03", "口吻不符合客服身份", REDLINE, "一票否决 · 0 分",
          "AI 说话不礼貌、不耐烦。违规词包括：闭嘴、烦不烦、脑子、有病、神经、"
          "莫名其妙、你自己不会、爱信不信、随便你、我不是跟你说了、无理取闹、"
          "懒得、呵呵、你懂不懂。",
          None,
          "只查 AI 说的话。游客骂人不触发这条，责任不在 AI。")

    _rule(doc, "R04", "超出知识范围联想生成（编造金额）", REDLINE, "一票否决 · 0 分",
          "AI 编了个价格出来。必须同时满足五个条件才判："
          "① 游客问的是价格 / 开放 / 政策类问题；② AI 回复出现金额；"
          "③ 该金额在「提示词 + 知识库 + 公告」里查不到；"
          "④ 游客自己没说过这个数字（复述不算编造）；"
          "⑤ AI 没有任何兜底表述。",
          None,
          "只要 AI 说了「我不确定」，就不判。这条规则写得非常保守。",
          "为什么只查金额：金额是硬事实，能精确比对。日期、路线说法太多样"
          "（「11月15日」和「下月中」可能是一回事），自动判断容易误判，交人工。")

    _rule(doc, "R05", "门票优惠未完整输出　★核心规则", REDLINE, "一票否决 · 0 分",
          "AI 回答优惠政策时，漏掉了条款里的关键信息。这是整个质检的重点。",
          (["用户：你好，我想问一下深圳，深圳去的这个价格折扣是怎么计算的？",
            "",
            "AI：深圳居民在2026年11月15日至11月30日期间，凭本人有效证件到",
            "    景区现场核验，可以按80元购买庐山门票，原价是160元。",
            "",
            "判定：条款要求包含「票价、资格/对象、证件、日期/有效期、限制提示」，",
            "      回复缺失「限制提示」"],
           "通话 15767795820 — 不合格 0 分"),
          None,
          "AI 说了票价、日期、证件、资格，但没说这条优惠不含观光车、索道等二次消费。"
          "游客可能以为 80 元全包，到现场才发现要另付钱，这就是要抓的问题。")

    _para(doc, "", size=4, space_after=2)
    _label(doc, "R05 判定四步", "", color=C_MAIN, indent=0)
    _grid_table(doc, ["步骤", "做法"],
                [["第 1 步 找条款",
                  "用游客问题里的具体信息匹配。「庐山」「九江」「门票」「景区」"
                  "这些词不参与匹配——它们几乎每句都有，参与匹配会把任何问门票的"
                  "问题错配到音乐节条款"],
                 ["第 2 步 看维度",
                  "只要求 AI 输出这条条款本来有的信息：票价 / 资格对象 / 证件 / "
                  "日期有效期 / 限制提示"],
                 ["第 3 步 查覆盖",
                  "从回答那轮开始往后，把所有 AI 回复合起来看，不只看单句。"
                  "分两轮说完也算合规"],
                 ["第 4 步 兜底放行",
                  "AI 明确说「不确定」「建议查小程序」「帮您转人工」就直接放行，"
                  "因为承认不知道比胡说好"]],
                widths=(3.2, 13.6))

    _rule(doc, "R06", "汇总计算总价", DEDUCT, "扣 25 分",
          "AI 帮游客把多个金额加起来报总价。出现「一共 / 总共 / 合计 / 加起来 / 总计」"
          "这类词，并且合并了两个以上不同金额。",
          (["AI：每个免票学生最多只能带2名亲属享受80元的优惠价。如果两个小朋友",
            "    都免票，那总共最多只能有4名亲属按80元购票，超出的亲属就得买",
            "    160元的成人票啦。"],
           "通话 15762897720 — 不合格 75 分"),
          None,
          "禁止汇总是因为一旦算错就是实际纠纷——游客拿着 AI 说的总价去现场，对不上账。")

    _rule(doc, "R07", "虚假处置或结果承诺", DEDUCT, "扣 25 分",
          "AI 承诺了自己做不到的事。两类："
          "① 假装已经办了——「已为您转接」「已通知」「已安排」「已帮您」「已开票」；"
          "② 打包票——「保证能」「保证入园」「保证免票」「一定能」「肯定可以」。",
          (["AI：票务余量是实时变动的，我这边没法给您打包票说一定能买到。",
            "    建议您出发前看看「一机游庐山」小程序的公告。"],
           "已修正 — 这句话曾被误判，现为合格 100 分"),
          "出现「没法 / 不能 / 无法 / 不敢」这类否定词，后面跟承诺词时，不判违规。",
          "这条规则踩过两个坑：第一，AI 说「我没法保证」恰恰是正确做法，"
          "曾因含「一定能」被误伤，现已修复并加入回归测试。"
          "第二，「保证」单独做关键词会误伤「社保证明」「保证金」，"
          "现在只匹配具体承诺句式。")

    _rule(doc, "R08", "给出未授权的联系方式", REDLINE, "一票否决 · 0 分",
          "AI 报了个电话，但这个号码不在白名单里。白名单只有："
          "4009006162、0792-8296666（等同于 07928296666）。",
          None, None,
          "号码错了，游客打过去要么没人接，要么是诈骗号，后果很严重。")

    _rule(doc, "R09", "活动有效期判断与条款矛盾", REDLINE, "一票否决 · 0 分",
          "AI 说「这个活动已经结束了」，但条款里明明写着还在有效期内。",
          None, None,
          "活动明明还在进行，AI 却说结束了，等于把客人赶走。")

    _rule(doc, "R10", "与停运公告冲突", REDLINE, "一票否决 · 0 分",
          "索道明明在检修，AI 却说正常运营。当前公告：庐山星龙索道停机检修，"
          "2026-11-05 至 2026-11-30。",
          None, None,
          "游客按 AI 说的去了，结果索道停着，白跑一趟。")

    # ================= 三、扣分规则 =================
    doc.add_page_break()
    _heading(doc, "三、扣分规则（另 4 条）", 1)
    _body(doc, "R06、R07 已在上一节说明（编号归在扣分档），这里说剩下 4 条。",
          color=C_GRAY)

    _rule(doc, "R11", "输出 Markdown 或内部格式", DEDUCT, "扣 25 分",
          "AI 把排版符号念出来了：回复里出现 # 标题、** 加粗、- 列表、1. 编号。",
          None, None,
          "语音场景下这些符号会被念成「井号」「星号」，听起来很奇怪。")

    _rule(doc, "R12", "无效重复追问", DEDUCT, "扣 15 分",
          "AI 把刚说过的话又说一遍，对话没往前走。三个条件都满足才判："
          "① 两轮都是问句；② 相似度 ≥ 80%；③ 长度 ≥ 20 字且中间有游客发言。",
          (["上一轮：背诗免票的话，除了南门游客服务中心，北门游客服务中心和",
            "        交通索道下站台也可以办理的。您看哪个方便就去哪个呗。",
            "",
            "本轮：  哎，我在呢。背诗免票除了南门，北门游客服务中心和",
            "        交通索道下站台也可以办的，您看哪个方便就去哪。"],
           "通话 15746736220 — 合格 85 分（有扣分但未到不合格线）"),
          "陈述句重复、开场欢迎语重复、转接提示重复、寒暄语重复，四类都不判。",
          "这个坑很严重：早期版本把开场欢迎语算作复读，15:00-16:00 那段"
          "11 通电话误判了 9 通，合格率直接崩。现在加了固定播报识别。")

    _rule(doc, "R13", "要求转人工未响应", REDLINE + " / " + DEDUCT, "0 分 或 扣 25 分",
          "两个档位：游客明确说「转人工」而 AI 一句话都没有 → 红线 0 分；"
          "AI 有回复但没真的转接 → 扣 25 分。",
          None,
          "已经转过人工了，游客再喊一次不算违规。")

    _rule(doc, "R14", "无依据且未兜底", DEDUCT, "扣 25 分",
          "AI 既不知道答案，又不肯说不知道，回复过短且没给核实路径。",
          (["用户：转人工服务。",
            "AI：您好，坐席正忙"],
           "通话 15829990920 — 不合格 60 分"),
          None,
          "正确做法应该说明当前情况，再给替代方案，比如"
          "「您可以先告诉我问题，我帮您记录」。")

    _rule(doc, "R15", "金额复核不合格", REDLINE, "0 分",
          "复核游客身份是否符合活动要求、门票价格是否正确；身份不符、"
          "金额不符、日期不符仍给优惠 → 红线。",
          (["用户：我是山东户籍的，能享受深圳居民80元优惠吗？",
            "AI:可以的，凭身份证到现场核验后就能按80元购买。"],
           "身份与条款适用范围不符，AI 仍给优惠 → 不合格"),
          None,
          "只核优惠价：正常票价（成人票160元）、「没有优惠」告知、"
          "总价汇总不判；用户问索道/观光车时不与门票条款配对。")

    _rule(doc, "R16", "户籍复核不合格", REDLINE, "0 分",
          "复核游客户籍是否符合活动要求，判断 AI 回复是否正确："
          "户籍符合却说不行、户籍不符却给优惠均不合格。",
          (["用户：我是南昌户籍的，交通索道有优惠吗？",
            "AI:不好意思，索道没有户籍优惠，需要购买全价票。"],
           "南昌户籍符合「九江、南昌居民索道优惠」范围，AI 错误拒绝 → 不合格"),
          None,
          "AI 明确告知适用范围（不在名单）或引导现场核验属正确答复。")

    _rule(doc, "R17", "索道观光车优惠不合格", REDLINE, "0 分",
          "判断是否乱给索道、观光车优惠：凭空折扣、门票含观光车、"
          "音乐节优惠金额报错均不合格。",
          (["用户：索道可以免费坐吗？",
            "AI:索道可以免费坐。"],
           "凭空给索道免费 → 不合格"),
          None,
          "票价表事实（观光车90元含上下山）、排除表述（需另外购买）、"
          "正确告知无优惠、儿童身高免票、乐迷五折均放行。")

    _rule(doc, "R18", "年龄相关优惠判断错误", REDLINE, "0 分",
          "年龄相关优惠给出错误口径：老年免票边界≠65周岁、秋假亲属人数≠2、"
          "儿童边界说错均不合格。",
          (["用户：我家老人65岁了吗？",
            "AI:60周岁以上老人凭身份证免票。"],
           "老年免票边界说成60岁 → 不合格"),
          None,
          "只核 AI 边界声明句；用户口述年龄被复述不算错；"
          "「18周岁以下」属秋假学子口径不按儿童边界判。")

    # ================= 四、不自动判定 =================
    doc.add_page_break()
    _heading(doc, "四、刻意不去自动判的 6 件事", 1)
    _body(doc, "有些事看起来该查，但故意不做自动判定，因为误判代价比漏判高。")
    _grid_table(doc, ["事项", "为什么不自动判"],
                [["路线 / 行程是否编造", "没有结构化的线路库可以比对"],
                 ["日期说法是否等价", "「11月15日」和「下月中」可能是一个意思，机器分不清"],
                 ["语速、打断、静音", "文本记录还原不出来"],
                 ["游客口音导致识别错误", "这是语音识别的锅，不该算 AI 的"],
                 ["单句意思是否等价", "必须结合上下文，只能人工看"],
                 ["转接后的等待播报重复", "固定播报，不是 AI 的决策"]],
                widths=(5.0, 11.8))
    _body(doc, "这些建议进人工抽检队列，不要硬写成自动规则。", color=C_ORANGE)

    # ================= 五、三条原则 =================
    _heading(doc, "五、质检口径的三条原则", 1)

    _lead(doc, "原则一：宁可漏判，不可误判")
    _body(doc, "自动质检最怕的不是漏掉问题，而是冤枉好的通话。一旦业务方发现"
               "「这条明明没问题却判不合格」，整个质检的可信度就没了。"
               "所以每条规则都写得很保守：只要能找到合理解释，就不判。", indent=0.4)

    _lead(doc, "原则二：每个结论都要有证据")
    _body(doc, "报告里每条问题都带：证据原话（AI 到底说了什么）、"
               "通话记录 id（能直接回去听录音）、对应条款（依据哪一条判的）。"
               "没有证据的结论一律不出。", indent=0.4)

    _lead(doc, "原则三：规则要能自我检验")
    _body(doc, "维护 18 条回归用例（11 条该判红线、7 条合格反例），"
               "每次改规则都要跑一遍，确保没把对的判成错的。", indent=0.4)

    _para(doc, "", size=4, space_after=2)
    _label(doc, "7 条合格反例（防误判护栏）", "", color=C_MAIN, indent=0.4)
    for s in ["完整合规的回答 → 合格",
              "正确兜底的回答 → 合格",
              "转人工已执行 → 合格",
              "合理澄清追问 → 合格",
              "节日政策回答 → 合格",
              "「社保证明」含保证 → 不得误判承诺",
              "开场欢迎语重复 → 不得误判复读"]:
        _body(doc, "· " + s, indent=0.9)

    # ================= 六、速查表 =================
    doc.add_page_break()
    _heading(doc, "六、规则总览速查表", 1)
    rows = [
        ["R01", "AI 沉默不回复", "红线", "0", "该说话时一句话没有"],
        ["R02", "输出内部依据", "红线", "0", "把后台术语说给游客听"],
        ["R03", "口吻不符客服", "红线", "0", "说话不礼貌不耐烦"],
        ["R04", "编造金额", "红线", "0", "说了查不到依据的价格"],
        ["R05", "门票优惠未完整", "红线", "0", "条款关键信息漏说"],
        ["R06", "汇总计算总价", "扣分", "25", "帮游客加总价"],
        ["R07", "虚假承诺", "扣分", "25", "承诺已办或打包票"],
        ["R08", "未授权联系方式", "红线", "0", "报了个野号码"],
        ["R09", "活动有效期矛盾", "红线", "0", "活动没结束说结束了"],
        ["R10", "与停运公告冲突", "红线", "0", "索道检修说正常"],
        ["R11", "输出 Markdown", "扣分", "25", "把排版符号念出来"],
        ["R12", "无效重复追问", "扣分", "15", "车轱辘话来回说"],
        ["R13", "转人工未响应", "红线/扣分", "0 / 25", "游客要转人工没反应"],
        ["R14", "无依据未兜底", "扣分", "25", "不知道还不承认"],
        ["R15", "金额复核不合格", "红线", "0", "身份/金额/日期不符仍给优惠"],
        ["R16", "户籍复核不合格", "红线", "0", "户籍判断错误仍答复"],
        ["R17", "索道观光车优惠不合格", "红线", "0", "乱给索道/观光车优惠"],
        ["R18", "年龄相关优惠判断错误", "红线", "0", "年龄优惠口径说错"],
    ]
    _grid_table(doc, ["编号", "规则", "类型", "分值", "一句话解释"], rows,
                widths=(1.6, 4.6, 2.4, 2.0, 6.2))
    _body(doc, "红线 12 条，扣分 6 条，合计 18 条（R13 既是红线也是扣分项）。", color=C_MAIN)
    p = doc.paragraphs[-1]
    for r in p.runs:
        r.bold = True

    # ================= 七、对照 =================
    _heading(doc, "七、和原始文档要求的对照", 1)
    _grid_table(doc, ["原始文档要求", "对应规则", "覆盖"],
                [["景区政策类按口径回复", "R05", "已覆盖"],
                 ["时间日期类严格按口径", "R05 / R09", "部分覆盖（等价表述交人工）"],
                 ["超出知识范围联想生成", "R04", "已覆盖（金额维度）"],
                 ["口吻不符合客服身份", "R03", "已覆盖"],
                 ["输出内部流程节点", "R02", "已覆盖"],
                 ["AI 沉默不回复", "R01", "已覆盖"],
                 ["禁止汇总总价", "R06", "已覆盖"],
                 ["不承诺处置结果", "R07", "已覆盖"],
                 ["不重复索要信息", "R12", "已覆盖"],
                 ["无答案须兜底", "R14", "已覆盖"],
                 ["不编造电话", "R08", "已覆盖"],
                 ["按公告判断停运", "R10", "已覆盖"],
                 ["路线 / 行程是否编造", "—", "未覆盖，需人工"]],
                widths=(6.4, 3.6, 6.8))
    _body(doc, "唯一没自动化的实质性要求是「路线行程是否编造」，"
               "因为没有结构化的线路数据库可以比对。", color=C_GRAY)

    _para(doc, "", size=6, space_after=4)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _cn_font(p.add_run("本文档由 jjwl-ls 质检技能生成，与 rules.py 实现一一对应。"),
             size=8, color=C_GRAY)

    doc.save(out_path)
    return out_path


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("质检规则说明.docx")
    print(build(out))
