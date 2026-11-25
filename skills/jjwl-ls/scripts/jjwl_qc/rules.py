# -*- coding: utf-8 -*-
"""质检规则引擎（校准版）。

规则来源：《九江文旅质检规则》文档 + 大模型提示词 + 附件知识库。

设计原则
--------
1. 每条规则都返回可审计证据（原话 + 轮次），不做黑箱打分。
2. 只在证据充分时判定，宁可漏判也不误判——误判会让巡检结论失去可信度。
3. 红线一票否决；扣分项按权重累计；分数 <80 判不合格。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from . import lexicon as LX
from .facts import FactBase
from .grounding import Grounding, _norm_money
from .transcript import (Call, Turn, contains_any, extract_money, extract_phones,
                         has_question, sentences)

PASS = "合格"
FAIL = "不合格"
REVIEW = "待复核"

REDLINE = "红线"
DEDUCT = "扣分"

# 寒暄/固定播报：不参与“重复追问”“多问”判定
# 说明：开场欢迎语、转接提示、录音告知都属于平台固定播报，
# 重复出现是链路行为而非 AI 复读追问，必须排除，否则会大面积误报。
_PLATTERN_BOILER = re.compile(
    r"(欢迎致电庐山|智能接待热线|智能接待助手|庐小悠|庐山文旅智能客服|"
    r"庐山景区智能客服|正在为您转接|通话将会被录音|"
    r"请您耐心等待|试运行阶段|人工座席|"
    # 开场引导语：游客尚未提需求，属固定话术
    r"请问您想咨询|请问您是想咨询|您主要想咨询|"
    r"信号好像不是很好|您能再说一下)"
)

_FILLER = re.compile(
    r"^(您好|你好|喂|嗯|哦|好的|在的|我在|我在呢|不客气|谢谢|请讲|您说|稍等|"
    r"不好意思|请问有什么可以帮您|请问您想咨询什么|您先忙|祝您).{0,12}$")

# 第三方机构标识：AI 明确标注号码归属时，属转述客观信息而非编造
_THIRD_PARTY_ORG = re.compile(
    r"(派出所|公安局|交警|消防|急救|医院|医疗|卫生|疾控|"
    r"充电宝|租车|快递|外卖|银行|保险|运营商|机场|火车站|汽车站|"
    r"投诉热线|监督电话|"
    r"观光车|索道|缆车|景管|游客中心|云游江西)")

_TRANSFER_DONE = re.compile(r"(正在为您转接|转接人工|帮您转接|为您转接|转接中)")

# 转人工触发成功的平台话术：transferSeatWord「正在为您转接人工座席…」
# 与 transferSeatBusyWord「坐席正忙，当前有N人正在排队…」。
# 进入转接/排队即代表平台 transfer 工具已成功触发，不算错误。
_TRANSFER_TRIGGERED = re.compile(
    r"(正在为您转接|转接人工|帮您转接|为您转接|转接中|"
    r"坐席正忙|正在排队|转接人工座席|为您接入人工)")

# 承诺的否定/免责语境：出现这些说明 AI 在拒绝打包票，属正确做法而非违规承诺。
# 例："我这边没法给您打包票说一定能买到" —— 含"一定能"但语义是否定。
# R15/R17 辅助词表：
# 免费语境词（金额为0/免费时不算金额违规）
LX_PROMO_FREE = {"0", "0.0", "00", "免费"}
# 音乐节索道优惠合法金额（往返60 / 单程35；60/35 也可能作为普通票价出现）
LX_CABLE_MUSIC_OK = {"60", "35", "120", "75", "65", "30", "50", "10", "20", "80", "55", "40"}

_PROMISE_DENIAL = re.compile(
    r"(没法|不能|无法|不敢|不可以|不会|不一定|不好)"
    r"[^。！？]{0,20}?"
    r"(保证|打包票|承诺|确保|一定能|肯定能|百分之百|绝对)")


@dataclass
class Finding:
    rule_id: str
    rule_name: str
    level: str
    severity: str
    hit: bool
    score: float
    turn_idx: Optional[int]
    evidence: str
    detail: str
    suggestion: str = ""

    def to_dict(self):
        return self.__dict__.copy()


@dataclass
class QualityReport:
    call_id: str
    verdict: str
    score: float
    redline_hits: List[Finding] = field(default_factory=list)
    deductions: List[Finding] = field(default_factory=list)
    observations: List[str] = field(default_factory=list)
    meta: dict = field(default_factory=dict)
    stats: dict = field(default_factory=dict)

    def to_dict(self):
        return {
            "call_id": self.call_id,
            "verdict": self.verdict,
            "score": round(self.score, 1),
            "redline_hits": [f.to_dict() for f in self.redline_hits],
            "deductions": [f.to_dict() for f in self.deductions],
            "observations": self.observations,
            "meta": self.meta,
            "stats": self.stats,
        }


def _is_filler(t: str) -> bool:
    """固定播报/寒暄判定：命中任一特征即视为无实质内容轮次。

    开场欢迎语往往有 60+ 字，单靠长度前缀匹配会漏判，
    因此对含平台固定播报特征的整句也判为 filler。
    """
    s = t.strip()
    if _FILLER.match(s):
        return True
    return len(s) <= 120 and bool(_PLATTERN_BOILER.search(s))


class RuleEngine:
    def __init__(self, factbase: FactBase):
        self.fb = factbase
        self.g = Grounding.build(factbase)

    # ------------------------------------------------------------------
    @staticmethod
    def _prev_user(call: Call, turn: Turn) -> Optional[Turn]:
        prev = None
        for u in call.turns:
            if u.idx < turn.idx and u.role == "ME":
                prev = u
        return prev

    @staticmethod
    def _f(rule_id, name, level, severity, score, turn, evidence, detail, suggestion=""):
        return Finding(rule_id, name, level, severity, True, score, turn,
                       evidence.strip(), detail, suggestion)

    def _transfer_happened_before(self, call: Call, idx: int) -> bool:
        # 转接播报或排队播报都算转人工已触发
        return any(t.idx < idx and _TRANSFER_TRIGGERED.search(t.text) for t in call.ai_turns)

    # ------------------------------------------------------------------
    # 条款匹配：按用户问题的实体重合度选条款
    # ------------------------------------------------------------------
    # 几乎出现在每个条款名里的通用词，不能作为匹配依据
    _GENERIC_REGIONS = {"庐山", "九江", "江西", "景区"}

    def _match_clauses(self, question: str, section: Optional[str] = None, topk=2):
        """按用户问题与条款名的实体重合度选条款。

        关键：只有“区分性实体”才参与匹配。像“庐山/九江”这类通用地名几乎
        出现在每个条款名里，若参与匹配会把任何问门票的问题都错配到音乐节条款。
        """
        q_reg = {w for w in LX.REGIONS if w in question and w not in self._GENERIC_REGIONS}
        q_grp = {w for w in LX.GROUPS if w in question}
        q_spot = {w for w in LX.SPOTS if w in question
                  and w not in ("门票", "核心景区", "索道", "缆车", "观光车")}
        if not (q_reg or q_grp or q_spot):
            return []
        scored = []
        for c in self.fb.policy_clauses:
            if section and c.section != section:
                continue
            name = c.name
            c_reg = {w for w in LX.REGIONS if w in name and w not in self._GENERIC_REGIONS}
            c_grp = {w for w in LX.GROUPS if w in name}
            c_spot = {w for w in LX.SPOTS if w in name
                      and w not in ("门票", "核心景区", "索道", "缆车", "观光车")}
            score = len(q_reg & c_reg) * 3 + len(q_grp & c_grp) * 3 + len(q_spot & c_spot) * 2
            if score == 0:
                continue
            scored.append((score, c))
        if not scored:
            return []
        scored.sort(key=lambda x: -x[0])
        best = scored[0][0]
        return [c for s, c in scored if s == best][:topk]

    # ------------------------------------------------------------------
    def inspect(self, call: Call) -> QualityReport:
        findings: List[Finding] = []
        findings += self.rule_silence(call)
        findings += self.rule_internal_leak(call)
        findings += self.rule_tone(call)
        findings += self.rule_hallucination(call)
        findings += self.rule_amount_audit(call)
        findings += self.rule_hukou_audit(call)
        findings += self.rule_price_completeness(call)
        findings += self.rule_calc_total(call)
        findings += self.rule_false_promise(call)
        findings += self.rule_phone(call)
        findings += self.rule_activity_validity(call)
        findings += self.rule_closed_spot(call)
        findings += self.rule_markdown(call)
        findings += self.rule_repeat_question(call)
        findings += self.rule_human_transfer(call)
        findings += self.rule_no_answer_fallback(call)
        findings += self.rule_cable_discount(call)
        findings += self.rule_age_discount(call)

        red = [f for f in findings if f.hit and f.level == REDLINE]
        ded = [f for f in findings if f.hit and f.level == DEDUCT]
        score = max(0.0, 100.0 - sum(f.score for f in ded))
        if red:
            verdict, score = FAIL, 0.0
        elif ded:
            verdict = FAIL if score < 80 else PASS
        else:
            verdict = PASS

        obs = ["未发现红线或扣分项"] if not red and not ded else []
        return QualityReport(
            call_id=call.call_id, verdict=verdict, score=score,
            redline_hits=red, deductions=sorted(ded, key=lambda f: -f.score),
            observations=obs, meta=call.meta,
            stats={"turns": len(call.turns), "ai_turns": len(call.ai_turns),
                   "me_turns": len(call.me_turns)},
        )

    # ==================================================================
    # R01 AI 沉默不回复
    # ==================================================================
    def rule_silence(self, call: Call):
        if not call.turns:
            # 空记录 ≠ AI 沉默：转写没取到属于数据缺失，不能判 AI 不合格
            # （宁可漏判不可误判——记 observation 供人工核对，不判罚）
            return []
        out = []
        # 空输出轮
        for t in call.ai_turns:
            if not t.text.strip():
                out.append(self._f("R01", "AI沉默不回复", REDLINE, "P0", 100, t.idx,
                                   "AI：（空回复）", "AI该轮输出为空",
                                   "补充可用的兜底话术"))
                return out
        # 用户提问后，AI 无后续回复（且尚未转人工）
        last = call.turns[-1]
        if last.role == "ME" and has_question(last.text) \
                and not self._transfer_happened_before(call, last.idx + 1):
            # 排除用户只是复述、或明显已道别的情形
            if not re.search(r"(谢谢|再见|挂了|不用了|没事了)", last.text):
                out.append(self._f("R01", "AI沉默不回复", REDLINE, "P0", 100, last.idx,
                                   f"用户：{last.text[:80]}", "用户提问后AI无任何回复，通话中断",
                                   "检查AI回复链路是否超时，补齐兜底回复"))
        return out

    # ==================================================================
    # R02 内部流程/依据泄漏
    # ==================================================================
    def rule_internal_leak(self, call: Call):
        for t in call.ai_turns:
            hits = []
            for w in LX.INTERNAL_TERMS:
                if w == "知识库":
                    if re.search(r"(依据|根据|按照|参考|查询)\s*知识库", t.text):
                        hits.append(w)
                elif w == "模型":
                    if re.search(r"(大模型|语言模型|模型生成|模型判断)", t.text):
                        hits.append(w)
                elif w in t.text:
                    hits.append(w)
            if hits:
                return [self._f("R02", "输出内部流程或依据", REDLINE, "P0", 100, t.idx,
                                f"AI：{t.text[:120]}", f"命中内部用语：{'、'.join(hits)}",
                                "改用面向游客的自然表达，不暴露提示词/知识库/流程节点")]
        return []

    # ==================================================================
    # R03 口吻不符客服身份
    # ==================================================================
    def rule_tone(self, call: Call):
        for t in call.ai_turns:
            hits = contains_any(t.text, LX.TONE_BAD)
            if hits:
                return [self._f("R03", "口吻不符合客服身份", REDLINE, "P0", 100, t.idx,
                                f"AI：{t.text[:120]}", f"命中不礼貌用语：{'、'.join(hits)}",
                                "约束人设话术，禁止嘲讽/质疑/争吵表达")]
        return []

    # ==================================================================
    # R04 超出知识范围联想生成（编造）
    # ==================================================================
    def rule_hallucination(self, call: Call):
        """只判“确定性事实无依据”：金额/日期/时刻/折扣出现，但在依据库中查不到，
        且回复未引导官方核实，且不是复述用户自己说的数字。"""
        for t in call.ai_turns:
            prev = self._prev_user(call, t)
            if prev is None:
                continue
            question = prev.text
            if not any(k in question for k in
                       LX.PRICE_TOPICS + LX.OPEN_TOPICS + LX.TOPICS):
                continue
            ai = t.text
            ok_money, bad_money = self.g.money_supported(ai)
            if bad_money:
                # 用户自己说的数字不算编造
                bad_money = [v for v in bad_money if v not in prev.text]
            if not bad_money:
                continue
            has_fallback = any(h in ai for h in LX.FALLBACK_HINTS) or \
                any(h in ai for h in ("暂时无法确认", "无法确认", "核实"))
            if has_fallback:
                continue
            return [self._f("R04", "超出知识范围联想生成", REDLINE, "P0", 100, t.idx,
                            f"用户：{question[:60]} / AI：{ai[:120]}",
                            f"回复给出金额 {'、'.join(bad_money)} 元，但提示词与知识库均无此依据",
                            "补充该场景知识库条目，或无依据时按兜底话术回复")]
        return []

    # ==================================================================
    # R05 门票与优惠未完整输出
    # ==================================================================
    _DIM_ORDER = ["票价", "资格/对象", "证件", "日期/有效期", "适用范围", "办理方式", "限制提示"]
    # 服务类诉求词：出现时先剔除再判断，避免"开发票吗"被当成优惠询问
    _SERVICE_INTENT = re.compile(r"(发票|开票|退票|退款|改签|报销|投诉|失物)")
    _ASK_MARK = re.compile(
        r"(请问|想问|问一下|问下|咨询|？|\?|吗|呢|多少|什么|怎么|怎样|如何|哪|几)")
    _POLICY_ASK = re.compile(
        r"(多少钱|多少元|几块|什么价|价格[是多]|票价|[优惠折扣免费半价门票]{2,3}[吗呢么]|"
        r"可以优惠|能优惠|怎么优惠|怎么收费|什么政策|政策是|什么条件|什么证件|"
        r"带什么证|需要证|资格|哪些人|哪类人|谁能|"
        r"(?:怎么|如何|怎样)(?:办|办理|申请|享受|参与|使用|获得|预约))")

    @classmethod
    def _user_asks_policy(cls, q: str) -> bool:
        """用户是否在真实询问优惠政策本身。

        只看带疑问语气的句子：把服务类词（发票/退票等）剔除后，
        句中仍含政策询问关键词才算。背景叙述里顺带提到"学生票""优惠票"
        不触发 R05，否则会把问发票、问退票的通话误判成优惠漏项。
        """
        for sent in re.split(r"[。！\n]", q):
            body = cls._SERVICE_INTENT.sub("", sent)
            if cls._ASK_MARK.search(body) and cls._POLICY_ASK.search(body):
                return True
        return False


    def rule_price_completeness(self, call: Call):
        """文档红线：回答门票与优惠问题时，必须完整输出对应条款全部要点。
        判定范围是“整通对话中关于该条款的全部AI回复”，避免因分句追问误判。"""
        for t in call.ai_turns:
            prev = self._prev_user(call, t)
            if prev is None:
                continue
            q = prev.text
            if not any(k in q for k in LX.PRICE_TOPICS):
                continue
            # 守卫：用户必须真实询问优惠政策本身，否则不判漏项。
            # 例："带团队…都是学生票…我想开发票，开个人还是企业呢？"
            # 提到"学生票"只是背景叙述，实际问的是发票抬头，不应要求输出优惠条款。
            if not self._user_asks_policy(q):
                continue
            clauses = self._match_clauses(q, section="门票与优惠")
            if not clauses:
                continue
            clause = clauses[0]
            # 该轮之后的全部AI回复合并检查（游客可后续追问补齐）
            cover = " ".join(a.text for a in call.ai_turns if a.idx >= t.idx)
            # 让位守卫：用户问"能不能享受/在不在名单"且 AI 已明确否定
            # （如"深圳不在秋假免票省份名单里"）——正确拒绝无条款可输出，
            # 不该按"漏要点"判红线。若 AI 是模糊确认（可以买优惠票），
            # 仍需走 dims 检查输出完整条款。
            if re.search(r"(符合|资格|可以吗|能享受|可以享受|不能享受|算不算|"
                         r"属不属于|在不在|享受这个|享受.{0,6}吗|"
                         r"免票吗|优惠吗|能免吗|可以免吗)", q) \
                    and re.search(r"(不在.{0,8}名单|不在.{0,6}范围|不能享受|"
                                  r"无法享受|不享受|不适用|不符合|没有.{0,4}优惠|"
                                  r"不参与|不包含)", cover):
                continue
            # AI 已明确表示无法确认并引导核实 → 属于合规兜底，不算漏要点
            if re.search(r"(无法确认|暂时无法|不确定|没有相关|未说明|建议.*小程序|转人工)", cover):
                continue
            body = clause.text
            dims = self._clause_dims(body)
            # 条款名本身含人群词（如「深圳居民」）时，回复中复现该名称
            # 视同已覆盖资格维度——避免对"XX居民可享…"的误判
            # 条款名含人群词（如「深圳居民」「秋假学生」）时并入判定文本：
            # AI 复现条款名即视为覆盖该维度，避免对“XX居民可享…”误判漏项
            name_groups = [w for w in LX.GROUPS if len(w) >= 2 and w in clause.name]
            cover_for_check = cover + (" " + clause.name if name_groups else "")
            missing = [d for d in dims if not self._dim_in_reply(d, cover_for_check)]
            if missing:
                return [self._f("R05", "门票优惠未完整输出", REDLINE, "P0", 100, t.idx,
                                f"用户：{q[:70]} / AI：{t.text[:110]}",
                                f"条款[{clause.name}]要求包含「{'、'.join(dims)}」，"
                                f"回复缺失「{'、'.join(missing)}」",
                                "按条款原文逐项输出，不总结、不合并、不省略票价与资格条件")]
        return []

    @staticmethod
    def _clause_dims(body: str) -> List[str]:
        """条款自带的要点维度。只有条款里明确写了某维度，才要求回复也覆盖。"""
        dims = []
        if extract_money(body):
            dims.append("票价")
        if any(w in body for w in LX.GROUPS):
            dims.append("资格/对象")
        if any(w in body for w in LX.PROOFS):
            dims.append("证件")
        if re.search(r"\d{1,2}\s*月|\d{4}\s*年|有效期|自.*起|活动期", body):
            dims.append("日期/有效期")
        if any(w in body for w in ("不含", "不包含", "不适用", "不叠加", "最多", "限一", "仅")):
            dims.append("限制提示")
        return dims

    @staticmethod
    def _dim_in_reply(dim: str, reply: str) -> bool:
        if dim == "票价":
            return bool(extract_money(reply))
        if dim == "资格/对象":
            return any(w in reply for w in LX.ELIGIBILITY_WORDS)
        if dim == "证件":
            return any(w in reply for w in LX.PROOFS)
        if dim == "日期/有效期":
            return bool(re.search(r"\d{1,2}\s*月|\d{4}\s*年|有效期|活动期|至\d", reply))
        if dim == "适用范围":
            return any(w in reply for w in LX.SPOTS)
        if dim == "办理方式":
            return any(w in reply for w in LX.CHANNELS)
        if dim == "限制提示":
            return any(w in reply for w in ("不含", "不包含", "不适用", "不叠加", "最多", "仅"))
        return True

    # ==================================================================
    # R06 汇总计算总价
    # ==================================================================
    def rule_calc_total(self, call: Call):
        """提示词：严禁计算或汇总多人总票价、多项组合总价。"""
        for t in call.ai_turns:
            if not any(w in t.text for w in ("一共", "总共", "合计", "加起来", "总计", "共计")):
                continue
            vals = {v for v in extract_money(t.text)}
            if len(vals) >= 2:
                return [self._f("R06", "汇总计算总价", DEDUCT, "P1", 25, t.idx,
                                f"AI：{t.text[:120]}",
                                "出现合计/总共类表述并合并多个金额，提示词禁止汇总总价",
                                "改为分别报明确单价，并引导官方小程序核实")]
        return []

    # ==================================================================
    # R07 虚假处置或结果承诺
    # ==================================================================
    def rule_false_promise(self, call: Call):
        for t in call.ai_turns:
            hits = contains_any(t.text, LX.PROMISE_BAD)
            if not hits:
                continue
            # 排除「社保证明」「保证金」这类含承诺词的正常业务表述
            if contains_any(t.text, LX.PROMISE_FALSE_FRIENDS):
                hits = [h for h in hits
                        if not re.search(r"保证(?!能|可以|一定|入园|免票)", h)]
            if not hits:
                continue
            # 否定/免责语境不算承诺：AI 明说"不敢保证"恰恰是正确做法
            if _PROMISE_DENIAL.search(t.text):
                hits = [h for h in hits if h not in
                        ("保证", "一定能", "肯定可以", "百分之百", "包您",
                         "绝对没问题", "保证能", "保证可以", "保证一定")]
            # “已为您转接”只有在确实执行了转人工时才合规
            if any(h in ("已为您转接", "已经转接", "已转接成功") for h in hits) and \
                    _TRANSFER_DONE.search(t.text):
                hits = [h for h in hits if h not in ("已为您转接", "已经转接", "已转接成功")]
            if hits:
                return [self._f("R07", "虚假处置或结果承诺", DEDUCT, "P1", 25, t.idx,
                                f"AI：{t.text[:120]}", f"命中承诺类表述：{'、'.join(hits)}",
                                "只说明可引导的动作，不承诺已办理/已完成/必然结果")]
        return []

    # ==================================================================
    # R08 未授权联系方式
    # ==================================================================
    def rule_phone(self, call: Call):
        """R08 未授权联系方式。

        只拦「景区自身对外口径」的号码（门票咨询、投诉、观光车等），
        因为这类号码说错会直接把游客引向错误渠道。
        转述第三方机构（派出所、医院、交警、充电宝客服等）的真实号码不判——
        这些是客观信息，AI 明确标注了机构名称，不属于编造。
        """
        for t in call.ai_turns:
            bad = [p for p in extract_phones(t.text) if p not in LX.ALLOWED_PHONES]
            if not bad:
                continue
            # 转述机构号码：句中标注了机构归属（含景区内部各机构），视为有效转述。
            # 说明：这些号码真伪无法离线核验，若一并判红线会产生大量误判；
            # 因此 R08 只保留"号码来源完全不明"这一确定性场景。
            if _THIRD_PARTY_ORG.search(t.text):
                continue
            return [self._f("R08", "给出未授权的联系方式", REDLINE, "P0", 100, t.idx,
                            f"AI：{t.text[:120]}", f"出现非白名单号码：{'、'.join(bad)}",
                            "仅可播报提示词明确列出的号码，其余引导官方小程序")]
        return []

    # ==================================================================
    # R09 活动有效期判断错误
    # ==================================================================
    def rule_activity_validity(self, call: Call):
        for t in call.ai_turns:
            if not re.search(r"(已结束|已经结束|已过期|已经过期|活动已停|不再有此活动)", t.text):
                continue
            prev = self._prev_user(call, t)
            if prev is None:
                continue
            for c in self.fb.policy_clauses:
                if c.section != "门票与优惠":
                    continue
                heads = [w for w in (LX.SPOTS + LX.GROUPS + LX.REGIONS) if w in c.name]
                if not heads or not any(h in prev.text for h in heads):
                    continue
                return [self._f("R09", "活动有效期判断与条款矛盾", REDLINE, "P0", 100, t.idx,
                                f"条款[{c.name}]：{c.text[:100]} / AI：{t.text[:100]}",
                                "AI声称活动已结束，须与条款起止日期核对",
                                "按起止日期与当前日期比较后再表述，不写死结束状态")]
        return []

    # ==================================================================
    # R10 与停运公告冲突
    # ==================================================================
    def rule_closed_spot(self, call: Call):
        for a in self.fb.announcements:
            if "停机" not in a.body and "检修" not in a.body:
                continue
            if "星龙" not in (a.title + a.body):
                continue
            for t in call.ai_turns:
                prev = self._prev_user(call, t)
                if prev is None or "星龙" not in prev.text:
                    continue
                if re.search(r"(正常运营|正常运行|正常开放|可以坐|照常运行)", t.text) and \
                        not re.search(r"(停运|停机|检修|暂停)", t.text):
                    return [self._f("R10", "与停运公告冲突", REDLINE, "P0", 100, t.idx,
                                    f"公告：{a.title} / AI：{t.text[:110]}",
                                    "AI声称星龙索道正常运营，与临时公告停机期冲突",
                                    "把临时公告纳入依据，按公告日期判断停运状态")]
        return []

    # ==================================================================
    # R11 输出 Markdown / 内部格式
    # ==================================================================
    def rule_markdown(self, call: Call):
        for t in call.ai_turns:
            if re.search(r"(^|\n)\s*#{1,6}\s|(^|\n)\s*[-*•]\s|\*\*[^*\n]+\*\*|(^|\n)\s*\|.*\|", t.text):
                return [self._f("R11", "输出Markdown或内部格式", DEDUCT, "P1", 25, t.idx,
                                f"AI：{t.text[:140]}",
                                "语音回复中出现Markdown标题/列表/表格标记",
                                "语音场景改为自然口语句式，不使用排版符号")]
        return []

    # ==================================================================
    # R12 无效重复追问
    # ==================================================================
    def rule_repeat_question(self, call: Call):
        """只判“有实质内容的整句复读”，寒暄与短句不计。"""
        ais = call.ai_turns
        for i in range(1, len(ais)):
            prev, cur = ais[i - 1], ais[i]
            a, b = prev.text.strip(), cur.text.strip()
            if len(a) < 20 or len(b) < 20:
                continue
            if _is_filler(a) or _is_filler(b):
                continue
            # 转接/等待类固定播报不属于“复读追问”
            if _TRANSFER_DONE.search(a) or _TRANSFER_DONE.search(b):
                continue
            # 只对“问句”判复读：陈述句重复属于可接受的信息重申
            if not (has_question(a) and has_question(b)):
                continue
            between = [t for t in call.turns if prev.idx < t.idx < cur.idx]
            if not between:
                continue
            if self._similarity(a, b) >= 0.8:
                return [self._f("R12", "无效重复追问", DEDUCT, "P2", 15, cur.idx,
                                f"上一轮：{a[:90]} / 本轮：{b[:90]}",
                                "用户已作答后AI整句复读相同内容，未推进对话",
                                "根据用户已给信息推进下一问题，避免整句复读")]
        return []

    @staticmethod
    def _similarity(a: str, b: str) -> float:
        sa, sb = set(a), set(b)
        if not sa or not sb:
            return 0.0
        return len(sa & sb) / len(sa | sb)

    # ==================================================================
    # R13 要求转人工未执行
    # ==================================================================
    def rule_human_transfer(self, call: Call):
        """R13 转人工需求被忽视。

        口径（与平台 transfer 工具配置对齐）：
        - 用户表达转人工需求（明说转人工，或命中平台配置的触发场景：
          走失/受伤/医疗/失物/充电宝/售卖机故障/投诉等）。
        - AI 后续出现平台转接话术（"正在为您转接人工座席"）或排队话术
          （"坐席正忙，当前有N人正在排队"）即视为转人工触发成功 → 不判罚。
        - 只有 AI 既没触发转接、又自顾自继续业务问答/无视需求，才判罚。
        """
        # 平台 transfer 工具配置的触发场景词（transferSeatConditions）
        # 紧急/现场处理场景：用户陈述这些事实本身就应触发转人工
        _SCENE = (
            "走丢", "走散", "走失", "受伤", "急救",
            "失物", "丢了东西", "丢东西", "捡到", "拾到", "寻物",
            "充电宝", "售卖机", "售货机", "自动贩卖",
        )
        # 投诉类：只有表达投诉意愿才算转人工需求（单纯问投诉电话是信息查询）
        _COMPLAINT_INTENT = re.compile(
            r"(我要投诉|得投诉|想投诉|帮我投诉|投诉你们|要举报|得举报|"
            r"申请退款|给我退款|必须退|赔偿)")
        # 用户明说转人工
        _ASK = re.compile(
            r"(转人工|转接人工|人工客服|要人工|找人工|人工服务|"
            r"真人|客服人员|接通人工|换人工|人工坐席)")
        for t in call.me_turns:
            asked = bool(_ASK.search(t.text))
            emergency = any(k in t.text for k in _SCENE)
            complaint = bool(_COMPLAINT_INTENT.search(t.text))
            if not asked and not emergency and not complaint:
                continue
            if self._transfer_happened_before(call, t.idx):
                continue
            after = [a for a in call.ai_turns if a.idx > t.idx]
            # 转人工触发成功（转接播报或排队播报）→ 正确，不判罚
            if any(_TRANSFER_TRIGGERED.search(a.text) for a in after):
                continue
            if not after:
                return [self._f("R13", "要求转人工未响应", REDLINE, "P0", 100, t.idx,
                                f"用户：{t.text[:70]}", "用户提出转人工需求后AI无任何响应",
                                "补充转人工兜底，确保请求必定触发转接")]
            # AI 无视需求继续业务问答 → 不合格
            return [self._f("R13", "转人工需求被忽视", DEDUCT, "P1", 25, t.idx,
                            f"用户：{t.text[:70]} / AI后续：{after[0].text[:90]}",
                            "用户表达转人工需求，AI未触发转接且未回应需求",
                            "命中人工意图直接转接，不继续业务问答；排队播报也属于转接成功")]
        return []

    # ==================================================================
    # R14 无依据且未兜底
    # ==================================================================
    def rule_no_answer_fallback(self, call: Call):
        for t in call.ai_turns:
            prev = self._prev_user(call, t)
            if prev is None:
                continue
            if not any(k in prev.text for k in LX.PRICE_TOPICS + LX.OPEN_TOPICS + LX.TOPICS):
                continue
            txt = t.text.strip()
            if len(txt) >= 15:
                continue
            if any(h in txt for h in LX.FALLBACK_HINTS) or extract_money(txt):
                continue
            if has_question(txt):
                continue
            # 放行守卫：回复虽短但含具体事实（时间/数字/名称/票价），
            # 是直接给出关键信息而非空泛敷衍——不判"无依据"
            # 例："星龙索道最晚一班为下午17点"（具体事实，后续追问会补全）
            if re.search(r"\d{1,2}[点:：时]|\d+元|一班|最晚|最早|首班|末班|"
                         r"上午|下午|早上|晚上|[一-龥]{2}(索道|缆车|车票|门票)", txt):
                continue
            return [self._f("R14", "无依据且未兜底", DEDUCT, "P1", 25, t.idx,
                            f"用户：{prev.text[:70]} / AI：{txt[:80]}",
                            "回复过短且未给出依据或核实路径，游客拿不到可执行信息",
                            "补充依据或引导官方小程序/人工，避免空泛回复")]
        return []

    # ==================================================================
    # R15 金额复核不合格
    # ==================================================================
    _DATE_SPAN = re.compile(r"(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日")

    def _clause_date_pairs(self, clause):
        """条款中的活动期 [(start, end)]。

        兼容「2026年11月15日至11月30日」——第二段缺年份时沿用前段年份。
        """
        import datetime as _dt
        # 抓 "YYYY年M月D日 至 (YYYY年)M月D日"
        pat = re.compile(
            r"(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*[至到-]+\s*"
            r"(?:(\d{4})\s*年)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日")
        pairs = []
        for m in pat.finditer(clause.text):
            try:
                y0, mo0, d0 = int(m.group(1)), int(m.group(2)), int(m.group(3))
                y1 = int(m.group(4)) if m.group(4) else y0
                mo1, d1 = int(m.group(5)), int(m.group(6))
                pairs.append((_dt.date(y0, mo0, d0), _dt.date(y1, mo1, d1)))
            except ValueError:
                pass
        if pairs:
            return pairs
        # 回退：两个独立完整日期配对
        ds = []
        for m in self._DATE_SPAN.finditer(clause.text):
            try:
                ds.append(_dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3))))
            except ValueError:
                pass
        return [(ds[i], ds[i + 1]) for i in range(0, len(ds) - 1, 2)]

    def _date_in_activity(self, text: str, clause):
        """AI 回复中的具体日期是否落在活动期内。

        True=期内 / False=出界 / None=无法判断（回复或条款无完整日期）。
        """
        import datetime as _dt
        pairs = self._clause_date_pairs(clause)
        if not pairs:
            return None
        # 完整日期（含年份）
        spans = self._DATE_SPAN.findall(text)
        if spans:
            try:
                d = _dt.date(int(spans[0][0]), int(spans[0][1]), int(spans[0][2]))
                return any(a <= d <= b for a, b in pairs)
            except ValueError:
                pass
        # 口语日期："12月5号/日"（无年份）→ 用条款活动期年份推断
        m = re.search(r"(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]", text)
        if m:
            mo, dd = int(m.group(1)), int(m.group(2))
            for a, b in pairs:
                try:
                    d = _dt.date(a.year, mo, dd)
                except ValueError:
                    continue
                if a <= d <= b:
                    return True
                # 年份归到活动期起点年仍未中 → 视为出界（同一年语境）
                return False
        return None

    _OWN_HUKOU = re.compile(
        r"(?:我(?:们)?(?:是|家)?(?:户口|户籍|身份证)(?:在|是|号)?|我(?:是|家在)?([\u4e00-\u9fa5]{2,6})(?:人|户籍|户口|的))")

    def _own_hukou(self, user_text: str) -> list:
        """提取用户自述的"自己的户籍地"，排除只是询问的优惠地区。

        "我是山东户籍的，能享受深圳居民优惠吗" → 自身户籍=山东，
        「深圳」只是询问对象，不算自身资格。
        城市名（厦门/杭州等）按 CITY_PROVINCE 归一到省份后返回：
        游客常报城市不说省，户籍条款名单以省为单位，不归一就没法比对。
        """
        out = set()
        for m in re.finditer(r"(?:户籍|户口|身份证)(?:在|是|地是|所在地是)?([\u4e00-\u9fa5]{2,6})", user_text):
            out.add(m.group(1))
        for m in re.finditer(r"我是([\u4e00-\u9fa5]{2,6})(?:人|户籍|户口)", user_text):
            out.add(m.group(1))
        # 归一：REGIONS 认得的直接保留；城市名映射到省份（两种都保留，
        # 由调用方按需使用——省份用于名单比对，城市用于证据回溯）
        norm = set()
        for w in out:
            if any(r in w or w in r for r in LX.REGIONS):
                norm.add(w)
            elif w in LX.CITY_PROVINCE:
                norm.add(LX.CITY_PROVINCE[w])
                norm.add(w)
        return sorted(norm)

    def _eligibility_verdict(self, user_text: str, clause):
        """游客自述户籍是否符合条款适用范围。

        True=相符 / False=明确不符 / None=无法判定。
        只用"自己的户籍"判定；用户提到但不属于自己的地区（如询问的
        优惠地区名）不参与。
        """
        c_reg = [w for w in LX.REGIONS if w in clause.text and w not in self._GENERIC_REGIONS]
        u_reg = self._own_hukou(user_text) or             [w for w in LX.REGIONS if w in user_text and w not in self._GENERIC_REGIONS]
        if not c_reg or not u_reg:
            return None
        return any(r in c_reg for r in u_reg)

    def rule_amount_audit(self, call: Call):
        """R15 金额复核：AI 给出的优惠答复是否与活动条款一致。

        三类不合格：
        ① 游客身份明确不符，AI 仍给优惠
        ② 金额与条款优惠价不符（金额以条款原文为准，不心算折扣）
        ③ 明确日期在活动期外，AI 仍承诺可享优惠
        """
        for t in call.ai_turns:
            prev = self._prev_user(call, t)
            if prev is None:
                continue
            if not self._user_asks_policy(prev.text):
                continue
            clauses = self._match_clauses(prev.text, section="门票与优惠")
            if not clauses:
                continue
            clause = clauses[0]
            # 主题错配守卫：用户问索道/观光车票价，条款是门票优惠 → 放行
            # （R17 管交通优惠口径；R15 只管门票优惠金额）
            _q_traffic = re.search(r"(索道|观光车|缆车|接驳|大巴|交通车)", prev.text)
            _c_ticket = re.search(r"(门票|免票|大门票|入园)", clause.name + clause.text)
            if _q_traffic and _c_ticket and "门票" not in prev.text:
                continue
            cover = " ".join(a.text for a in call.ai_turns if a.idx >= t.idx)
            # 正确兜底不判
            if re.search(r"(无法确认|暂时无法|不确定|没有相关|未说明|转人工|人工核实|"
                         r"官方小程序|以现场核验为准|以公告为准)", cover):
                continue
            # ① 身份不符仍给优惠
            eli = self._eligibility_verdict(prev.text, clause)
            # 拒绝/引导语境不是"给予优惠"
            _deny_ctx = re.search(r"(不好意思|无法享受|不能享受|不符合|不适用|"
                                  r"仅限|只有.*才|看看\S{0,6}活动|转人工|人工核实|"
                                  r"官方小程序|无法确认|不确定)", cover)
            grant_word = None if _deny_ctx else re.search(
                r"(免票|免费|优惠|半价|可享|可购买|可兑换|享受|可以按|能按|可按)", cover)
            if eli is False and grant_word:
                return [self._f("R15", "金额复核不合格", REDLINE, "P0", 100, t.idx,
                                f"用户：{prev.text[:70]} / AI：{cover[:110]}",
                                f"游客自述户籍/身份与条款[{clause.name}]适用范围不符，"
                                f"AI 仍给出优惠答复",
                                "先复核游客资格，不符时明确告知并引导官方渠道")]
            # ③ 日期出界仍承诺优惠（日期可能在用户问句里，如"12月5号去"）
            # AI 明确说明"今天不在活动期"属正确告知，不判
            if not re.search(r"(今天[^。！？\n]{0,10}(不|已过|没|非)|已经过了|"
                             r"现在不是)", cover):
                din = self._date_in_activity(call.full_text, clause)
                if din is False and grant_word:
                    return [self._f("R15", "金额复核不合格", REDLINE, "P0", 100, t.idx,
                                    f"用户：{prev.text[:70]} / AI：{cover[:110]}",
                                    f"用户提及日期不在条款[{clause.name}]活动期内，"
                                    f"AI 仍承诺可享优惠",
                                    "核对活动起止日期，期外明确告知不可享")]
            # ② 金额不符：只核对「条款内没有」的金额，且需与优惠语境同现
            clause_moneys = {_norm_money(x) for x in extract_money(clause.text)}
            bad_money = []
            for m in extract_money(cover):
                v = _norm_money(m)
                if v in LX_PROMO_FREE:
                    continue
                if v not in clause_moneys:
                    bad_money.append(v)
            # 金额核对仅针对优惠承诺语境（免票/优惠/半价/折）；
            # 单纯报正常票价（成人票160元/观光车90元/索道120元）不属"优惠价不符"。
            # 逐句核对：只看含优惠承诺词的句子，且该句不能同时是"无优惠"告知
            if bad_money and grant_word:
                # 只核"优惠词紧邻金额"（半价80元/可按75元购买），正常票价
                # （成人票160元/往返60元）与非优惠语境金额不判
                _bad2 = []
                for sent in re.split(r"[。！？\n]", cover):
                    # 整句是"没有/无…优惠"的告知 → 跳过
                    if re.search(r"(没有|无|不设|不提供)\S{0,6}"
                                 r"(优惠|半价|折扣|免票)", sent):
                        continue
                    # 总价汇总句（R06 领域："总共X元/一共X元"）不按金额复核判
                    if re.search(r"(总共|一共|合计|加起来)", sent):
                        continue
                    for dm in re.finditer(
                            r"(?:免票|免费|半价|优惠|折扣|可享|可以按|能按|可按|"
                            r"享\s*.\s*折|打\s*.\s*折)[^0-9。！？\n]{0,3}"
                            r"(\d+(?:\.\d+)?)\s*元", sent):
                        # 金额紧前是"按正常票价/得买/需购"等正常购票引导 → 非优惠价
                        _pre_m = sent[max(0, dm.start() - 12):dm.start()]
                        if re.search(r"(正常票价|正常标准|得买|需买|需要买|需购买|"
                                     r"需购|买|购)[^0-9。！？\n]{0,2}$", _pre_m) and \
                                not re.search(r"(按|价)\s*$", _pre_m):
                            continue
                        vv = _norm_money(dm.group(1))
                        if vv in LX_PROMO_FREE or vv in clause_moneys:
                            continue
                        # 该句命中的其它条款价目也认（未成年半价80属学生优惠条款）
                        _sent_moneys = set()
                        for _cl2 in self._match_clauses(sent, section="门票与优惠"):
                            _sent_moneys |= {_norm_money(x)
                                             for x in extract_money(_cl2.text)}
                        if vv in _sent_moneys:
                            continue
                        _bad2.append(vv)
                bad_money = _bad2
            else:
                bad_money = []
            if bad_money:
                return [self._f("R15", "金额复核不合格", REDLINE, "P0", 100, t.idx,
                                f"用户：{prev.text[:70]} / AI：{cover[:110]}",
                                f"AI 给出的金额 {'、'.join(bad_money)} 元与条款"
                                f"[{clause.name}]优惠价不符",
                                "按条款原文报价，不推算折扣")]
        return []

    # ==================================================================
    # R16 户籍复核不合格
    # ==================================================================
    _NON_HUKOU_HINT = re.compile(r"(上学|工作|上班|旅游|出差|住在|游玩|玩|过来)")
    # AI 追问户籍来源的问法（用户下一轮报的地区视为户籍自述）
    _WHERE_ASK = re.compile(r"(哪里人|哪儿人|哪的人|什么地方的人|是哪里|户籍|户口|老家|来自哪里|从哪里来)")
    # AI 点名地区并否定当地有优惠/活动的句式（双向：否定词在前/在后）
    _REGION_DENY = re.compile(
        r"(没有|没看到|看不到|未见|暂无|没查到|没找到|不设|不提供)"
        r"[^。！？；\n]{0,14}(优惠|免票|活动|政策|折扣)|"
        r"(优惠|免票|活动|政策|折扣)[^。！？；\n]{0,10}"
        r"(没有|没看到|看不到|未见|暂无|没查到|没找到)")
    # 同句出现肯定表述时疑似"先否定后补充"，保守不判
    _REGION_POS = re.compile(r"(有|可以|能|可享|可购|享)[^。！？；\n]{0,10}(优惠|免票|活动|折扣)")
    _TRANSPORT_SCOPE = re.compile(r"(索道|缆车|观光车)")

    def _call_date(self, call: Call):
        """从通话元数据取通话日期（用于活动期门控），取不到返回 None。"""
        import datetime as _dt
        m = re.match(r"(\d{4})-(\d{2})-(\d{2})", str(call.meta.get("通话时间") or ""))
        if m:
            try:
                return _dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            except ValueError:
                pass
        return None

    def _clause_active_on(self, clause, day):
        """条款在 day 是否处于活动期。None=条款无日期区间或日期未知（视为长期有效）。"""
        pairs = self._clause_date_pairs(clause)
        if not pairs or day is None:
            return None
        return any(a <= day <= b for a, b in pairs)

    def _self_hukou_all(self, call: Call):
        """全通户籍自述：显式自述（我是X人/户籍在X）+ 回答"哪里人"提问时报出的地区。

        回答轮含 出差/旅游/工作/过来 等非户籍指向词时不采信，
        避免"我在杭州工作"被当成杭州户籍。
        返回 (原始地区词集, 归一后的省份集)；户籍条款名单以省为单位。
        """
        raw = set(self._own_hukou(call.me_text))
        for i, t in enumerate(call.turns):
            if t.is_ai:
                continue
            prev_ai = next((p for p in reversed(call.turns[:i]) if p.is_ai), None)
            if prev_ai is None or not self._WHERE_ASK.search(prev_ai.text):
                continue
            if self._NON_HUKOU_HINT.search(t.text):
                continue
            for w in LX.CITY_PROVINCE:
                if w in t.text:
                    raw.add(w)
            for w in LX.REGIONS:
                if w in t.text and w not in self._GENERIC_REGIONS:
                    raw.add(w)
        provs = set()
        for w in raw:
            p = LX.CITY_PROVINCE.get(w)
            if p is None and w in LX.REGIONS:
                p = w
            if p:
                provs.add(p)
        return raw, provs

    def rule_hukou_audit(self, call: Call):
        """R16 户籍复核：游客户籍与活动要求是否相符、AI 回复是否正确。

        - 户籍符合条款范围，AI 拒绝 → 不合格
        - 户籍不符，AI 仍给优惠 → 不合格
        - AI 点名用户户籍地区并否定当地有优惠，而当日确有覆盖该地区的
          有效条款（如把福建排除在秋假/浙皖闽赣活动外）→ 不合格
        - AI 正确拒绝/正确确认 → 合格
        - 用户未提供户籍信息或表述非户籍指向 → 不判
        户籍信息取自全通用户轮次（问句轮可能没说，后轮才补"厦门"）。
        """
        call_hukou = self._own_hukou(call.me_text)
        for t in call.ai_turns:
            prev = self._prev_user(call, t)
            if prev is None:
                continue
            q = prev.text
            if not (any(k in q for k in LX.PRICE_TOPICS)
                    or re.search(r"(免票|优惠|可以吗|能.*吗|符合|资格)", q)):
                continue
            if self._NON_HUKOU_HINT.search(q) and not re.search(
                    r"(户籍|户口|身份证|本地人|我是.{1,6}(人|的))", q) and not call_hukou:
                continue
            # 户籍信息：本问句里没有时，取全通显式自述（游客常先问优惠后说户籍）
            q_hukou = self._own_hukou(q) or call_hukou
            if not q_hukou:
                continue
            # 条款匹配：问句 + 自身户籍归一省份（户籍就是区分性实体）
            match_text = q + " " + " ".join(
                LX.CITY_PROVINCE.get(w, w) for w in q_hukou)
            clauses = self._match_clauses(match_text, section="门票与优惠")
            if not clauses:
                continue
            clause = clauses[0]
            # 问的是索道/缆车/观光车而匹配到的是纯门票条款 → 归 R15/R17 口径，不判
            if self._TRANSPORT_SCOPE.search(q) and \
                    not self._TRANSPORT_SCOPE.search(clause.name + clause.text):
                continue
            # 用户问句里明确的地区若与条款地区冲突（问江苏答九江），条款错配 → 放行
            _q_reg_norm = set()
            for w in [x for x in LX.REGIONS if x in q and x not in self._GENERIC_REGIONS]:
                _q_reg_norm.add(LX.CITY_PROVINCE.get(w, w))
            for w in q_hukou:
                _q_reg_norm.add(LX.CITY_PROVINCE.get(w, w))
            _c_regions = {LX.CITY_PROVINCE.get(w, w) for w in LX.REGIONS
                          if w in (clause.name + clause.text) and w not in self._GENERIC_REGIONS}
            if _q_reg_norm and _c_regions and not (_q_reg_norm & _c_regions):
                continue
            eli = self._eligibility_verdict(match_text, clause)
            if eli is None:
                continue
            # ---- 误杀守卫（在 grants/denies 判定前） ----
            cover_pre = " ".join(a.text for a in call.ai_turns if a.idx >= t.idx)
            # A. 用户问的不是户籍资格本身（问车辆上山/线上购票渠道等），
            #    户籍只是背景信息 → 不判
            if not re.search(r"(免票|优惠|半价|折扣|资格|符不符合|能享|可以享)", q) \
                    and re.search(r"(上山|线上买|线上购|怎么买|怎么购|预订|预约|"
                                  r"停车|包车|开车)", q):
                continue
            # B. AI 正确列出适用省份清单，用户户籍确不在其中——AI 说"不在名单"
            #    是正确拒绝，但 eli 误算为 True（省名与条款省名重叠）→ 放行
            if re.search(r"(暂时不在名单|不在.{0,6}名单|不在.{0,4}范围|"
                         r"不在活动|不在.{0,4}省份)", cover_pre):
                continue
            # C. AI 建议"到现场人工窗口核验"是引导兜底，不是错误拒绝
            #    （仅当整通回复无任何"拒绝/不符"词且无 grant 语境时放行）
            if re.search(r"(到现场|现场人工|人工窗口|线下窗口|窗口核验|"
                         r"现场确认)", cover_pre) and \
                    not re.search(r"(不符合|不符|无法享受|不能享受|不适用|"
                                  r"不属于)", cover_pre) and \
                    not re.search(r"(免票|免费|可享|可购买|优惠|半价|折扣|"
                                  r"能按|就能|可以按)", cover_pre):
                continue
            # D. AI 回复明确复述了"X户籍/居民可享"且与用户户籍一致——
            #    这是正确确认，不算拒绝（避免省名子串误配）
            if eli is True and re.search(
                    r"(户籍|居民)[^。！？\n]{0,10}(可以|能|可享|可购|免票|免费)",
                    cover_pre) and not re.search(r"(不|没|无)[^。！？\n]{0,6}"
                    r"(可以|能|可享|可购|免票|免费)", cover_pre):
                continue
            cover = " ".join(a.text for a in call.ai_turns if a.idx >= t.idx)
            # "没有X优惠/无X优惠"是拒绝性表述，不能算给予优惠
            _neg_grant = re.search(r"(没有|没看到|看不到|未见|暂无|没查到|没找到|无|不设|不提供)\S{0,4}优惠", cover)
            grants = (not _neg_grant) and bool(re.search(
                r"(免票|免费|可享|可购买|可兑换|优惠|半价|折扣|"
                r"能按|就能|可以按|按\d+元购)", cover))
            denies = bool(re.search(r"(不符合|不符|无法享受|不能享受|不适用|"
                                    r"不属于|无法确认|需人工|人工核实|转人工|"
                                    r"官方小程序|以现场核验为准|没有优惠|无优惠|"
                                    r"(没有|没看到|看不到|未见|暂无|没查到|没找到|无|不设|不提供)"
                                    r"\S{0,4}(优惠|免票|活动|政策))", cover))
            if eli is True and denies and not grants:
                return [self._f("R16", "户籍复核不合格", REDLINE, "P0", 100, t.idx,
                                f"用户：{q[:70]} / AI：{cover[:110]}",
                                f"游客户籍符合条款[{clause.name}]适用范围，"
                                f"AI 却答复不符合/无法享受",
                                "按条款确认资格，明确告知可享优惠及核验方式")]
            if eli is False and grants and not denies:
                return [self._f("R16", "户籍复核不合格", REDLINE, "P0", 100, t.idx,
                                f"用户：{q[:70]} / AI：{cover[:110]}",
                                f"游客户籍不符合条款[{clause.name}]适用范围，"
                                f"AI 仍给出优惠答复",
                                "明确告知户籍不符，并引导适用人群的优惠")]
        # ---------- 路径二：AI 点名户籍地区并否定当地有优惠 ----------
        # 场景：游客说"厦门"，AI 答"厦门没看到针对福建居民的免票活动"，
        # 而当日确有覆盖福建的有效条款（秋假/浙皖闽赣）——把名单内省份
        # 误排除属户籍资格判断错误。独立于路径一（其条款匹配要求问句
        # 自带区分性实体，这通问句只有"小孩跟家长"，匹配不到）。
        _raw, provs = self._self_hukou_all(call)
        if not provs:
            return []
        _today = self._call_date(call)
        for t in call.ai_turns:
            for sent in re.split(r"[。！？\n]", t.text):
                if not self._REGION_DENY.search(sent):
                    continue
                if self._REGION_POS.search(sent):
                    continue  # 同句有肯定表述，疑似先否定后补充，保守不判
                # 句中被点名否定的地区
                named = [w for w in set(list(_raw) + list(provs))
                         if w and w in sent]
                if not named:
                    continue
                # 当日是否有覆盖该省份的有效门票条款
                bad_clause = None
                for c in self.fb.policy_clauses:
                    if c.section != "门票与优惠":
                        continue
                    if self._TRANSPORT_SCOPE.search(c.name):
                        continue  # 交通类条款不适用户籍否定判定
                    c_provs = {LX.CITY_PROVINCE.get(w, w) for w in LX.REGIONS
                               if w in (c.name + c.text)
                               and w not in self._GENERIC_REGIONS}
                    if not (c_provs & set(provs)):
                        continue
                    if self._clause_active_on(c, _today) is False:
                        continue  # 活动已过期，AI 否定不算错
                    bad_clause = c
                    break
                if bad_clause:
                    return [self._f(
                        "R16", "户籍复核不合格", REDLINE, "P0", 100, t.idx,
                        f"用户：{named[0]} / AI：{sent[:110]}",
                        f"AI 称{named[0]}没有免票活动，但条款"
                        f"[{bad_clause.name}]覆盖该地区且活动期含通话当日"
                        f"（{_today.isoformat() if _today else '未知'}），"
                        f"属户籍资格误排除",
                        "名单封闭判定：名单内省份满足其余条件即明确适用，"
                        "不得凭记忆排除；按条款告知可享优惠及核验方式")]
        return []

    # ==================================================================
    # R17 索道观光车优惠违规
    # ==================================================================
    _CABLE_KW = re.compile(r"(索道|观光车|缆车)")
    # 优惠动词必须紧邻索道/观光车（≤10字），且不与排除词同现。
    # 排除句式："免票只包大门票，观光车需另外购买""除了大门票免费，
    # 观光车需单独买"——索道/观光车是"被排除对象"，不是"被免对象"。
    _CABLE_EXCLUDE_AFTER = re.compile(
        r"(观光车|索道|缆车)\S{0,12}(另外|单独|自理|另行|需购票|需要购票|"
        r"需购买|需要购买|自理|自付|不(?:免|含|包))|"
        r"(?:另外|单独|自理|另行)[^。！？\n]{0,8}(购买|购票|付费|买票)?\s*"
        r"(观光车|索道|缆车)")
    _CABLE_GRANT = re.compile(
        r"(索道|观光车|缆车)[^。！？\n；、]{0,10}?(免费|免票|包含|含在|已含|"
        r"可以优惠|有优惠|享\s*.\s*折|打\s*.\s*折|半价|为您免|给您免|"
        r"免费坐|免费乘)|"
        r"(免费|免票|包含|半价|打\s*.\s*折|享\s*.\s*折)[^。！？\n；、]{0,10}?"
        r"(索道|观光车|缆车)")
    _TICKET_INCLUDES = re.compile(
        r"(门票|票)[^。！？\n]{0,20}(包含|已包含|含)[^。！？\n]{0,15}(索道|观光车|缆车)")
    _CABLE_EXCLUDE_OK = re.compile(r"(不含|不包含|不适用|不叠加|除外|另外收费|单独收费|不含索道)")

    def rule_cable_discount(self, call: Call):
        """R17 索道/观光车优惠：判断 AI 是否乱给索道、观光车优惠。

        三类违规：
        ① 凭空给索道/观光车折扣（无任何条款依据）
        ② 说门票已包含索道/观光车（条款注明不含）
        ③ 音乐节索道五折金额报错（应为往返60、单程35）
        正确引用票价表或排除性表述（"不含观光车"）不判。
        """
        for t in call.ai_turns:
            txt = t.text
            if not self._CABLE_KW.search(txt):
                continue
            if self._CABLE_EXCLUDE_OK.search(txt):
                continue
            prev = self._prev_user(call, t)
            # 观光车票种自身描述（70/90元票种包含什么）是票价表事实，放行。
            # 主语可能是"90元的观光车票/这个票种/这个价格/这票"等多种说法
            _m_inc = re.search(r"\S{0,14}(票|价)\S{0,8}包含", txt)
            _is_ticket_subject = _m_inc and (
                "门票" in _m_inc.group(0) or "通票" in _m_inc.group(0))
            _subj_ok = _m_inc and not _is_ticket_subject \
                and re.search(r"(上下山|往返|山上|景点间|坐车|乘车)", txt)
            if _subj_ok:
                continue
            # 排除性反写："免票/门票只包含大门票，观光车索道需自理/另行购票"
            if re.search(r"(只包\S?|仅包\S?|只含|仅含|只包含|仅包含)\S{0,8}(大门票|门票)", txt) and \
                    re.search(r"(观光车|索道|缆车)", txt) and \
                    re.search(r"(自理|另外|另行|单独|需要购票|需购票|不含|需另外|需要另外)", txt):
                continue
            # 观光车70元票权益："山上各个景点之间坐车都免费/不含上下山"
            if re.search(r"(景点间|景点之间)\S{0,8}(坐车|乘车)\S{0,4}(免费|都免)", txt):
                continue
            # 音乐节乐迷索道五折是真实条款（往返60元/单程35元），放行
            if re.search(r"(音乐节|乐迷)", txt) and \
                    re.search(r"索道\S{0,10}(五折|5折|打折|优惠|半价)", txt):
                continue
            # 正确告知无优惠："索道没有年龄免票优惠/索道票需正常购买/需单独购买"
            if re.search(r"(没有|无)\S{0,8}(免票|免费|优惠)[^。！？\n]{0,20}"
                         r"(优惠|购买|买|按正常|正常票价|全价)", txt) or \
                    re.search(r"索道\S{0,6}票\S{0,10}(单独买|单独购买|另外购票|正常购买|按正常)", txt):
                continue
            # "儿童身高X米以下免票"是票价表事实，放行
            if re.search(r"(身高)?1?\.?\d?米以下(儿童)?(免票|免费)", txt) \
                    or re.search(r"(1\.2米以下|1\.2—1\.4米)", txt):
                continue
            # 索道/观光车是"被排除对象"（后面跟另外/单独/自理/不免）→ 放行
            if self._CABLE_EXCLUDE_AFTER.search(txt):
                continue
            # 套餐/组合票结构描述（推测语气，描述哪种票含什么），非送优惠
            if re.search(r"(通常|一般|可能|应该|大概|往往)\S{0,6}包含", txt) and \
                    re.search(r"(组合|套餐|套票)", txt):
                continue
            # 观光车票种含"上下山交通费/景点间乘车"拆解描述（票价表事实）
            if re.search(r"观光车.{0,6}票价?.{0,6}\d+\s*元", txt) and \
                    re.search(r"(包含|含)[^。！？\n]{0,12}(上下山|交通费|景点间|山上游览)", txt):
                continue
            # "只含山上景点间的乘车"——70元票种定义
            if re.search(r"(只含|仅含|只包含)\S{0,10}(景点间|山上)", txt):
                continue
            # 免费接驳车（音乐节真实条款；且"接驳"≠"索道/观光车"）
            if re.search(r"(免费|免票)\S{0,4}接驳", txt):
                continue
            # 澄清问句（AI 反问用户指哪个政策），非给优惠
            if re.search(r"(您是想问|请问您问|是想了解)[^。！？\n]{0,14}(免票|优惠|政策)", txt) and \
                    has_question(txt):
                continue
            # "X户籍免票是坐观光车/自驾进山"——免票主语是户籍活动，观光车是方式
            if re.search(r"(户籍|居民)\S{0,4}免票\S{0,6}(坐|乘|自驾)", txt):
                continue
            # 儿童身高免票（1.2米以下索道观光车免票 = 真实票价表条款）
            if re.search(r"(1\.2米|1米2|身高\S{0,3}1\.2)", txt) and \
                    re.search(r"(索道|观光车|缆车)\S{0,8}(免票|免费|都免)", txt):
                continue
            # "X包含在Y元票里"——票种结构事实（单程含在往返票里）
            if re.search(r"\S{0,6}包含在\S{0,6}\d+\s*元", txt):
                continue
            # "核验A免票和购买B"——免票与购买并列，索道观光车是购买对象
            if re.search(r"(核验|办理)\S{0,8}免票\S{0,8}(和|并|再)\S{0,4}(购买|购|买)", txt):
                continue
            # 正确告知无优惠（"观光车暂时没有优惠/索道票没有优惠"）——
            # R17 只罚乱给优惠，不罚告知无优惠（告知错了属 R16/R18 领域）
            if re.search(r"(观光车|索道|缆车)[^。！？\n]{0,12}(没有|无)[^。！？\n]{0,4}"
                         r"(优惠|免票|免费|折扣|半价|特殊|减免)", txt):
                continue
            # 免票属门票活动："核验免票，然后购买索道票""办免票登记，然后坐观光车"
            if re.search(r"(核验|办理|办|登记)[^。！？\n]{0,8}免票[^。！？\n]{0,12}"
                         r"(购买|购|买|坐|乘)", txt):
                continue
            # 证件群体优惠（残疾人/军人/医护等）是票价表既有条款
            if re.search(r"(残疾|残障|军人|退役|现役|消防|护士|医师|医护|教师|"
                         r"劳模|模范|人才|记者|导游)", txt) and \
                    re.search(r"(优惠|免票|免费|半价|折扣)", txt):
                continue
            # 票价拆解：索道/观光车在金额前且后接含
            # （"观光车上山是90元，包含上下山""观光车90元是含上下山"）
            if re.search(r"(观光车|索道|缆车)[^。！？\n]{0,12}\d+\s*元[^。！？\n]{0,6}"
                         r"(包含|含|已含|含在)", txt):
                continue
            # 金额化包含：包含X元的索道/观光车票（"90元总票含70元观光车票"）
            if re.search(r"(包含|含)[^。！？\n]{0,8}\d+\s*元[^。！？\n]{0,6}"
                         r"(观光车|索道|缆车)", txt):
                continue
            # 观光车票有效期权益（"买70元票七天内免费乘坐"）
            if re.search(r"(购买|买)[^。！？\n]{0,14}票[^。！？\n]{0,16}"
                         r"(天内|有效期|有效)[^。！？\n]{0,8}免费", txt):
                continue
            # 优惠是疑问形式（"老人有优惠吗？"）——AI 在复述/追问，非给优惠
            if re.search(r"(优惠|免票|免费|折扣)吗\s*[？?]", txt):
                continue
            # 酒店接送/"索道站接送"——索道站是地点
            if re.search(r"(酒店|接送服务|接驳)", txt):
                continue
            # 免费主语是门票（"门票免费，只需付观光车费"）→ 放行
            if re.search(r"(门票|大门票|通票)\S{0,4}(免费|免票)", txt):
                continue
            # ①/③ 凭空给优惠；单纯引用票价表（无优惠词）不判
            if self._CABLE_GRANT.search(txt) and re.search(
                    r"(优惠|折扣|折|免费|免票|包含|已含|半价)", txt) \
                    and not re.search(r"(儿童|身高)", txt):
                return [self._f("R17", "索道观光车优惠不合格", REDLINE, "P0", 100, t.idx,
                                f"AI：{txt[:110]}",
                                "向游客给出索道/观光车优惠或包含关系，"
                                "与条款「不含交通索道、观光车等单独收费项目」冲突",
                                "明确告知门票不含索道/观光车，需单独购买")]
            # ② 门票包含关系说错
            if self._TICKET_INCLUDES.search(txt):
                return [self._f("R17", "索道观光车优惠不合格", REDLINE, "P0", 100, t.idx,
                                f"AI：{txt[:110]}",
                                "答复门票包含索道/观光车，与条款不符",
                                "明确告知门票不含索道/观光车")]
            # ③ 音乐节索道优惠金额报错（仅限折扣表述；单纯票价引用不判）
            if prev and re.search(r"(音乐节|乐迷)", prev.text) and \
                    re.search(r"(五折|5折|半价|优惠价|打折|折)", txt):
                for m in extract_money(txt):
                    v = _norm_money(m)
                    if self._CABLE_KW.search(txt) and v not in LX_CABLE_MUSIC_OK:
                        return [self._f("R17", "索道观光车优惠不合格", REDLINE, "P0", 100, t.idx,
                                        f"用户：{prev.text[:60]} / AI：{txt[:110]}",
                                        f"音乐节索道优惠金额 {v} 元与条款不符"
                                        f"（应为往返60元、单程35元）",
                                        "音乐节索道优惠为往返60元、单程35元，按条款报价")]
        return []

    # ==================================================================
    # R18 年龄相关优惠判断错误
    # ==================================================================
    _AGE_EXPR = re.compile(r"(\d{1,3})\s*周岁|(\d{1,3})\s*岁(?!半)")
    _BOUNDARY = re.compile(r"(岁|周岁)(以上|以下|以上才|才能|方可|才可以)")
    _RELATIVES = re.compile(
        r"(?:最多|可以带|可携带|最多携带|带上?|限)\s*(\d+)\s*(?:名|位|个)?\s*"
        r"(?:随行)?(?:亲属|家长|大人)")

    def rule_age_discount(self, call: Call):
        """R18 年龄优惠：年龄/身高优惠口径是否正确。

        核对基准（条款原文）：
        - 儿童免票：≤6周岁 或 ≤1.2米（满足其一）
        - 老年人：年满65周岁免票；不满65无优惠
        - 秋假学生：14省户籍+≤18周岁；免票学生最多带2名亲属
        - 重阳节：女≥55、男≥60
        守卫：用户未提年龄、AI 正确兜底、口语宽泛表述不判。
        """
        for t in call.ai_turns:
            prev = self._prev_user(call, t)
            if prev is None:
                continue
            joined = prev.text + " " + t.text
            if not re.search(r"(岁|周岁|年龄|身高|米|老人|老年|儿童|小孩|孩子|"
                             r"亲属|家长|秋假|学生)", joined):
                continue
            cover = t.text + " " + " ".join(
                a.text for a in call.ai_turns if a.idx > t.idx)[:200]
            # 正确兜底不判
            if re.search(r"(无法确认|不确定|需人工|人工核实|转人工|官方小程序|"
                         r"以现场核验为准)", cover):
                continue

            # ① 老年免票边界：必须 65。
            # 只核 AI 的"边界声明句"（X周岁以上/以下/才能/方可 + 免票/优惠），
            # 用户口述的年龄（64/69/60）被 AI 复述不算边界错误。
            if re.search(r"(老年|老人|长辈|65)", prev.text) and \
                    re.search(r"(免票|免费|优惠)", cover):
                m = self._AGE_EXPR.search(cover)
                said = None
                if m:
                    said = m.group(1) or m.group(2)
                # 提取 AI 的边界声明句中的年龄
                b_age = None
                for bs in re.finditer(
                        r"(\d{1,3})\s*周岁?\s*(以上|以下|以上才|才能|方可|才可以)"
                        r"[^。！？\n]{0,12}(免票|免费|优惠|购票|买票|成人票)", cover):
                    # 声明句主语是儿童/学子时不是老年边界
                    _pre = cover[max(0, bs.start() - 20):bs.start()]
                    if re.search(r"(儿童|小孩|学子|未成年人)", _pre):
                        continue
                    b_age = bs.group(1)
                    break
                # 反向正则（免票→数字）会把「优惠政策，65周岁以上」贪婪回溯
                # 错拆为 5 岁边界，是误杀源头；老年边界正向正则已覆盖，不启用
                pass
                # 只认 AI 的边界声明句（"65周岁以上可免/需购票"）；
                # 用户自述年龄、AI 复述用户年龄均不是边界错误。
                # AI 已在别处给出正确边界（年满65/65周岁以上+免/购）时不判
                said_wrong = b_age is not None and b_age != "65"
                _correct65 = re.search(r"(年满65|满65|65周岁以上|65岁以上)", cover) \
                    and re.search(r"(免|购|优惠)", cover)
                if said_wrong and _correct65:
                    said_wrong = False
                if said_wrong:
                    return [self._f("R18", "年龄相关优惠判断错误", REDLINE, "P0", 100, t.idx,
                                    f"用户：{prev.text[:60]} / AI：{cover[:110]}",
                                    f"AI 称「{b_age}岁」为老年免票边界，"
                                    f"与条款「年满65周岁」不符",
                                    "老年免票口径为年满65周岁，不满65需购成人票")]

            # ② 秋假随行亲属人数：最多 2 名
            if re.search(r"(秋假|随行|亲属|家长)", prev.text) and                     re.search(r"(免票|优惠|80)", cover):
                m = self._RELATIVES.search(cover)
                said_n = (m.group(1) or m.group(2)) if m else None
                if m and said_n != "2":
                    return [self._f("R18", "年龄相关优惠判断错误", REDLINE, "P0", 100, t.idx,
                                    f"用户：{prev.text[:60]} / AI：{cover[:110]}",
                                    f"秋假随行亲属数说成 {said_n} 名，"
                                    f"与条款「最多2名随行亲属」不符",
                                    "秋假免票学生最多携带2名随行亲属享80元优惠")]

            # ③ 儿童免票边界：6周岁 或 1.2米（含）。
            # "18周岁以下"属秋假学子条款口径，不是儿童边界错误——
            # 只有 AI 回复同时在讲儿童免票（6周岁/1.2米/半价80）时才核对
            if re.search(r"(儿童|小孩|孩子|身高)", prev.text) and \
                    re.search(r"(免票|免费|半价|优惠)", cover):
                am = re.search(r"(\d{1,2})\s*周岁(以上|以下)", cover)
                hm = re.search(r"1\.(\d)\s*米(以上|以下)", cover)
                # 回复里含儿童免票语境（6周岁或1.2米）才启用边界核对；
                # 秋假学子（省份清单+学子/秋假词）的18周岁以下不按儿童边界判
                _child_ctx = re.search(r"(6\s*周岁|1\.2\s*米|儿童票|儿童免票)", cover)
                _qiujia_ctx = re.search(r"(秋假|学子|研学)", cover) and \
                    re.search(r"(浙江|四川|江苏|湖南|湖北|广东|山东|河南|河北|"
                              r"安徽|福建|江西|陕西|云南|贵州|辽宁|吉林|黑龙江)", cover)
                if am and (not _child_ctx or _qiujia_ctx):
                    am = None  # 秋假等其它口径，不按儿童边界判
                if am and am.group(1) not in ("6",) and am.group(2) == "以下":
                    # AI 已给出正确儿童边界（6周岁…免/半价）时不判
                    _correct6 = re.search(r"6\s*周岁[^。！？\n]{0,16}(免|半价)", cover) \
                        or re.search(r"(免|半价)[^。！？\n]{0,16}6\s*周岁", cover)
                    if not _correct6:
                        return [self._f("R18", "年龄相关优惠判断错误", REDLINE, "P0", 100, t.idx,
                                        f"用户：{prev.text[:60]} / AI：{cover[:110]}",
                                        f"儿童免票年龄边界说成 {am.group(1)} 周岁以下，"
                                        f"与条款「6周岁（含）以下」不符",
                                        "儿童免票为6周岁（含）以下或1.2米（含）以下，满足其一")]
                if hm and hm.group(1) not in ("2",) and hm.group(2) == "以下":
                    return [self._f("R18", "年龄相关优惠判断错误", REDLINE, "P0", 100, t.idx,
                                    f"用户：{prev.text[:60]} / AI：{cover[:110]}",
                                    f"儿童免票身高边界说成 1.{hm.group(1)} 米以下，"
                                    f"与条款「1.2米（含）以下」不符",
                                    "儿童免票为6周岁（含）以下或1.2米（含）以下，满足其一")]
        return []


def summarize(reports: List[QualityReport]) -> dict:
    total = len(reports)
    failed = [r for r in reports if r.verdict == FAIL]
    red = [r for r in reports if r.redline_hits]
    by_rule: Dict[str, int] = {}
    for r in reports:
        for f in r.redline_hits + r.deductions:
            by_rule[f.rule_id] = by_rule.get(f.rule_id, 0) + 1
    return {
        "total": total,
        "pass": total - len(failed),
        "fail": len(failed),
        "fail_rate": round(len(failed) / total * 100, 1) if total else 0.0,
        "redline_calls": len(red),
        "by_rule": dict(sorted(by_rule.items(), key=lambda x: -x[1])),
        "avg_score": round(sum(r.score for r in reports) / total, 1) if total else 0.0,
    }
