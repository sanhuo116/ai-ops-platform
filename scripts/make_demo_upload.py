import json
import openpyxl

by_call = {}
order = []
for l in open('../work/byai-calls/dialogue_turns.jsonl'):
    l = l.strip()
    if not l:
        continue
    o = json.loads(l)
    cid = str(o['id'])
    if cid not in by_call:
        by_call[cid] = []
        order.append(cid)
    by_call[cid].append(o)

rows = []
for cid in order[:600]:
    turns = sorted(by_call[cid], key=lambda t: t.get('turn', 0))
    lines = ''.join(('AI：' if t['role'] == 'AI' else '用户：') + t['text'] + '\n' for t in turns)
    rows.append([cid, lines])

wb = openpyxl.Workbook()
ws = wb.active
ws.append(['通话记录id', '通话记录'])
for r in rows:
    ws.append(r)
wb.save('/tmp/upload_demo.xlsx')
print('calls:', len(rows))

