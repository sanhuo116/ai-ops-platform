"""BOTID/time-scoped read-only DLC extraction; outbound <=2000 calls per BOT/day."""
import argparse
from datetime import datetime,timedelta
import importlib.util
import json
from pathlib import Path
import sys
import planet

TABLES={'inbound':'dwd_call_inbound_instance_di','logs':'ods_call_byrobotprod_inbound_instance_log_di',
        'outbound':'dwd_call_call_instance_di'}

def require(value,message):
    if not value:raise ValueError(message)

def validate(bot,start,end):
    require(isinstance(bot,int) and bot>0,'Positive BOTID required')
    a=datetime.strptime(start,'%Y-%m-%d %H:%M:%S');b=datetime.strptime(end,'%Y-%m-%d %H:%M:%S')
    require(a<b,'Empty/reversed time window');return a,b

def day_windows(start,end):
    a=datetime.strptime(start,'%Y-%m-%d %H:%M:%S');b=datetime.strptime(end,'%Y-%m-%d %H:%M:%S')
    while a<b:
        n=min(b,a.replace(hour=0,minute=0,second=0)+timedelta(days=1))
        yield a.strftime('%Y-%m-%d %H:%M:%S'),n.strftime('%Y-%m-%d %H:%M:%S');a=n

def plan(bot,start,end,direction):
    a,b=validate(bot,start,end)
    return {'kind':'bot-call-extraction-v1','bot_id':bot,'direction':direction,'start':start,'end':end,
        'timezone':'Asia/Shanghai','interval':'left_closed_right_open',
        'tables':[TABLES[direction]]+([TABLES['logs']] if direction=='inbound' else []),
        'outbound_daily_call_limit':2000 if direction=='outbound' else None,
        'day_windows':[list(window) for window in day_windows(start,end)],
        'boundary':'Only explicitly authorized tables. COUNT compared with extraction. Raw inbound logs are not an aggregated transcript.'}

def predicate(bot,start,end):
    a,b=validate(bot,start,end)
    return "robot_def_id="+str(bot)+" AND dt BETWEEN '"+a.strftime('%Y%m%d')+"' AND '"+(b-timedelta(microseconds=1)).strftime('%Y%m%d')+"' AND start_time>='"+start+"' AND start_time<'"+end+"'"

def rows_of(result):
    require(result.get('status')=='SUCCEEDED' and not result.get('truncated'), 'DLC task incomplete/failed/truncated')
    rows=result.get('rows',[])
    require(all(isinstance(x,dict) for x in rows),'Unexpected result rows; inspect DLC schema adapter')
    return rows

def extract(p,out,configfile):
    d=Path(out);require(not d.exists(),'Output exists; preserve evidence and choose a new directory')
    d.mkdir(parents=True);d.chmod(0o700)
    dlc=Path(__file__).resolve().parent/'dlc';sys.path.insert(0,str(dlc))
    import keychain_credentials as credentials
    import tencent_query as tq
    config=json.loads(Path(configfile).read_text())
    sid,skey=credentials.load_credentials();uin=credentials.load_uin()
    allowed=tq.fetch_authorized_tables(config,sid,skey,uin)
    require(all(tq._table_reference_is_authorized('byai_bigdata.'+t,allowed,config) for t in p['tables']),
            'Required table missing from authorization listing; inspect policies with administrator, no full-catalog scan')
    planet.save_json(d/'plan.json',p)
    schema=tq.run_operation(config,sid,skey,'catalog',table_name=p['tables'],authorized_tables=allowed)
    planet.save_json(d/'schema.json',schema)
    seq=0
    def query(sql):
        nonlocal seq
        seq+=1;name=str(seq).zfill(5)
        (d/(name+'.sql')).write_text(sql,encoding='utf-8');(d/(name+'.sql')).chmod(0o600)
        value=tq.run_operation(config,sid,skey,'submit',sql=sql,authorized_tables=allowed,max_wait_seconds=900)
        planet.save_json(d/(name+'.json'),value)
        return rows_of(value)
    calls=[];logs=[];daily=[]
    direction=p['direction'];table='byai_bigdata.'+TABLES[direction]
    idfield='inbound_instance_id' if direction=='inbound' else 'call_instance_id'
    for start,end in p['day_windows']:
        where=predicate(p['bot_id'],start,end)
        count=int(query('SELECT count(*) AS n FROM '+table+' WHERE '+where+' LIMIT 1')[0]['n'])
        limit=count if direction=='inbound' else min(count,2000)
        current=[];last=-1
        fields=('inbound_instance_id,robot_def_id,robot_name,start_time,end_time,finish_status,ai_duration,dt'
            if direction=='inbound' else 'call_instance_id,robot_def_id,start_time,content,dt')
        while len(current)<limit:
            n=min(1000,limit-len(current))
            batch=query('SELECT '+fields+' FROM '+table+' WHERE '+where+' AND '+idfield+'>'+str(last)+' ORDER BY '+idfield+' LIMIT '+str(n))
            require(batch,'Pagination ended before COUNT');require(len(batch)<=n,'Row limit violated')
            ids=[int(x[idfield]) for x in batch]
            require(ids==sorted(set(ids)) and ids[0]>last,'Unstable/duplicate call IDs')
            current+=batch;last=ids[-1]
        require(len(current)==limit,'COUNT/extraction mismatch')
        calls+=current;daily.append({'start':start,'end':end,'count':count,'downloaded':len(current),
            'sampling':'first_2000_by_call_id' if count>limit else 'full_window'})
        print(json.dumps({'day':start[:10],'count':count,'downloaded':len(current)}),flush=True)
    require(len({x[idfield] for x in calls})==len(calls),'Duplicate call across day windows')
    if direction=='inbound' and calls:
        # Logs are selected by observed call IDs; avoid losing messages crossing midnight.
        a,b=validate(p['bot_id'],p['start'],p['end'])
        partitions="dt BETWEEN '"+a.strftime('%Y%m%d')+"' AND '"+b.strftime('%Y%m%d')+"'"
        for offset in range(0,len(calls),100):
            ids=','.join(str(int(x[idfield])) for x in calls[offset:offset+100])
            where=partitions+' AND robot_def_id='+str(p['bot_id'])+' AND inbound_instance_id IN ('+ids+')'
            table='byai_bigdata.'+TABLES['logs'];count=int(query('SELECT count(*) AS n FROM '+table+' WHERE '+where+' LIMIT 1')[0]['n'])
            current=[];last=-1
            while len(current)<count:
                batch=query('SELECT inbound_instance_log_id,inbound_instance_id,robot_def_id,speaker,content,gmt_create,extend_field,dt FROM '+table+' WHERE '+where+' AND inbound_instance_log_id>'+str(last)+' ORDER BY inbound_instance_log_id LIMIT 1000')
                require(batch,'Logs pagination ended before COUNT')
                found=[int(x['inbound_instance_log_id']) for x in batch]
                require(found==sorted(set(found)) and found[0]>last,'Unstable/duplicate log IDs')
                current+=batch;last=found[-1]
            require(len(current)==count,'Log COUNT/extraction mismatch');logs+=current
    require(len({r['inbound_instance_log_id'] for r in logs})==len(logs),'Duplicate log ID across call groups')
    planet.save_json(d/'calls.json',calls);planet.save_json(d/'logs.json',logs)
    summary={'bot_id':p['bot_id'],'direction':direction,'metadata_calls':len(calls),'unique_logs':len(logs),
        'daily':daily,'call_sha256':planet.fingerprint(calls),'log_sha256':planet.fingerprint(logs),
        'warning':'Cross-boundary logs only through end-date partition; unusually long calls need a separately scoped extension. Stable log-ID order is not proof of dialogue sequence continuity.'}
    planet.save_json(d/'extraction-summary.json',summary);return summary

def main():
    ap=argparse.ArgumentParser(description=__doc__);sub=ap.add_subparsers(dest='action',required=True)
    p=sub.add_parser('plan');p.add_argument('bot_id',type=int);p.add_argument('--start',required=True);p.add_argument('--end',required=True)
    p.add_argument('--direction',choices=['inbound','outbound'],required=True);p.add_argument('--out',required=True)
    p=sub.add_parser('fetch');p.add_argument('--plan',required=True);p.add_argument('--out',required=True)
    p.add_argument('--config',default=str(Path(__file__).resolve().parent/'dlc/config.json'))
    a=ap.parse_args()
    if a.action=='plan':
        require(not Path(a.out).exists(),'Plan exists');result=plan(a.bot_id,a.start,a.end,a.direction);planet.save_json(a.out,result)
    else:
        saved=json.loads(Path(a.plan).read_text());expected=plan(saved['bot_id'],saved['start'],saved['end'],saved['direction'])
        require(saved==expected,'Plan modified/invalid');result=extract(saved,a.out,a.config)
    print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
