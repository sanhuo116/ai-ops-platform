#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ivr_inbound_audit.py — 纯数据侧呼入 IVR 巡检核心（模式B）

用法:
  python3 ivr_inbound_audit.py work/<bot>/turns_raw.json --time work/<bot>/turns_time.json

输入:
  turns_raw.json  DLC 导出 {"rows":[...]}，字段 inbound_instance_id / inbound_instance_log_id /
                  speaker_type('AI'|'用户') / content / user_mean
  turns_time.json 同表另拉 start_time/end_time/duration_ms（可选）

产出 (写在输入文件同目录):
  ivr_contexts.json   语境 × 路由矩阵 + examples
  ivr_defects.json    D1~D5 缺陷明细
  ivr_summary.json    汇总数字（供 Excel 概览页直接引用）

语境指纹 / 路由指纹按 bot 调整——顶部的 FP / ROUTE 是 2251810（黄埔反诈专线）的实测配置，
巡检其他 bot 先用 --probe 模式打印高频 AI 话术，再改这两个映射。
"""
import json, re, collections, argparse, os, sys

# ---------- 可按 bot 调整的映射 ----------
FP = [  # (语境名, 识别正则子串) —— 顺序即优先级，先命中先归
    ('主菜单',      r'请根据语音提示'),
    ('人工忙提示',  r'人工客服忙'),
    ('支付宝微信核实', r'支付宝、微信账号解冻'),   # 该句含"按键输入身份证"，必须排在身份证输入之前
    ('手机卡核实',  r'手机号码解冻'),
    ('身份证输入',  r'按键输入您的身份证号码'),
    ('银行卡号输入', r'解封的银行卡号'),
    ('身份证核实',  r'和您核实一下您的身份证'),
    ('联系方式输入', r'按键输入后续可以联系您的联系方式'),
    ('联系方式核实', r'和您核实一下联系方式'),
    ('单张多张',    r'单张银行卡冻结还是多张'),
    ('报案时间',    r'什么时候报案|什么时候开始不能使用'),
    ('派出所',      r'哪个派出所报案'),
    ('语音记录',    r'说出您遇到的问题|复述一次'),
    ('记录挂机',    r'记录成功|记录下来'),
    ('开场白',      r'这里是黄埔反诈专线'),
]

ROUTE = [  # (路由名, AI 下一句指纹)
    ('银行卡解冻', r'在办理银行卡解冻业务之前|解冻的银行卡号|单张银行卡冻结'),
    ('手机卡申诉', r'手机号码解冻'),
    ('支付宝微信', r'支付宝、微信'),
    ('案件咨询',   r'案件咨询|报案时间|什么时候报案'),
    ('其他问题',   r'说出您遇到的问题|复述一次'),
    ('人工忙提示', r'人工客服忙'),
    ('回主菜单',   r'请根据语音提示'),
    ('语音留言',   r'语音留言'),
    ('要身份证',   r'按键输入您的身份证号码'),
    ('核实身份证', r'和您核实一下您的身份证'),
    ('要卡号',     r'解封的银行卡号'),
    ('要联系方式', r'按键输入后续可以联系您的联系方式'),
    ('核实联系方式', r'和您核实一下联系方式'),
    ('问单张多张', r'单张银行卡冻结还是多张'),
    ('问报案时间', r'什么时候报案|什么时候开始不能使用'),
    ('问派出所',   r'哪个派出所报案'),
    ('记录挂机',   r'记录成功|记录下来'),
    ('上限挂机',   r'重复次数达到上限'),
    ('探活在吗',   r'^您好[。．]?\s*在吗$'),
]

MAN = re.compile(r'(转|找|要|请|帮我|给我).{0,3}人工|人工(服务|客服|坐席)|真人(客服)?|接(人|客服)|客服人员')
# 平台默认行为（用户规则）：调用按键(DTMF)输入、远程数据查询等工具期间，
# 系统默认用户的自然语言【不做】匹配识别——这些语境下的识别失败/无响应是设计行为，不计缺陷。
# 注意：只收"纯工具收集"语境；核实/问答语境 ASR 是激活的（确认词 150/151 被接受），不在此列。
TOOL_ONLY_CTXS = {'身份证输入', '银行卡号输入', '联系方式输入'}
PURE_NUM = re.compile(r'^(一|幺|壹|二|两|三|四|五|六|七|八|九|零|〇)+$')
NUM2KEY = {'一': '1', '幺': '1', '壹': '1', '二': '2', '两': '2', '三': '3', '四': '4',
           '五': '5', '六': '6', '七': '7', '八': '8', '九': '9', '零': '0', '〇': '0'}
KEY2NAME = {'1': '银行卡解冻', '2': '手机卡申诉', '3': '案件咨询', '4': '支付宝微信',
            '5': '其他问题', '0': '人工', '9': '重听'}
CONF = re.compile(r'^(嗯|嗯嗯|对|对对|对对对|是的|是|对呀|是的呀|好|好的|嗯对|哦|哦哦|啊|对的|是呀)'
                  r'[的呀啊呢哈嘛吧]?[。，,！？?]?$')
NEG = re.compile(r'^(没有|没被?冻结|不用了?|不需要|没办过|不是我的|没开通)[。，,！？?]?$')
NUM_ZHANG = re.compile(r'(?:^|[。，,！？?\s])[二两三四五六七八九\d]张|好几张')

BREAK = re.compile(r'<break[^>]*/>')


def norm(t):
    return BREAK.sub('', t or '').strip()


def load(path):
    rows = json.load(open(path))['rows']
    by = collections.defaultdict(list)
    for r in rows:
        by[r['inbound_instance_id']].append(r)
    for k in by:
        by[k].sort(key=lambda x: x['inbound_instance_log_id'])
    return by


def segments(rs):
    """连续用户轮合并为段（barge-in 修正），AI 轮单独成段"""
    segs, cur = [], []
    for r in rs:
        if r['speaker_type'] == '用户':
            cur.append(r)
        else:
            if cur:
                segs.append(('ME', cur)); cur = []
            segs.append(('AI', [r]))
    if cur:
        segs.append(('ME', cur))
    return segs


def ctx_of(text):
    for name, pat in FP:
        if re.search(pat, text):
            return name
    return None


def route_of(text):
    for name, pat in ROUTE:
        if name == '探活在吗':
            if re.match(pat, text):
                return name
        elif re.search(pat, text):
            return name
    return None


def ai_after(segs, si, maxskip=12):
    """段 si 之后第一个非空 AI 句（原文与路由名）"""
    for j in range(si + 1, min(si + 1 + maxskip, len(segs))):
        kind, seg = segs[j]
        if kind == 'AI':
            t = norm(seg[0]['content'])
            if t and t != '条件判断-条件判断节点':
                return t
    return None


def prev_ai(segs, si, maxback=4):
    for j in range(si - 1, max(-1, si - 1 - maxback), -1):
        kind, seg = segs[j]
        if kind == 'AI':
            t = norm(seg[0]['content'])
            if t and t != '条件判断-条件判断节点':
                return t
    return None


def probe(by, n=25):
    """--probe: 打印高频 AI 话术，帮助配置 FP/ROUTE"""
    c = collections.Counter()
    for rs in by.values():
        for r in rs:
            if r['speaker_type'] == 'AI':
                t = norm(r['content'])
                if t and t != '条件判断-条件判断节点':
                    c[t[:40]] += 1
    print('高频 AI 话术（配置 FP/ROUTE 用）:')
    for t, v in c.most_common(n):
        print(f'  {v:5d}  {t}')


def audit(by, timedata=None):
    tidx = {}
    if timedata:
        for r in timedata['rows']:
            tidx[(r['inbound_instance_id'], r['inbound_instance_log_id'])] = r

    matrix = collections.Counter()
    examples = {}
    defects = {'D1': [], 'D2': [], 'D3': [], 'D4': [], 'D5': []}

    for cid, rs in by.items():
        segs = segments(rs)
        for si, (kind, seg) in enumerate(segs):
            if kind != 'ME':
                continue
            texts = [norm(x['content']) for x in seg if norm(x['content'])]
            if not texts:
                continue
            joined = ' '.join(texts)
            prev = prev_ai(segs, si)
            nxt = ai_after(segs, si)
            nxt_r = route_of(nxt) if nxt else '无响应'
            ctx = ctx_of(prev) if prev else None

            if ctx and nxt_r:
                matrix[(ctx, nxt_r)] += 1
                ex = examples.setdefault(f'{ctx}||{nxt_r}', [])
                if len(ex) < 3:
                    ex.append({'call': cid, 'said': joined[:40]})

            # ---------- 工具语境豁免（用户规则，优先于一切缺陷判定） ----------
            # 调用按键(DTMF)输入、远程数据查询等工具时，系统默认用户的自然语言【不做】匹配识别，
            # 这些语境下的识别失败/无响应（含说了话没被理睬）都是平台默认行为，忽略不计缺陷。
            # 注意：只豁免"纯工具收集"语境；核实/问答语境 ASR 是激活的
            # （确认词 150/151 被接受），D4 等分支缺失仍要报。
            if ctx in TOOL_ONLY_CTXS:
                continue

            # ---------- D1 转人工意图未响应 ----------
            if MAN.search(joined) and nxt:
                if nxt_r != '人工忙提示':  # 转人工提示=正确
                    defects['D1'].append({'call': cid, 'ctx': ctx or '(无前文)', 'said': joined[:36],
                                          'prev': (prev or '')[:34], 'route': nxt_r or nxt[:30]})
                    continue  # 已按人工意图计，避免重复归类

            # ---------- D4 探活后确认词被拒 ----------
            # 注意：必须在"无语境 continue"之前——"您好。在吗"是独立探活语境，ctx 可能为 None
            # 两型：a) 核实语境直接应答确认词被重问（罕见）；
            #       b) "您好。在吗"后应答确认词 → AI 重问核实（主型：在吗子节点缺确认分支）
            if CONF.match(joined.rstrip('。')) and nxt and '和您核实一下您的身份证' in nxt \
               and (ctx == '身份证核实' or (prev and '在吗' in prev and len(prev) <= 10)):
                defects['D4'].append({'call': cid, 'confirm': joined[:10],
                                      'via_zaima': bool(prev and '在吗' in prev and len(prev) <= 10)})

            if not ctx or not nxt:
                continue

            # ---------- D2 菜单数字词误路由 ----------
            if ctx == '主菜单' and all(PURE_NUM.match(t.rstrip('。')) for t in texts):
                key = NUM2KEY.get(texts[0][0])
                if key and nxt_r == '支付宝微信' and key != '4':
                    defects['D2'].append({'call': cid, 'said': joined[:16],
                                          'expect': KEY2NAME.get(key, '?'), 'ai': nxt[:40]})

            # ---------- D3 问句原样重问 ----------
            # 判定用语境指纹相等（重问句常不带"好的，"前缀，逐字相等会漏）
            if nxt and prev and ctx_of(prev) == ctx_of(nxt) \
               and ctx_of(prev) in ('单张多张', '报案时间', '派出所', '语音记录'):
                defects['D3'].append({'call': cid, 'ctx': ctx_of(prev), 'said': joined[:20]})            # ---------- D5 否认仍进流程 ----------
            # 口径（段模型正确形态）：主菜单语境，段含否认词（没有/不用/不是/不需要…），
            # 但 AI 响应 = 进入业务核实（在办理…业务之前需要先核实）= 否认被无视。
            # 教训1：不能拿"AI前句语境=支付宝核实"来抓——否认段发生在问句【之前】，prev 是主菜单。
            # 教训2：段是 barge-in 合并的混合段，要用【搜索】版否认词（孤立锚定版会全漏）。
            if ctx == '主菜单' and re.search(r'(没有|不是|没冻结|没被冻结|不用|不需要)', joined) and nxt \
               and ('在办理支付宝' in nxt or '在办理手机号码解冻' in nxt):
                defects['D5'].append({'call': cid, 'said': joined[:30], 'ai': nxt[:40]})

    # D4 在吗链占比（根因定位：在吗子节点缺确认分支）
    d4_zaima = sum(1 for d in defects['D4'] if d.get('via_zaima'))

    summary = {
        'calls': len(by),
        'turns': sum(len(v) for v in by.values()),
        'matrix': {f'{k[0]}||{k[1]}': v for k, v in matrix.items()},
        'defect_counts': {k: len(v) for k, v in defects.items()},
        'D4_in_zaima_chain': d4_zaima,
    }
    return matrix, examples, defects, summary


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('raw')
    ap.add_argument('--time')
    ap.add_argument('--probe', action='store_true')
    a = ap.parse_args()
    by = load(a.raw)
    if a.probe:
        probe(by)
        return
    timedata = json.load(open(a.time)) if a.time else None
    matrix, examples, defects, summary = audit(by, timedata)
    outdir = os.path.dirname(os.path.abspath(a.raw))
    json.dump({'matrix': {f'{k[0]}||{k[1]}': v for k, v in matrix.items()},
               'examples': examples}, open(f'{outdir}/ivr_contexts.json', 'w'), ensure_ascii=False, indent=1)
    json.dump(defects, open(f'{outdir}/ivr_defects.json', 'w'), ensure_ascii=False, indent=1)
    json.dump(summary, open(f'{outdir}/ivr_summary.json', 'w'), ensure_ascii=False, indent=1)
    print('缺陷计数:', {k: len(v) for k, v in defects.items()})
    print('矩阵条目:', len(matrix), '| 产出于', outdir)


if __name__ == '__main__':
    main()
