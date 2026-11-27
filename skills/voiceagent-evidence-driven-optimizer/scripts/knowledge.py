"""Reversible BOTID-scoped plain FAQ edits; no production publication."""
import argparse
import copy
import json
from pathlib import Path
import planet

TOP = ['title','standardQuestion','keyword','smsTemplateId','actionParam','transferAction',
       'transferSeatGroupId','transferTelephone','labelInfoIds','intentionDef','attachmentSendFlag',
       'ruleType','onBlack','assistRobotId','onlineServiceSwitch','attachment','action','dataCollectFlag',
       'dataCollectExpression','extendField','extendFieldObj','userMeanHighPriority','abTestConfig',
       'similarQuestionList','similarityQuestion','sceneNodeId']
ANSWER = ['answer','answerId','decisionItemId','startTime','endTime','extraInfo','rawContent',
          'action','actionParam','sortIndex','sceneNodeId']

def require(value, message):
    if not value:
        raise planet.PlanetError(message)

def catalog(client, bot):
    robot = client.bind(bot, 'dev')
    tree = client.request('/decision/api/datacenter/knowledge/statistics',
        {'robotDefId':bot,'sceneDefId':robot['sceneDefId'],'environment':'dev','categoryIds':'1,2,3'})
    rows = client.request('/decision/api/knowledgeBase/list',
        {'robotDefId':bot,'environment':'dev','categoryIds':'1,2,3','knowledgeGroupId':tree['id']})
    require(isinstance(rows,list) and len(rows)==int(tree['count']), 'KNOWLEDGE_COUNT_MISMATCH')
    require(len({r['knowledgeBaseId'] for r in rows})==len(rows), 'DUPLICATE_KNOWLEDGE_IDS')
    return rows

def detail(client, bot, kid, rows):
    matching = [r for r in rows if int(r['knowledgeBaseId'])==kid]
    require(len(matching)==1, 'KNOWLEDGE_NOT_IN_BOT')
    info = client.request('/decision/api/knowledgeBase/info',
        {'robotDefId':bot,'knowledgeBaseId':kid,'environment':'dev'})
    require(int(info['robotId'])==bot and int(info['knowledgeBaseId'])==kid,'TARGET_MISMATCH')
    require(info['knowledgeType']==1 and info['action']==2 and len(info['answerList'])==1,
            'ONLY_SINGLE_ORDINARY_TEXT_FAQ_SUPPORTED')
    require(not info.get('abTestConfig'),'AB_FAQ_REQUIRES_ADAPTER')
    for a in info['answerList']:
        require(not any(a.get(k) for k in ['knowledgeOssUrl','knowledgeOssFullUrl',
                'knowledgeOssUrlAb','knowledgeOssFullUrlAb']), 'MANUAL_RECORDING_REQUIRES_ADAPTER')
    info['knowledgeGroupId'] = matching[0]['knowledgeGroupId']
    return info

def payload(info, bot):
    return {**{k:copy.deepcopy(info[k]) for k in TOP if k in info},'robotDefId':bot,
        'knowledgeBaseId':info['knowledgeBaseId'],'environment':'dev','labelConcern':True,
        'knowledgeGroupId':info['knowledgeGroupId'],
        'answerList':[{k:copy.deepcopy(a[k]) for k in ANSWER if k in a} for a in info['answerList']]}

def signature(info, bot):
    p = payload(info, bot)
    if p.get('sceneNodeId') in (None,-1): p['sceneNodeId']=None
    if p.get('smsTemplateId') in (None,-1): p['smsTemplateId']=None
    for key in ['labelInfoIds','extendFieldObj']:
        if p.get(key) in (None,'','null','[]','{}'): p[key]=None
    ext=p.get('extendField')
    ext=json.loads(ext or '[]') if isinstance(ext,(str,type(None))) else ext
    if not p.get('dataCollectFlag') and ext==[{'dialogDataCollectorType':0,'onBlack':False}]:ext=[]
    p['extendField']=ext
    return planet.fingerprint(p)

def edit(info, answer=None, similar=None):
    out=copy.deepcopy(info)
    if answer is not None:
        require(bool(answer.strip()),'EMPTY_ANSWER')
        a=out['answerList'][0]
        if a.get('rawContent'):
            raw=json.loads(a['rawContent'])
            require(not raw.get('entityMap') and len(raw['blocks'])==1,'RICH_MEDIA_REQUIRES_ADAPTER')
            b=raw['blocks'][0]
            require(b['type']=='unstyled' and not b.get('inlineStyleRanges') and not b.get('entityRanges')
                    and b['text']==a['answer'],'RICH_TEXT_REQUIRES_ADAPTER')
            b['text']=answer
            a['rawContent']=json.dumps(raw,ensure_ascii=False,separators=(',',':'))
        a['answer']=answer
    if similar is not None:
        require(isinstance(similar,list) and all(isinstance(x,str) and 0<len(x.strip())<=100 for x in similar),
                'INVALID_SIMILAR_QUESTIONS')
        old=out.get('similarQuestionList') or []
        require(len(set(similar))==len(similar) and not set(old)&set(similar),'DUPLICATE_SIMILAR_QUESTIONS')
        out['similarQuestionList']=old+similar
    return out

def plan(client,bot,kid,answer,similar,source):
    require(bool(source.strip()),'POLICY_SOURCE_REQUIRED')
    rows=catalog(client,bot)
    before=detail(client,bot,kid,rows)
    after=edit(before,answer,similar)
    return {'kind':'dev-plain-faq-v1','bot_id':bot,'environment':'dev','knowledge_id':kid,
        'source':source,'before':before,'after':after,
        'before_sha256':signature(before,bot),'after_sha256':signature(after,bot)}

def apply(client,p,rollback=False):
    require(p['kind']=='dev-plain-faq-v1' and p['environment']=='dev','DEV_ONLY')
    bot=int(p['bot_id']);kid=int(p['knowledge_id'])
    for side in ['before','after']:
        require(int(p[side]['robotId'])==bot and int(p[side]['knowledgeBaseId'])==kid,'PLAN_TARGET_MISMATCH')
        require(signature(p[side],bot)==p[side+'_sha256'],'PLAN_INTEGRITY_FAILED')
    source,target=('after','before') if rollback else ('before','after')
    rows=catalog(client,bot);before=detail(client,bot,kid,rows)
    require(signature(before,bot)==p[source+'_sha256'],'STALE_PLAN_NO_WRITE')
    client.request('/decision/api/knowledgeBase/update',method='POST',payload=payload(p[target],bot))
    after_rows=catalog(client,bot);actual=detail(client,bot,kid,after_rows)
    ok=signature(actual,bot)==p[target+'_sha256']
    old={r['knowledgeBaseId']:r for r in rows};new={r['knowledgeBaseId']:r for r in after_rows}
    require(ok and old.keys()==new.keys() and all(new[k]==r for k,r in old.items() if k!=kid),
            'WRITE_READBACK_MISMATCH_STOP_AND_INSPECT')
    return {'bot_id':bot,'knowledge_id':kid,'readback_verified':True,'rolled_back':rollback,
            'environment':'dev','formal_publish':False,'sha256':signature(actual,bot)}

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--state-dir',default=str(planet.STATE))
    sub=ap.add_subparsers(dest='action',required=True)
    p=sub.add_parser('plan');p.add_argument('bot_id',type=int);p.add_argument('--knowledge-id',type=int,required=True)
    p.add_argument('--answer-file');p.add_argument('--similar-additions-file');p.add_argument('--source',required=True)
    p.add_argument('--out',required=True)
    p=sub.add_parser('apply');p.add_argument('--plan',required=True);p.add_argument('--rollback',action='store_true')
    p.add_argument('--out',required=True)
    a=ap.parse_args();client=planet.Planet(a.state_dir)
    if a.action=='plan':
        require(not Path(a.out).exists(),'PLAN_ALREADY_EXISTS')
        require(a.answer_file or a.similar_additions_file,'NO_CHANGE_REQUESTED')
        result=plan(client,a.bot_id,a.knowledge_id,Path(a.answer_file).read_text() if a.answer_file else None,
                    json.loads(Path(a.similar_additions_file).read_text()) if a.similar_additions_file else None,a.source)
    else:result=apply(client,json.loads(Path(a.plan).read_text()),a.rollback)
    planet.save_json(a.out,result)
    print(json.dumps({'saved':a.out,'action':a.action,'formal_publish':False}))

if __name__=='__main__':main()
