"""Frozen casebank, real full-bank execution, hash-bound semantic reviews."""
import argparse
import asyncio
import concurrent.futures
import hashlib
import json
from pathlib import Path
import time
import planet

def read(path): return json.loads(Path(path).read_text(encoding='utf-8'))
def require(value,message):
    if not value: raise planet.PlanetError(message)
def key(cid): return hashlib.sha256(cid.encode()).hexdigest()[:24]
def resource_hash(snapshot):
    return planet.fingerprint({'global':snapshot['global_config'],'nodes':snapshot['nodes'],
        'prompts':[planet.prompt_fingerprint(planet.prompt_payload(x['config'])) for x in snapshot['flow_prompts']],
        'knowledge':snapshot['knowledge'],'extras':snapshot['extras'],
        'unsupported_flows':snapshot['unsupported_flows']})

def lint(bank):
    errors=[];seen={};inputs={};coverage={}
    require(isinstance(bank,list) and bank,'CASEBANK_MUST_BE_NONEMPTY_ARRAY')
    for c in bank:
        cid=c.get('id');turns=c.get('turns')
        if not isinstance(cid,str) or not cid or cid in seen:errors.append('Missing/duplicate id: '+str(cid))
        seen[cid]=True
        if not c.get('category') or not c.get('source_refs'):errors.append('Missing category/source_refs: '+str(cid))
        coverage[c.get('category','missing')]=coverage.get(c.get('category','missing'),0)+1
        if not isinstance(turns,list) or not turns:
            errors.append('Missing turns: '+str(cid));continue
        for t in turns:
            if not isinstance(t.get('user'),str) or not t['user'].strip() or not t.get('expected'):
                errors.append('Missing input/expected: '+str(cid))
            if t.get('expected_action','none') not in ['none','transferCall','clarify','hangup']:
                errors.append('Unknown action: '+str(cid))
        normalized=tuple(''.join(t.get('user','').split()).casefold() for t in turns)
        expectation=planet.fingerprint([{k:t.get(k) for k in ['expected','forbidden','expected_action']} for t in turns])
        if normalized in inputs:
            prev,oracle=inputs[normalized]
            errors.append(('Duplicate dialogue' if oracle==expectation else 'Potential conflicting oracle')+': '+str(prev)+' / '+str(cid))
        inputs[normalized]=(cid,expectation)
    return {'valid':not errors,'cases':len(bank),'errors':errors,'coverage':coverage,'casebank_sha256':planet.fingerprint(bank),
            'boundary':'Structural checks only. Policy and semantic conflict review must be performed by the agent.'}

def freeze(bank,audit,out):
    report=lint(bank);require(report['valid'],'CASEBANK_LINT_FAILED: '+str(report['errors']))
    require(audit.get('casebank_sha256')==report['casebank_sha256'] and audit.get('approved') is True
        and audit.get('reviewer') and audit.get('notes'),'EXPLICIT_SEMANTIC_AUDIT_REQUIRED')
    path=Path(out);require(not path.exists(),'FREEZE_EXISTS')
    planet.save_json(path,{'kind':'frozen-bank-v1','bank':bank,'audit':audit,'lint':report})

def frozen(path):
    f=read(path);require(f.get('kind')=='frozen-bank-v1','INVALID_FREEZE')
    require(planet.fingerprint(f['bank'])==f['lint']['casebank_sha256'],'BANK_HASH_MISMATCH')
    require(f['audit'].get('approved') is True and f['audit']['casebank_sha256']==f['lint']['casebank_sha256'],
            'FREEZE_AUDIT_MISMATCH')
    return f

def run(bot,bankfile,directory,state,variables,workers=1,resume=False):
    f=frozen(bankfile);bank=f['bank'];d=Path(directory)
    require(not d.exists() or resume,'RUN_EXISTS_USE_EXPLICIT_RESUME')
    d.mkdir(parents=True,exist_ok=True);client=planet.Planet(state)
    client.export(bot,d/('config-resume-'+str(time.time_ns()) if resume else 'config-before'))
    snapdir=max(d.glob('config-resume-*'),key=lambda p:p.name) if resume else d/'config-before'
    digest=resource_hash(read(snapdir/'snapshot.json'))
    info={'bot_id':bot,'environment':'dev','bank_sha256':f['lint']['casebank_sha256'],
          'resource_sha256':digest,'variables':variables,'workers':workers}
    if resume:
        prior=read(d/'run-info.json')
        require(all(info[k]==prior[k] for k in ['bot_id','environment','bank_sha256','resource_sha256','variables']),
                'RESUME_RESOURCE_BANK_OR_VARIABLE_DRIFT')
    else:
        planet.save_json(d/'run-info.json',info);planet.save_json(d/'frozen-bank.json',f)
    # Never rerun an already completed semantic failure to select a better answer.
    pending=[]
    for c in bank:
        file=d/(key(c['id'])+'.json')
        if file.exists():
            require(read(file)['case_sha256']==planet.fingerprint(c),'CASE_RESULT_HASH_MISMATCH')
        else:pending.append(c)
    if pending:planet.save_json(d/('prepare-'+str(time.time_ns())+'.json'),client.prepare_dev(bot))
    def execute(c):
        worker=planet.Planet(state);file=d/(key(c['id'])+'.json')
        try:
            result=asyncio.run(planet.text_test(worker,bot,[t['user'] for t in c['turns']],variables))
            planet.save_json(file,{'case_id':c['id'],'case_sha256':planet.fingerprint(c),'output':result})
            return True
        except Exception as exc:
            planet.save_json(d/(key(c['id'])+'-error-'+str(time.time_ns())+'.json'),
                {'case_id':c['id'],'error_type':type(exc).__name__,
                 'partial_output':getattr(exc,'partial_output',None),'requires_diagnosis':True})
            return False
    failures=0
    # Bounded chunks: at most 3 active sessions; stop scheduling after 3 transport failures.
    for start in range(0,len(pending),workers):
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            outcomes=list(pool.map(execute,pending[start:start+workers]))
        failures=failures+sum(not ok for ok in outcomes) if not all(outcomes) else 0
        count=sum((d/(key(c['id'])+'.json')).exists() for c in bank)
        planet.save_json(d/'progress.json',{'completed':count,'total':len(bank),'transport_failures_in_error_chunks':failures})
        print(json.dumps({'completed':count,'total':len(bank)}),flush=True)
        if failures>=3:break
    client.export(bot,d/'config-after')
    stable=digest==resource_hash(read(d/'config-after/snapshot.json'))
    summary={'cases':len(bank),'transport_complete':sum((d/(key(c['id'])+'.json')).exists() for c in bank),
             'resources_stable':stable,'resource_sha256':digest,'semantic_pass_claimed':False}
    planet.save_json(d/'summary.json',summary)
    require(stable,'RESOURCE_DRIFT_RETEST_FULL_BANK')
    return summary

def review(directory,case_id,verdict,rationale,reviewer,terminal_justification=None):
    d=Path(directory);f=frozen(d/'frozen-bank.json')
    cases=[c for c in f['bank'] if c['id']==case_id];require(len(cases)==1,'CASE_NOT_FOUND')
    raw=read(d/(key(case_id)+'.json'))
    require(raw['case_sha256']==planet.fingerprint(cases[0]),'CASE_RESULT_HASH_MISMATCH')
    require(verdict in ['PASS','FAIL','BLOCKED'] and rationale.strip() and reviewer.strip(),'INVALID_REVIEW')
    out=d/'reviews'/key(case_id);out.mkdir(parents=True,exist_ok=True)
    record={'case_id':case_id,'case_sha256':planet.fingerprint(cases[0]),'output_sha256':planet.fingerprint(raw),
        'verdict':verdict,'rationale':rationale,'reviewer':reviewer,
        'terminal_justification':terminal_justification,'timestamp_ns':time.time_ns()}
    planet.save_json(out/(str(record['timestamp_ns'])+'.json'),record)
    return record

def finalize(directory):
    d=Path(directory);f=frozen(d/'frozen-bank.json');summary=read(d/'summary.json');results=[]
    require(summary['resources_stable'],'UNSTABLE_RESOURCES')
    info=read(d/'run-info.json')
    require(info['bank_sha256']==f['lint']['casebank_sha256'],'RUN_BANK_MISMATCH')
    require(resource_hash(read(d/'config-before/snapshot.json'))==resource_hash(read(d/'config-after/snapshot.json'))
            ==info['resource_sha256'],'RESOURCE_SNAPSHOT_HASH_MISMATCH')
    for c in f['bank']:
        file=d/(key(c['id'])+'.json');require(file.exists(),'MISSING_EXECUTION: '+c['id'])
        raw=read(file);reviews=sorted((d/'reviews'/key(c['id'])).glob('*.json'))
        require(bool(reviews),'MISSING_REVIEW: '+c['id']);r=read(reviews[-1])
        require(r['case_sha256']==planet.fingerprint(c)==raw['case_sha256'] and
                r['output_sha256']==planet.fingerprint(raw),'STALE_REVIEW')
        output=raw['output'];turns=output.get('turns',[])
        require(output['bot_id']==info['bot_id'] and output['environment']=='dev','OUTPUT_TARGET_MISMATCH')
        if r['verdict']=='PASS':
            require(not output.get('sent_messages_without_reply'),'PASS_WITH_UNANSWERED_MESSAGE')
            require(all(t.get('complete') and t.get('assistant') for t in turns),'INCOMPLETE_REPLY')
            require([t['user'] for t in turns]==[t['user'].strip() for t in c['turns'][:len(turns)]],
                    'EXECUTED_INPUT_MISMATCH')
            need_transfer=any(t.get('expected_action')=='transferCall' for t in c['turns'][:len(turns)])
            got_transfer=any(planet.verified_terminal_transfer(e) for e in output.get('events',[]))
            if need_transfer: require(got_transfer,'SPOKEN_TRANSFER_IS_NOT_TOOL_ACTION')
            if len(turns)!=len(c['turns']):
                require(len(turns)<len(c['turns']) and got_transfer and need_transfer
                        and r.get('terminal_justification'),'INVALID_EARLY_TERMINATION')
                require(output.get('unexecuted_messages_after_terminal_action')==
                        [t['user'] for t in c['turns'][len(turns):]],'TERMINAL_ACCOUNTING_MISMATCH')
        results.append(r)
    result={'cases':len(results),'pass':sum(r['verdict']=='PASS' for r in results),
            'fail':sum(r['verdict']=='FAIL' for r in results),'blocked':sum(r['verdict']=='BLOCKED' for r in results),
            'all_reviewed':True,'resources_stable':True,'resource_sha256':info['resource_sha256'],
            'bank_sha256':info['bank_sha256'],'formal_publish':False}
    planet.save_json(d/'verified-summary.json',result);return result

def main():
    ap=argparse.ArgumentParser(description=__doc__);sub=ap.add_subparsers(dest='action',required=True)
    p=sub.add_parser('lint');p.add_argument('--bank',required=True)
    p=sub.add_parser('freeze');p.add_argument('--bank',required=True);p.add_argument('--audit',required=True);p.add_argument('--out',required=True)
    p=sub.add_parser('run');p.add_argument('bot_id',type=int);p.add_argument('--frozen',required=True);p.add_argument('--out',required=True)
    p.add_argument('--state-dir',default=str(planet.STATE));p.add_argument('--variables-file');p.add_argument('--workers',type=int,choices=[1,2,3],default=1);p.add_argument('--resume',action='store_true')
    p=sub.add_parser('review');p.add_argument('--run',required=True);p.add_argument('--case-id',required=True);p.add_argument('--verdict',choices=['PASS','FAIL','BLOCKED'],required=True)
    p.add_argument('--rationale',required=True);p.add_argument('--reviewer',required=True);p.add_argument('--terminal-justification')
    p=sub.add_parser('finalize');p.add_argument('--run',required=True)
    a=ap.parse_args()
    if a.action=='lint':result=lint(read(a.bank))
    elif a.action=='freeze':freeze(read(a.bank),read(a.audit),a.out);result={'frozen':a.out}
    elif a.action=='run':result=run(a.bot_id,a.frozen,a.out,a.state_dir,read(a.variables_file) if a.variables_file else {},a.workers,a.resume)
    elif a.action=='review':result=review(a.run,a.case_id,a.verdict,a.rationale,a.reviewer,a.terminal_justification)
    else:result=finalize(a.run)
    print(json.dumps(result,ensure_ascii=False,indent=2))
    if a.action=='lint' and not result['valid']:raise SystemExit(2)

if __name__=='__main__':main()
