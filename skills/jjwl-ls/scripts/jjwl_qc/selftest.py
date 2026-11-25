# -*- coding: utf-8 -*-
"""规则自检：跑回归用例，报告通过率与失配明细。"""
from __future__ import annotations
import sys
from .cases import CASES
from .facts import build_factbase
from .rules import RuleEngine
from .transcript import make_call


def run_selftest(verbose=True):
    eng = RuleEngine(build_factbase())
    ok, bad = 0, []
    for cid, desc, expect, rules, tr in CASES:
        rep = eng.inspect(make_call(cid, tr))
        hit = {f.rule_id for f in rep.redline_hits + rep.deductions}
        verdict_ok = rep.verdict == expect
        rules_ok = all(r in hit for r in rules)
        if verdict_ok and rules_ok:
            ok += 1
            if verbose:
                print(f"  PASS {cid:24s} {rep.verdict:4s} {sorted(hit)}")
        else:
            bad.append((cid, desc, expect, rep.verdict, sorted(hit), rules))
            if verbose:
                print(f"  FAIL {cid:24s} 期望{expect}/{rules} 实际{rep.verdict}/{sorted(hit)}")
    total = len(CASES)
    print(f"\n自检：{ok}/{total} 通过")
    return ok, total, bad


if __name__ == "__main__":
    ok, total, bad = run_selftest()
    sys.exit(0 if ok == total else 1)
