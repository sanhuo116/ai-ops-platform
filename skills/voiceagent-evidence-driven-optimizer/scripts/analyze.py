"""Build evidence inventories and data-quality counts without inventing policy verdicts."""
import argparse
from collections import Counter,defaultdict
import json
from pathlib import Path
import planet

def inventory(snapshot):
    s=json.loads(Path(snapshot).read_text())
    return {'bot_id':s['bot_id'],'environment':s['environment'],
        'prompt_nodes':[{'node_id':x['node']['sceneNodeId'],'variants':len(x['config']['promptList']),
                         'tool_names':[t.get('toolName') or t.get('toolCode') for t in x['config'].get('functionCallConfig',[])]} for x in s['flow_prompts']],
        'knowledge':[{'knowledge_id':x['knowledgeBaseId'],'group_id':x['knowledgeGroupId'],
                      'question':x['standardQuestion'],'similar_questions':len(x.get('similarQuestionList') or []),
                      'source_ref':'snapshot.knowledge.'+str(x['knowledgeBaseId'])} for x in s['knowledge']],
        'unsupported_flows':s['unsupported_flows'],'extras_status':{k:v['status'] for k,v in s['extras'].items()},
        'next':'Agent must read full original text including parentheses/exceptions, extract atomic conditions and audit conflicts; this inventory is not a generated gold standard.'}

def calls_quality(calls,logs):
    grouped=defaultdict(list)
    for row in logs:grouped[str(row['inbound_instance_id'])].append(row)
    counts=Counter(str(r['inbound_instance_log_id']) for r in logs)
    ids={str(r['inbound_instance_id']) for r in calls}
    return {'metadata_calls':len(calls),'calls_with_logs':len(ids & grouped.keys()),
        'calls_without_logs':len(ids-grouped.keys()),'log_rows':len(logs),'unique_log_ids':len(counts),
        'duplicate_log_rows':sum(n-1 for n in counts.values()),'empty_text_rows':sum(not (r.get('content') or '').strip() for r in logs),
        'orphan_log_calls':len(grouped.keys()-ids),'speaker_values':dict(Counter(str(r.get('speaker')) for r in logs)),
        'sequence_continuity':'UNVERIFIED: parse actual extend_field dialogue index before declaring no gaps',
        'semantic_errors':'NOT_ASSESSED: candidate screening and full-context review are separate stages'}

def main():
    ap=argparse.ArgumentParser(description=__doc__);sub=ap.add_subparsers(dest='action',required=True)
    p=sub.add_parser('inventory');p.add_argument('--snapshot',required=True);p.add_argument('--out',required=True)
    p=sub.add_parser('call-quality');p.add_argument('--calls',required=True);p.add_argument('--logs',required=True);p.add_argument('--out',required=True)
    a=ap.parse_args()
    result=inventory(a.snapshot) if a.action=='inventory' else calls_quality(json.loads(Path(a.calls).read_text()),json.loads(Path(a.logs).read_text()))
    planet.save_json(a.out,result);print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
