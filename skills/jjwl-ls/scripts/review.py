# -*- coding: utf-8 -*-
"""推送前复核闸门：对所有被判有问题的记录做独立二次校验。

原则：宁可漏判，不可误判。自动质检只是初筛，每条初判问题都要经过
独立复核确认后才允许推送。复核不通过（疑似误判）的问题会被降级为
「存疑剔除」，并在复核日志中留痕，供后续人工抽检。

复核维度（每条 Finding 独立过）：
1. 守卫复核     —— 该规则自带的豁免/兜底守卫是否被正确应用（R05 政策询问、
                   R07 否定语境、R08 机构转述、R12 固定播报等）
2. 证据一致性   —— 证据原话必须真实存在于对话中，轮次引用有效
3. 上下文矛盾   —— 证据句子在原文语境中被否定/质疑时不算违规
                   （例："没法保证" → 承诺不成立）
4. 主题匹配复核 —— 条款匹配的实体必须出现在用户真实提问里，
                   而非背景叙述或 AI 自己的复述

用法：
    python3 review.py --slot-dir output/qc/20261116/09_1500-1600
    python3 review.py --reports 质检明细.json --transcripts 对话.jsonl
    python3 review.py --demo          # 自检
"""
from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from jjwl_qc.transcript import parse_transcript
from jjwl_qc.lexicon import (ALLOWED_PHONES, PRICE_TOPICS, GROUPS, PROOFS)

PASS = "确认"
DEMOTED = "剔除"
MANUAL = "转人工"


@dataclass
class ReviewResult:
    call_id: str
    rule_id: str
    finding_evidence: str
    decision: str          # PASS / DEMOTED / MANUAL
    reason: str
    checks: list = field(default_factory=list)

    def to_dict(self):
        return {
            "call_id": self.call_id, "rule_id": self.rule_id,
            "decision": self.decision, "reason": self.reason,
            "checks": self.checks,
            "finding_evidence": self.finding_evidence,
        }


# ======================================================================
# 证据回溯：证据原话必须真实存在
# ======================================================================
def _norm(s: str) -> str:
    return re.sub(r"\s+", "", str(s or ""))


def evidence_exists(evidence: str, transcript: str) -> bool:
    """证据原话必须能在原文中找到。

    证据格式是「用户：X / AI：Y」「上一轮：X / 本轮：Y」的拼接，且常被
    截断到 70/110 字并加「…」。因此按分段拆开，每段先做全文包含，
    失败再做截断容忍（去尾）与前缀探测。
    """
    parts = re.split(r"/\s*(?:AI|用户|ME|本轮|上一轮)[:：]", evidence)
    n_t = _norm(transcript)
    checked = 0
    for raw in parts:
        p = re.sub(r"^(AI|用户|ME|本轮|上一轮)[:：]", "", raw.strip())
        p = re.sub(r"[（(].{0,4}轮次[)）]|\[\d+\]", "", p)
        p = p.strip(" 。…、，")
        if len(_norm(p)) < 6:
            continue  # 太短无法可靠回溯，不据此否决
        checked += 1
        n_p = _norm(p)
        if n_p in n_t:
            continue
        # 截断容忍：逐步去尾重试
        if any(len(n_p) > cut and n_p[:-cut] in n_t for cut in (6, 12, 20)):
            continue
        # 前缀探测（开头 10 字特征）
        if len(n_p) >= 10 and n_p[:10] in n_t:
            continue
        return False
    return True


# ======================================================================
# 各规则专项复核
# ======================================================================
def _ctx_around(transcript: str, seg: str, span: int = 30) -> str:
    """取证据在原文中前后 span 字的语境。"""
    n = _norm(transcript)
    i = n.find(_norm(seg))
    if i < 0:
        return ""
    return n[max(0, i - span): i + len(_norm(seg)) + span]


_NEGATION = re.compile(r"(没法|不能|无法|不敢|不可以|不会|不一定|不好说|未必|难说)")
_CLOSING = re.compile(r"(谢谢|再见|拜拜|好的呢|好的哈|知道了|辛苦|晚安)")


def review_finding(rule_id: str, finding: dict, call_dict: dict,
                   transcript: str) -> ReviewResult | None:
    """对一条 Finding 做独立复核。返回 None 表示该规则不需要复核。"""
    call_id = call_dict.get("call_id", "?")
    evidence = str(finding.get("evidence", ""))
    checks: list[tuple[str, bool, str]] = []

    def add(name, ok, note):
        checks.append((name, ok, note))

    # ---------- 通用：证据回溯 ----------
    ev_ok = evidence_exists(evidence, transcript)
    add("证据存在于原文", ev_ok, "" if ev_ok else "证据原话在对话中找不到，疑似生成/拼接")

    # ---------- R01 沉默：末轮是否为用户告别 ----------
    if rule_id == "R01":
        lines = [l for l in transcript.split("\n") if l.strip()]
        ai_lines = [l for l in lines if l.startswith("AI")]
        add("存在AI轮次", bool(ai_lines), "")
        if _CLOSING.search(transcript[-120:] or ""):
            add("结尾是用户告别", False, "用户已说再见/谢谢，AI 不再接话属正常结束")
        # 用户最后一句是纯告别词时也不判
        me_tail = [l for l in lines if l.startswith(("ME", "用户"))]
        if me_tail and _CLOSING.search(me_tail[-1]):
            add("用户末句为告别", False, "同上，不判沉默")

    # ---------- R04/R05/R06：主题真实询问复核 ----------
    if rule_id in ("R04", "R05", "R06"):
        # 从证据里抽用户原话
        m = re.search(r"用户：(.+?)(?:\s*/\s*AI：|$)", evidence, re.S)
        user_q = m.group(1) if m else ""
        svc = re.sub(r"(发票|开票|退票|退款|改签|报销|投诉|失物)", "", user_q)
        ask = bool(re.search(r"(请问|想问|问一下|咨询|？|\?|吗|呢|多少|什么|怎么|如何|哪|几)", svc))
        policy = bool(re.search(
            r"(多少钱|多少元|什么价|价格|票价|优惠|折扣|免费|半价|门票|"
            r"什么政策|政策|什么条件|证件|资格|哪些人|谁能|办理|预约)", svc))
        add("用户在问政策本身", ask and policy,
            "" if (ask and policy) else "用户只是顺带提及，非真实询问优惠/价格")

    # ---------- R07 承诺：否定语境复核 ----------
    if rule_id == "R07":
        seg = evidence.split("AI：")[-1][:120]
        if _NEGATION.search(seg):
            add("否定语境", False, "「没法/不能保证」属拒绝打包票，不是承诺")

    # ---------- R08 号码：机构转述复核 ----------
    if rule_id == "R08":
        seg = evidence.split("AI：")[-1]
        org = re.search(
            r"(派出所|公安局|交警|消防|急救|医院|医疗|卫生|充电宝|租车|快递|"
            r"外卖|银行|保险|运营商|机场|火车站|汽车站|投诉热线|监督电话|"
            r"观光车|索道|缆车|景管|游客中心|云游江西)", seg)
        if org:
            add("机构转述", False, f"句中标注了机构「{org.group(1)}」，属转述客观信息")

    # ---------- R12 复读：固定播报复核 ----------
    if rule_id == "R12":
        seg = evidence.split("本轮：")[-1] if "本轮：" in evidence else evidence
        boiler = re.search(
            r"(欢迎致电|智能接待热线|智能接待助手|智能客服|庐小悠|"
            r"请问您想咨询|请问您是想咨询|您主要想咨询|信号好像|您能再说一下|"
            r"正在为您转接|通话将会被录音|请您耐心等待)", seg)
        if boiler:
            add("固定播报/寒暄", False, f"命中固定话术「{boiler.group(1)}」，不判复读")

    # ---------- R13 转人工：是否已执行 ----------
    if rule_id == "R13":
        if re.search(r"(正在为您转接|帮您转接|为您转接|转接中|已转接)", transcript):
            add("已执行转接", False, "对话中已有转接动作，不判未响应")

    # ---------- R15 金额复核：条款价目或排除语境复核 ----------
    if rule_id == "R15":
        seg = evidence.split("AI：")[-1]
        # AI 给出的金额若在"正常购票/原价/没有优惠"语境 → 疑似误判
        if re.search(r"(没有.{0,4}优惠|无.{0,4}优惠|暂时没有|无法享受|不符合|"
                     r"正常购票|正常标准|成人票|原价|总共|一共|合计)", seg):
            add("无优惠告知或总价语境", False, "金额处于告知无优惠/正常价/总价语境，非优惠价错报")
        # 金额在条款价目内（儿童60、学生80、观光车90/70等）
        m = re.search(r"(\d+(?:\.\d+)?)\s*元", seg)
        if m:
            try:
                from jjwl_qc.rules import LX_CABLE_MUSIC_OK
                if m.group(1) in LX_CABLE_MUSIC_OK:
                    add("金额属已知价目", False, f"{m.group(1)}元属条款/票价表价目，非编造")
            except Exception:
                pass

    # ---------- R16 户籍复核：正确拒绝/引导兜底复核 ----------
    if rule_id == "R16":
        seg = evidence.split("AI：")[-1]
        if re.search(r"(到现场|线下窗口|人工窗口|窗口核验|现场确认|以现场核验为准)", seg):
            add("引导现场核验兜底", False, "AI 引导到现场核验属兜底合规，不是错误拒绝")
        if re.search(r"(不在.{0,6}名单|不在.{0,4}范围|不在活动|仅限|只限)", seg):
            add("明确告知适用范围", False, "AI 明确说明了适用范围，属正确告知")

    # ---------- R17 索道观光车：票种权益/排除表述复核 ----------
    if rule_id == "R17":
        seg = evidence.split("AI：")[-1]
        if re.search(r"(另外|单独|自理|另行|需要购票|需购票|需另外|需购买|不含)", seg):
            add("排除性表述", False, "索道/观光车是'被排除对象'（需另外购买），非乱给优惠")
        if re.search(r"(上下山|往返都包含|票种|包含上下山|含上下山|景点间|接驳|"
                     r"1\.2米|1米2|有效期内|七天内|免费接驳|通常)", seg):
            add("票价表/票种权益描述", False, "属票价表事实或票种权益描述，非凭空优惠")

    # ---------- R18 年龄优惠：复述年龄/正确边界在场复核 ----------
    if rule_id == "R18":
        seg = evidence.split("AI：")[-1]
        if re.search(r"(年满65|满65|65周岁以上|65岁以上|6周岁|1\.2米)", seg):
            add("正确边界在场", False, "AI 回复已含正确口径（65周岁/6周岁/1.2米），疑似复述误判")
        if re.search(r"(暂时没有|没有.{0,4}优惠|没有.{0,4}免票|无法享受|不符合|"
                     r"需要购买成人票|正常购票)", seg):
            add("无优惠告知语境", False, "AI 告知无优惠属正确口径，不属边界错误")

    # ---------- 汇总结论 ----------
    fails = [c for c in checks if not c[1]]
    if not fails:
        decision, reason = PASS, "各维度复核通过"
    elif len(fails) == 1 and fails[0][0] in ("证据存在于原文",):
        decision, reason = MANUAL, "证据无法回溯，需人工核对"
    else:
        decision, reason = DEMOTED, "；".join(n for _, ok, n in checks if not ok)[:180]
    return ReviewResult(call_id, rule_id, evidence[:150], decision, reason,
                        [{"check": n, "ok": ok, "note": t} for n, ok, t in checks])


RULES_TO_REVIEW = {"R01", "R04", "R05", "R06", "R07", "R08", "R12", "R13",
                    "R15", "R16", "R17", "R18"}


# ======================================================================
# 时段级复核
# ======================================================================
def review_reports(reports: list, transcripts: dict) -> dict:
    """reports: 质检明细.json 的 list；transcripts: {call_id: 原文}。

    返回 {复核统计, 明细, 剔除后的报告}。剔除是「降级为合格但有备注」，
    不是删除通话。
    """
    details = []
    demoted_ids = {}          # call_id -> [rule_id]
    reviewed = 0
    for r in reports:
        cid = str(r.get("call_id"))
        tr = transcripts.get(cid, "")
        findings = (r.get("redline_hits") or []) + (r.get("deductions") or [])
        for f in findings:
            if f.get("rule_id") not in RULES_TO_REVIEW:
                continue
            reviewed += 1
            res = review_finding(f["rule_id"], f, r, tr)
            if res is not None:
                details.append(res.to_dict())
                if res.decision == DEMOTED:
                    demoted_ids.setdefault(cid, []).append(f["rule_id"])

    manual_ids = {}           # call_id -> [rule_id]（存疑待人工）
    for d in details:
        if d["decision"] == MANUAL:
            manual_ids.setdefault(d["call_id"], []).append(d["rule_id"])

    # 应用剔除：把剔除的问题从报告中移除，重算分数与结论
    adjusted = []
    for r in reports:
        cid = str(r.get("call_id"))
        if cid in manual_ids:
            r = dict(r, observations=list(r.get("observations") or [])
                     + [f"复核存疑待人工：{'、'.join(sorted(set(manual_ids[cid])))}"])
        if cid in demoted_ids:
            drop = set(demoted_ids[cid])
            rl = [x for x in (r.get("redline_hits") or []) if x["rule_id"] not in drop]
            dd = [x for x in (r.get("deductions") or []) if x["rule_id"] not in drop]
            if not rl and not dd:
                # 全部剔除 → 合格 100 分，备注复核调整
                r2 = dict(r, verdict="合格", score=100.0,
                          redline_hits=[], deductions=[],
                          observations=list(r.get("observations") or [])
                          + [f"复核剔除误判：{'、'.join(sorted(drop))}"])
            else:
                # 部分剔除 → 重算分数
                kept_points = sum(float(x.get("points") or 0) for x in dd)
                r2 = dict(r, score=max(0.0, 100.0 - kept_points),
                          redline_hits=rl, deductions=dd,
                          verdict="不合格" if rl or (100.0 - kept_points) < 80 else "合格",
                          observations=list(r.get("observations") or [])
                          + [f"复核剔除误判：{'、'.join(sorted(drop))}"])
            adjusted.append(r2)
        else:
            adjusted.append(r)

    n_pass = sum(1 for d in details if d["decision"] == PASS)
    n_dem = sum(1 for d in details if d["decision"] == DEMOTED)
    n_man = sum(1 for d in details if d["decision"] == MANUAL)
    return {
        "reviewed": reviewed, "pass": n_pass, "demoted": n_dem, "manual": n_man,
        "demoted_calls": len(demoted_ids),
        "details": details,
    }, adjusted


# ======================================================================
# 数据加载与入口
# ======================================================================
def load_transcripts_from_xlsx(paths) -> dict:
    from jjwl_qc.cli import load_calls
    out = {}
    for p in paths:
        for c in load_calls(Path(p)):
            raw = (getattr(c, "full_text", None)
                   or getattr(c, "raw", None) or "")
            out[str(c.call_id)] = str(raw)
    return out


def load_transcripts_from_dirs(slot_dirs) -> dict:
    """从时段目录的 xlsx 源文件读对话。run_slot.sh 用这个入口。"""
    out = {}
    for d in slot_dirs:
        d = Path(d)
        for x in d.parent.parent.glob("呼入记录_*.xlsx"):
            pass
        # 直接从明细 json 的 meta 里取（run_slot.sh 写入时带了 meta）
        mj = d / "质检明细.json"
        if mj.exists():
            for r in json.loads(mj.read_text(encoding="utf-8")):
                meta = r.get("meta") or {}
                tr = str(meta.get("通话记录") or "")
                if tr:
                    out[str(r.get("call_id"))] = tr
        else:
            # 回退：从上一级 output/ 的源 xlsx 重建
            out.update(load_transcripts_from_xlsx(
                [str(p) for p in d.parent.parent.glob("呼入记录_*.xlsx")]))
    return out


def load_transcripts_for_slot(slot_dir: Path) -> dict:
    """按时段日期从 output/ 目录加载对话原文（只读相关文件，避免全量扫描）。

    xlsx 命名：呼入记录_<起>_<止>.xlsx。跨夜段文件名以「前一日」开头，
    因此同时匹配当天与前一天的文件。
    """
    import datetime as _dt
    day = slot_dir.parent.name          # YYYYMMDD
    prev = ""
    try:
        prev = (_dt.datetime.strptime(day, "%Y%m%d")
                - _dt.timedelta(days=1)).strftime("%Y%m%d")
    except ValueError:
        pass
    root = slot_dir.parent.parent.parent      # .../output/qc/<day>/<slot> → output
    paths = []
    for base in {day, prev} - {""}:
        paths += list(root.glob(f"呼入记录_{base}*.xlsx"))
    return load_transcripts_from_xlsx([str(x) for x in paths])



def apply_review(slot_dir: Path, write_back=True) -> dict:
    """对时段目录执行复核并写回修正后的明细/汇总。返回复核统计。"""
    slot_dir = Path(slot_dir)
    mj = slot_dir / "质检明细.json"
    sj = slot_dir / "质检汇总.json"
    if not mj.exists():
        raise FileNotFoundError(mj)

    reports = json.loads(mj.read_text(encoding="utf-8"))
    # transcript 从明细 meta 读取；缺则在目录内回退
    transcripts = {str(r.get("call_id")): str((r.get("meta") or {}).get("通话记录") or "")
                   for r in reports}
    missing = [cid for cid, tr in transcripts.items() if not tr]
    if missing:
        transcripts.update(load_transcripts_for_slot(slot_dir))

    stats, adjusted = review_reports(reports, transcripts)
    if write_back:
        _recomputed = summarize_reports(adjusted)
        (slot_dir / "质检明细.json").write_text(
            json.dumps(adjusted, ensure_ascii=False, indent=1), encoding="utf-8")
        if sj.exists():
            (slot_dir / "质检汇总.json").write_text(
                json.dumps(_recomputed, ensure_ascii=False, indent=1), encoding="utf-8")
        # 复核日志
        (slot_dir / "复核日志.json").write_text(
            json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
        # 标记已复核
        (slot_dir / ".reviewed").write_text(
            json.dumps({"at": _now(), "reviewed": stats["reviewed"],
                        "demoted": stats["demoted"]}, ensure_ascii=False), encoding="utf-8")
    return stats


def summarize_reports(reports: list) -> dict:
    """与 jjwl_qc.rules.summarize 口径一致的汇总重算。"""
    total = len(reports)
    failed = [r for r in reports if r.get("verdict") == "不合格"]
    red = [r for r in reports if r.get("redline_hits")]
    by_rule = {}
    for r in reports:
        for f in (r.get("redline_hits") or []) + (r.get("deductions") or []):
            by_rule[f["rule_id"]] = by_rule.get(f["rule_id"], 0) + 1
    avg = round(sum(float(r.get("score") or 0) for r in reports) / total, 1) if total else 0
    by_rule = dict(sorted(by_rule.items(), key=lambda x: -x[1]))
    return {"total": total, "pass": total - len(failed), "fail": len(failed),
            "fail_rate": round(len(failed) / total * 100, 1) if total else 0.0,
            "redline_calls": len(red), "by_rule": by_rule, "avg_score": avg}


def _now():
    import datetime as dt
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ======================================================================
# 自检
# ======================================================================
def _demo():
    base = {
        "call_id": "T1",
        "verdict": "不合格", "score": 0.0,
        "redline_hits": [{
            "rule_id": "R05", "rule_name": "门票优惠未完整输出",
            "level": "红线", "points": 100,
            "evidence": "用户：学生票能优惠多少？ / AI：学生凭学生证可享半价优惠。",
            "detail": "缺失限制提示", "suggestion": "补全限制提示",
        }],
        "deductions": [], "observations": [], "meta": {}, "stats": {},
    }
    tr = ("ME:学生票能优惠多少？\n"
          "AI:学生凭学生证可享半价优惠，不含索道等二次消费，需要带本人学生证。")
    stats, adjusted = review_reports([base], {"T1": tr})
    ok1 = stats["pass"] == 1 and adjusted[0]["verdict"] == "不合格"

    # 误判样本：问发票顺带提学生票 → 应剔除
    fp = json.loads(json.dumps(base))
    fp["call_id"] = "T2"
    fp["redline_hits"][0]["evidence"] = (
        "用户：带团队上来都是学生票，我想开发票，开个人还是企业呢？ / "
        "AI：可以在小程序里申请电子发票，开个人还是企业看报销要求。")
    tr2 = ("ME:带团队上来都是学生票，我想开发票，开个人还是企业呢？\n"
           "AI:可以在小程序里申请电子发票，开个人还是企业看报销要求。")
    stats2, adjusted2 = review_reports([fp], {"T2": tr2})
    ok2 = stats2["demoted"] == 1 and adjusted2[0]["verdict"] == "合格"

    # R12 固定播报误判 → 剔除
    r12 = {
        "call_id": "T3", "verdict": "合格", "score": 85.0,
        "redline_hits": [],
        "deductions": [{
            "rule_id": "R12", "rule_name": "无效重复追问", "level": "扣分",
            "points": 15,
            "evidence": "上一轮：您好，这里是庐山文旅智能客服… / 本轮：您好，这里是庐山文旅智能客服…",
            "detail": "重复追问", "suggestion": "",
        }],
        "observations": [], "meta": {}, "stats": {},
    }
    stats3, adjusted3 = review_reports([r12], {"T3": "ME:嗯\nAI:您好，这里是庐山文旅智能客服…"})
    ok3 = stats3["demoted"] == 1 and adjusted3[0]["score"] == 100.0

    # R08 机构转述误判 → 剔除
    r08 = {
        "call_id": "T4", "verdict": "不合格", "score": 0.0,
        "redline_hits": [{
            "rule_id": "R08", "rule_name": "未授权联系方式", "level": "红线",
            "points": 100,
            "evidence": "AI：南山派出所是 0792-8297667。",
            "detail": "出现非白名单号码", "suggestion": "",
        }],
        "deductions": [], "observations": [], "meta": {}, "stats": {},
    }
    stats4, adjusted4 = review_reports([r08], {"T4": "ME:派出所电话\nAI:南山派出所是 0792-8297667。"})
    ok4 = stats4["demoted"] == 1 and adjusted4[0]["verdict"] == "合格"

    print(f"真实问题复核通过: {'PASS' if ok1 else 'FAIL'}")
    print(f"发票误判剔除:     {'PASS' if ok2 else 'FAIL'}")
    print(f"固定播报剔除:     {'PASS' if ok3 else 'FAIL'}")
    print(f"机构转述剔除:     {'PASS' if ok4 else 'FAIL'}")
    return all([ok1, ok2, ok3, ok4])


def main(argv):
    if "--demo" in argv:
        return 0 if _demo() else 1
    slot_dir = None
    if "--slot-dir" in argv:
        slot_dir = Path(argv[argv.index("--slot-dir") + 1])
    if not slot_dir:
        print("用法: review.py --slot-dir <时段目录>")
        return 2
    stats = apply_review(slot_dir)
    print(f"复核 {stats['reviewed']} 条：确认 {stats['pass']}，"
          f"剔除 {stats['demoted']}（{stats['demoted_calls']} 通），"
          f"转人工 {stats['manual']}")
    return 0


if __name__ == "__review__":
    pass
if __name__ == "__main__":
    sys.exit(main(sys.argv))
