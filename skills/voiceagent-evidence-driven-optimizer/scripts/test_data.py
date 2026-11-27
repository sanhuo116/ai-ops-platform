import unittest
import warehouse
import analyze
import tempfile
from unittest.mock import Mock,patch
import sys
import json

class DataTests(unittest.TestCase):
    def test_catalog_qualified_authorization_does_not_expand_database(self):
        sys.path.insert(0,str(warehouse.Path(warehouse.__file__).parent/'dlc'))
        import tencent_query as tq
        config={'actions':{'catalog':{'request':{'DatabaseName':'byai_bigdata'}}}}
        allowed=['DataLakeCatalog.byai_bigdata.dwd_call_inbound_instance_di']
        self.assertTrue(tq._table_reference_is_authorized('byai_bigdata.dwd_call_inbound_instance_di',allowed,config))
        self.assertFalse(tq._table_reference_is_authorized('other_db.dwd_call_inbound_instance_di',allowed,config))
    def test_midnight_month_boundary_is_right_open(self):
        p=warehouse.plan(1000001,'2026-10-31 23:00:00','2026-11-01 01:00:00','outbound')
        self.assertEqual(len(p['day_windows']),2)
        self.assertEqual(p['outbound_daily_call_limit'],2000)
        self.assertIn("dt BETWEEN '20261031' AND '20261031'",warehouse.predicate(1000001,*p['day_windows'][0]))
        self.assertEqual(p,json.loads(json.dumps(p)))
    def test_invalid_window_and_bot_rejected(self):
        for bot,start,end in [(0,'2026-11-01 00:00:00','2026-11-02 00:00:00'),
                              (1,'2026-11-02 00:00:00','2026-11-01 00:00:00')]:
            with self.assertRaises(ValueError):warehouse.plan(bot,start,end,'inbound')
    def test_running_or_truncated_task_is_not_zero(self):
        for r in [{'status':'RUNNING','rows':[]},{'status':'SUCCEEDED','truncated':True,'rows':[]}]:
            with self.assertRaises(ValueError):warehouse.rows_of(r)
    def test_quality_keeps_missing_duplicate_and_empty_separate(self):
        calls=[{'inbound_instance_id':1},{'inbound_instance_id':2}]
        logs=[{'inbound_instance_id':1,'inbound_instance_log_id':3,'content':'','speaker':'AI'}]*2
        r=analyze.calls_quality(calls,logs)
        self.assertEqual(r['calls_without_logs'],1);self.assertEqual(r['duplicate_log_rows'],1)
        self.assertEqual(r['empty_text_rows'],2);self.assertIn('UNVERIFIED',r['sequence_continuity'])
    def test_outbound_daily_budget_survives_multiple_pages(self):
        fake=Mock();creds=Mock();creds.load_credentials.return_value=('fake-id','fake-secret')
        creds.load_uin.return_value='fake-uin'
        fake.fetch_authorized_tables.return_value=['dwd_call_call_instance_di']
        fake._table_reference_is_authorized.return_value=True
        seen=[]
        def operation(config,sid,skey,op,**kw):
            if op=='catalog':return {'ok':True}
            sql=kw['sql'];seen.append(sql)
            if 'count(*)' in sql:rows=[{'n':2501}]
            else:
                offset=0 if 'call_instance_id>-1' in sql else 1000
                rows=[{'call_instance_id':i+1,'robot_def_id':1000001,'content':[]} for i in range(offset,offset+1000)]
            return {'status':'SUCCEEDED','rows':rows,'truncated':False}
        fake.run_operation.side_effect=operation
        with tempfile.TemporaryDirectory() as root,patch.dict(sys.modules,{'keychain_credentials':creds,'tencent_query':fake}):
            result=warehouse.extract(warehouse.plan(1000001,'2026-10-01 00:00:00','2026-10-02 00:00:00','outbound'),
                                     root+'/fetch',warehouse.Path(warehouse.__file__).parent/'dlc/config.json')
            self.assertEqual(result['metadata_calls'],2000)
            self.assertEqual(result['daily'][0]['count'],2501)
            self.assertEqual(len(seen),3)

if __name__=='__main__':unittest.main()
