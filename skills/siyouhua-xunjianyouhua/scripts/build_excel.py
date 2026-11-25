#!/usr/bin/env python3
# 全量巡检 Excel（6 sheet，与一期同格式）
import json
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

W = 'xj_calls/work/'
rows = json.load(open(W + 'full_merged.json'))
fixrep = json.load(open(W + 'full_fix_report.json'))
st = json.load(open(W + 'full_stat.json'))
fixmap = {f['find']: f for f in fixrep}

BOTNAME = {
    '2927710': '【3月-岚夕】黔南劝阻-通用劝阻 (2927710)',
    '2928610': '【3月-岚夕】黔南劝阻-投资理财劝阻 (2928610)',
    '2934010': '紧急高危重播可用-黔南 (2934010)',
}

wb = Workbook()
thin = Side(style='thin', color='CCCCCC')
border = Border(left=thin, right=thin, top=thin, bottom=thin)
hdr_fill = PatternFill('solid', fgColor='1F4E79')
hdr_font = Font(bold=True, color='FFFFFF', size=11)
wrap = Alignment(wrap_text=True, vertical='top')


def setup(ws, headers, widths):
    ws.append(headers)
    for i, h in enumerate(headers, 1):
        c = ws.cell(1, i)
        c.value = h
        c.font = hdr_font
        c.fill = hdr_fill
        c.alignment = wrap
        c.border = border
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = 'A2'


def fmt(ws):
    for row in ws.iter_rows(min_row=2):
        for c in row:
            c.alignment = wrap
            c.border = border


# ===== Sheet1 分支命中错误 =====
ws = wb.active
ws.title = '分支命中错误'
headers = ['序号', 'bot/话术', '节点', '分支路径', '有问题的用户问句(合并样例)', '出现次数',
           '当前错误命中的正则(可能多个)', 'AI实际去向', '优化建议', '优化后的正则', '样例通话ID']
setup(ws, headers, [6, 26, 16, 16, 46, 10, 46, 16, 44, 46, 14])
n = 0
for r in [x for x in rows if x['class'].startswith('正则层冲突')]:
    n += 1
    cur, opt = [], []
    for rex in r['regexes']:
        f = fixmap.get(rex)
        cur.append('↤ ' + rex)
        if f and f.get('keep'):
            opt.append(rex + '\n→ 改为: ' + '\n   或: '.join(f['new']) + '   [方案' + f['id'] + ']')
        elif f:
            opt.append(rex + '\n→ 方案' + f['id'] + '全量回归未通过(误伤)，放弃；建议人工重点质检该类说法')
        else:
            opt.append(rex + '\n→ 暂无安全改式；建议保持现状，人工重点质检该类说法')
    keep_ids = sorted({fixmap[rex]['id'] for rex in r['regexes'] if fixmap.get(rex, {}).get('keep')})
    sug = '；'.join(keep_ids) if keep_ids else '暂无安全改式；保持现状+人工质检'
    ws.append([n, BOTNAME[r['bot']], r['node'], r['path'],
               '\n'.join('· ' + t for t in r['texts']), r['count'], '\n'.join(cur), r['actual'],
               sug, '\n'.join(opt) if opt else '', ','.join(r['ids'])])
fmt(ws)

# ===== Sheet2 分支走默认未命中（含 默认偏离(需人工核查)） =====
ws2 = wb.create_sheet('分支走默认未命中')
headers2 = ['序号', 'bot/话术', '节点', '分支路径', '有问题的用户问句(合并样例)', '出现次数',
            '期望(默认)', 'AI实际去向', '问题分析', '建议', '样例通话ID']
setup(ws2, headers2, [6, 26, 16, 18, 46, 10, 18, 16, 40, 34, 14])
n = 0
for r in [x for x in rows if x['class'] in ('分支走默认未命中(偏离)', '默认偏离(需人工核查)')]:
    n += 1
    if r['class'] == '分支走默认未命中(偏离)':
        exp = r['expected']
        anal = '无正则命中时默认链走向与实际不符：答非所问被语义模型兜底路由'
        adv = '结合「知识库未命中(补正则)」sheet 补式，或人工确认该说法意图'
    else:
        exp = '(无默认目标/原地续说)'
        anal = '该说法无正则命中、也无默认偏离；实际去向由语义模型兜底路由'
        adv = '若该说法应属某正则分支→见「知识库未命中(补正则)」sheet 补式；否则保持语义兜底'
    ws2.append([n, BOTNAME[r['bot']], r['node'], r['path'],
                '\n'.join('· ' + t for t in r['texts']), r['count'], exp, r['actual'], anal, adv,
                ','.join(r['ids'])])
fmt(ws2)

# ===== Sheet3 知识库未命中(补正则) =====
ws3 = wb.create_sheet('知识库未命中(补正则)')
headers3 = ['序号', 'bot/话术', '节点', '分支路径', '用户问句(未命中,合并样例)', '出现次数',
            '应去分支(补到)', 'AI实际去向', '补式建议', '样例通话ID']
setup(ws3, headers3, [6, 26, 16, 18, 46, 10, 14, 16, 44, 14])
n = 0
for r in [x for x in rows if x['class'] == '正则未命中(可补)']:
    n += 1
    ws3.append([n, BOTNAME[r['bot']], r['node'], r['path'],
                '\n'.join('· ' + t for t in r['texts']), r['count'], r['actual'], r['actual'],
                '为「' + r['actual'] + '」分支补式：以样例说法为种子，按 zhengze-shengcheng 三段式生成；注意与否定式竞争方向',
                ','.join(r['ids'])])
fmt(ws3)

# ===== Sheet4 知识库命中错误(推断) =====
ws4 = wb.create_sheet('知识库命中错误(推断)')
setup(ws4, ['序号', '类别', '说明'], [6, 28, 100])
ws4.append([1, '知识库配置核查结论',
            '3个bot（2927710/2928610/2934010）全部节点 acceptBreakKnowledgeBaseList 与 knowledgeBaseId 均为空——话术未配置QA知识库打断，'
            '不存在「知识库命中错误」类问题；用户问答由 分支正则+语义标签 双通道处理。'])
ws4.append([2, '知识库未命中核查结论',
            '同上：无知识库挂载，故「知识库未命中」类问题不成立；本表以「知识库未命中(补正则)」sheet 承接该口径（正则补式建议）。'])
ws4.append([3, '配置破译要点',
            '① 带labelInfoIds且无keyword的分支=平台语义模型分支（50394肯定/50401未受骗/50397已被骗/304106近期没有/50398给家人转钱等），优先级高于正则；'
            '② acceptBreak=0 的节点用户说话不打断、固定走默认链；③ 2934010 全部节点 acceptBreak=0，正则层无可巡检（全量巡检贡献=0）。'])
fmt(ws4)

# ===== Sheet5 优化方案汇总 =====
ws5 = wb.create_sheet('优化方案汇总')
headers5 = ['方案ID', '作用域(全局库/bot节点)', '原正则', '优化后正则', '回归验证(变更段/误伤/修复)', '结论', '依据(错误样本)']
setup(ws5, headers5, [8, 26, 44, 52, 22, 12, 44])
LIBDESC = {
    'B1': '2928610 开场白|root 本地',
    'B1b': '2927710 开场白|root 本地',
    'B2': '2928610 开场白|root 本地',
    'B3': '2927710 开场白|root 本地',
    'C1': '全局库·肯定(已接到电话或信息)',
    'D1': '全局库·省厅-肯定（中性）',
    'A1': '全局库·否定（中性）', 'A2': '全局库·否定（中性）', 'A3': '全局库·否定（中性）',
    'D2': '全局库·省厅-肯定（中性）', 'E1': '全局库·已卸载', 'E2': '全局库·未受骗',
}
WHY = {
    'B1': '单字「不」过泛（拦截了/不烦/不错/不用等误命中）',
    'B1b': '2927710 开场白同款「不」正则过泛；全量回归修复22段、0误伤',
    'B2': '「最近没有了」「没有没有，我是老年人了」等被误抢答；扩双侧守卫',
    'B3': '「没有，没有，我们都是老年人了…」否定后接语境补充被抢答',
    'C1': '「哪里有贷款…钱都没有了」反问+否定链误命中',
    'D1': '裸「嗯。」是接听语气词不应作为肯定证据',
    'A1': '「没有」后接被骗实情的双跳问题：多式并集下改式无净增益',
    'A2': '反问句误判否定；全量回归误伤3段正确陈述句，放弃',
    'A3': '「没有，我们不信那些东西」误命中；全量回归零净增益',
    'D2': '裸「对。」同理；全量回归误伤7段',
    'E1': '「没删」「不卸载」误命中；全量错误样本中零出现',
    'E2': '「没有被骗」后接转折实情；全量错误样本中零出现',
}
for f in fixrep:
    concl = '✔ 采纳（回归通过）' if f.get('keep') else '✘ 放弃（回归不通过/零增益）'
    ws5.append([f['id'], LIBDESC[f['id']], f['find'], '\n'.join(f['new']),
                str(f['changedSeg']) + '/' + str(f['lostGood']) + '/' + str(f['flipBad']), concl, WHY[f['id']]])
fmt(ws5)

# ===== Sheet6 巡检总览 =====
ws6 = wb.create_sheet('巡检总览')
rows6 = [
    ['巡检范围', '用户上传的全部通话记录（4个zip，806,319通）；本轮=全量巡检（一期已巡检的3000通不重复计入问题）'],
    ['通话归属', '按开场白指纹归属：2927710=640,388（其中通用劝阻-低危1117版本9,502通）、2928610=42,465、2934010=24,768'],
    ['无法归属', '77,750通为另外12类按诈骗类型的专属劝阻开场白（刷单/虚假征信/冒充客服/虚假购物/网络交友/赌博/网游/冒充公职等），不属于本次5个bot话术包，未巡检'],
    ['未覆盖bot', '3138810(黔南劝阻-询问地址)、2939010(黔南公安-取现宣传)：话术包已破译（各9节点），但其开场白指纹对全部806,319通复扫=0命中，无该bot通话，故未巡检'],
    ['巡检口径', '规则版决策树：AI定位→用户段合并→打断词豁免→逐句正则判定→分支目标(含空节点跳转链) vs AI实际去向；通话级版本混用过滤（≥2句AI无法定位→该通不计正则问题）'],
    ['判定段数', st['judged']],
    ['正则命中且走向正确', st['ok']],
    ['语义分支接管且走向正确', st['okSemantic']],
    ['正则走默认且正确', st['okDefault']],
    ['节点内顺序推进(不计问题)', st['okInternalSeq']],
    ['分支命中错误', st['errWrong']],
    ['默认偏离(需人工核查)', st['errDefault']],
    ['无分支命中(gap)', st['noBranchHit']],
    ['版本混用通话(不计问题)', st['versionMixCalls']],
    ['打断词/系统提示跳过', st['fillerSkip']],
    ['无判定分支跳过', st['skipNoJudge']],
    ['错误合并口径', '同一(bot,节点,分支路径,错误类型,命中正则组,实际去向)合并为一行，保留≤6条去重样例问句+出现次数+样例通话ID'],
    ['错误分类汇总', '正则层冲突(可修复)=26,323例；语义路由接管(正则无法修改)=8,159例；默认偏离合计=37,942例；正则未命中(可补)=10,810例'],
    ['结论', '正则层可优化问题合并后 2,790 组（其中 932 组已有优化式）；采纳优化方案 6 条（B1/B1b/B2/B3/C1/D1，V8 全量回归 0 误伤）、放弃 6 条（A1/A2/A3/D2/E1/E2）；'
             '语义路由接管与默认偏离属平台语义层/话术引导问题，正则无法修复，已单列供人工核查。'],
]
for r in rows6:
    ws6.append(r)
ws6.column_dimensions['A'].width = 24
ws6.column_dimensions['B'].width = 120
for row in ws6.iter_rows(min_row=1):
    for c in row:
        c.alignment = wrap
ws6['A1'].font = Font(bold=True)
ws6['B1'].font = Font(bold=True)

wb.save('黔南反诈bot话术巡检_正则优化_全量.xlsx')
print('saved 黔南反诈bot话术巡检_正则优化_全量.xlsx')
