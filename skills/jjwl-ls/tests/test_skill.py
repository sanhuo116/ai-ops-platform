# -*- coding: utf-8 -*-
"""jjwl-ls 技能自检脚本。

用法：
    cd <skill>/scripts && python3 ../tests/test_skill.py
或：
    PYTHONPATH=<skill>/scripts python3 <skill>/tests/test_skill.py
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

from jjwl_qc.facts import build_factbase            # noqa: E402
from jjwl_qc.rules import RuleEngine, FAIL          # noqa: E402
from jjwl_qc.selftest import run_selftest           # noqa: E402
from jjwl_qc.transcript import make_call            # noqa: E402


def check(cond, msg):
    print(("  OK   " if cond else "  FAIL ") + msg)
    return cond


def main() -> int:
    ok = True
    print("== 1. 事实库解析 ==")
    fb = build_factbase()
    st = fb.stats()
    ok &= check(st["policy_clauses"] >= 55, f"政策条款 {st['policy_clauses']} 条 (>=55)")
    ok &= check(st["kb_entries"] >= 160, f"知识库 {st['kb_entries']} 条 (>=160)")
    ok &= check(st["announcements"] >= 1, f"临时公告 {st['announcements']} 条 (>=1)")
    ok &= check(len(fb.output_rules) >= 5, f"输出规范 {len(fb.output_rules)} 条 (>=5)")

    print("== 2. 对话解析格式兼容 ==")
    three = [
        ("带序号", "0000:AI:你好\n0001:ME:门票多少钱"),
        ("无序号", "AI:你好\nME:门票多少钱"),
        ("JSON数组", '["0000:AI:你好","0001:ME:门票多少钱"]'),
    ]
    for name, raw in three:
        turns = make_call("t", raw).turns
        ok &= check(len(turns) == 2 and turns[0].role == "AI" and turns[1].role == "ME",
                    f"{name} 解析出 2 轮且角色正确")

    print("== 3. 规则回归用例 ==")
    passed, total, bad = run_selftest(verbose=False)
    ok &= check(passed == total, f"回归用例 {passed}/{total} 通过")
    for b in bad:
        print(f"       失配：{b}")

    print("== 4. 核心红线可复现（R05 漏限制提示）==")
    eng = RuleEngine(fb)
    tr = ("AI:您好，请问有什么可以帮您？\n"
          "ME:深圳居民门票有优惠吗？\n"
          "AI:有的，深圳居民可以按80元买庐山门票，11月15日到30日期间。\n"
          "ME:好的谢谢。")
    rep = eng.inspect(make_call("r05", tr))
    ok &= check(rep.verdict == FAIL, "漏限制提示被判不合格")
    ok &= check(any(f.rule_id == "R05" for f in rep.redline_hits), "命中 R05")

    print("== 5. 合规回答不被误伤 ==")
    tr2 = ("AI:您好，请问有什么可以帮您？\n"
           "ME:深圳居民门票有优惠吗？\n"
           "AI:有的。活动期为2026年11月15日至11月30日。深圳户籍居民（身份证前四位4403）、"
           "持深圳居住证者或深圳社保缴纳人员，凭本人对应证件原件到景区现场核验后，"
           "可按80元每人购买庐山门票，原价160元每人。适用范围为庐山核心景区及三叠泉、秀峰、"
           "白鹿洞书院、观音桥、桃花源、碧龙潭，不含观光车、索道等二次消费。\n"
           "ME:明白了谢谢。")
    rep2 = eng.inspect(make_call("ok", tr2))
    ok &= check(rep2.verdict != FAIL, f"完整回答判合格（实际 {rep2.verdict}）")

    print("== 6. CLI 可执行 ==")
    r = subprocess.run([sys.executable, "-m", "jjwl_qc.cli", "--demo",
                        "--output", "/tmp/_jjwl_test"],
                       cwd=str(SCRIPTS), capture_output=True, text=True)
    ok &= check(r.returncode == 0, "cli --demo 退出码 0")
    ok &= check(Path("/tmp/_jjwl_test/质检明细.json").exists(), "产出质检明细.json")

    print("\n" + ("全部通过" if ok else "存在失败项"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
