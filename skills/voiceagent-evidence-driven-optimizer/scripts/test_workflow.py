import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
import knowledge as kb
import planet
import regression as rg
import iteration

FAQ={'robotId':1000001,'knowledgeBaseId':12,'knowledgeGroupId':7,'knowledgeType':1,'action':2,
     'standardQuestion':'Example eligibility','title':'Example eligibility','similarQuestionList':['original question'],
     'answerList':[{'answer':'Original conditional answer','action':2,'actionParam':'{}','sortIndex':1}],
     'sceneNodeId':None,'dataCollectFlag':False}
CASE={'id':'demo-1','category':'boundary','source_refs':['synthetic-policy-A'],
      'turns':[{'user':'Example request','expected':'Answer source-supported rule','expected_action':'none'}]}
SNAP={'global_config':{},'nodes':[],'flow_prompts':[],'knowledge':[],'extras':{},'unsupported_flows':[]}

class KnowledgeTests(unittest.TestCase):
    def client(self):
        c=Mock();c.bind.return_value={'sceneDefId':8};state=copy.deepcopy(FAQ)
        def request(path,params=None,payload=None,**kw):
            nonlocal state
            if path.endswith('statistics'):return {'id':7,'count':1}
            if path.endswith('/list'):return [{'knowledgeBaseId':12,'knowledgeGroupId':7}]
            if path.endswith('/info'):return copy.deepcopy(state)
            if path.endswith('/update'):
                state.update(copy.deepcopy(payload));state['robotId']=state.pop('robotDefId');return True
            raise RuntimeError(path)
        c.request.side_effect=request;return c
    def test_plan_edit_apply_rollback_preserves_id_group_and_original_alias(self):
        c=self.client();p=kb.plan(c,1000001,12,'New supported rule',['new formulation'],'policy A')
        self.assertEqual(p['after']['similarQuestionList'],['original question','new formulation'])
        self.assertTrue(kb.apply(c,p)['readback_verified']);self.assertTrue(kb.apply(c,p,True)['rolled_back'])
    def test_stale_plan_performs_no_update(self):
        c=self.client();p=kb.plan(c,1000001,12,'New supported rule',None,'policy A')
        kb.apply(c,p)
        c.request.reset_mock()
        with self.assertRaisesRegex(planet.PlanetError,'STALE_PLAN'):kb.apply(c,p)
        self.assertFalse(any(x.args[0].endswith('/update') for x in c.request.call_args_list))
    def test_tampered_target_and_payload_rejected(self):
        for field in ['bot_id','knowledge_id']:
            c=self.client();p=kb.plan(c,1000001,12,'new',None,'policy A');p[field]+=1
            with self.assertRaises(planet.PlanetError):kb.apply(c,p)
    def test_rich_text_or_duplicate_alias_rejected(self):
        with self.assertRaises(planet.PlanetError):kb.edit(FAQ,similar=['original question'])
        f=copy.deepcopy(FAQ);f['answerList'][0]['rawContent']=json.dumps({'entityMap':{'0':{}},'blocks':[]})
        with self.assertRaises(planet.PlanetError):kb.edit(f,answer='new')

class EvaluationTests(unittest.TestCase):
    def test_same_input_different_oracle_is_blocked(self):
        b=copy.deepcopy(CASE);b['id']='demo-2';b['turns'][0]['expected']='Opposite rule'
        self.assertFalse(rg.lint([CASE,b])['valid'])
    def test_freeze_rejects_unreviewed_bank_and_drift(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(planet.PlanetError):rg.freeze([CASE],{'approved':True},Path(root)/'bank.json')
            audit={'approved':True,'reviewer':'test','notes':'Synthetic oracle inspected','casebank_sha256':planet.fingerprint([CASE])}
            path=Path(root)/'bank.json';rg.freeze([CASE],audit,path)
            f=rg.read(path);f['bank'][0]['turns'][0]['expected']='tampered';planet.save_json(path,f)
            with self.assertRaises(planet.PlanetError):rg.frozen(path)
    def make_run(self,root,case=None,output=None):
        d=Path(root);case=case or CASE;bank=[case]
        rg.freeze(bank,{'approved':True,'reviewer':'test','notes':'Synthetic oracle inspected',
                  'casebank_sha256':planet.fingerprint(bank)},d/'frozen-bank.json')
        digest=rg.resource_hash(SNAP)
        planet.save_json(d/'run-info.json',{'bot_id':1000001,'environment':'dev','resource_sha256':digest,'bank_sha256':planet.fingerprint(bank)})
        for where in ['config-before','config-after']:planet.save_json(d/where/'snapshot.json',SNAP)
        planet.save_json(d/'summary.json',{'resources_stable':True})
        output=output or {'bot_id':1000001,'environment':'dev','turns':[{'user':'Example request','assistant':'Answer','complete':True}],'events':[]}
        planet.save_json(d/(rg.key(case['id'])+'.json'),{'case_id':case['id'],'case_sha256':planet.fingerprint(case),'output':output})
        return d
    def test_missing_review_cannot_finalize(self):
        with tempfile.TemporaryDirectory() as root:
            d=self.make_run(root)
            with self.assertRaisesRegex(planet.PlanetError,'MISSING_REVIEW'):rg.finalize(d)
    def test_old_review_cannot_cover_changed_output(self):
        with tempfile.TemporaryDirectory() as root:
            d=self.make_run(root);rg.review(d,'demo-1','PASS','Source inspected','test')
            raw=rg.read(d/(rg.key('demo-1')+'.json'));raw['output']['turns'][0]['assistant']='Different'
            planet.save_json(d/(rg.key('demo-1')+'.json'),raw)
            with self.assertRaisesRegex(planet.PlanetError,'STALE_REVIEW'):rg.finalize(d)
    def test_oral_transfer_and_unanswered_messages_cannot_pass(self):
        c=copy.deepcopy(CASE);c['turns'][0]['expected_action']='transferCall'
        for missing in [False,True]:
            with tempfile.TemporaryDirectory() as root:
                d=self.make_run(root,c)
                if missing:
                    f=d/(rg.key(c['id'])+'.json');raw=rg.read(f)
                    raw['output']['sent_messages_without_reply']=['Example request'];planet.save_json(f,raw)
                rg.review(d,c['id'],'PASS','Attempted invalid approval','test')
                with self.assertRaises(planet.PlanetError):rg.finalize(d)
    def test_valid_terminal_tool_requires_context_justification(self):
        c=copy.deepcopy(CASE);c['turns'][0]['expected_action']='transferCall'
        c['turns'].append({'user':'Unsent continuation','expected':'Only if dialogue continues'})
        out={'bot_id':1000001,'environment':'dev','turns':[{'user':'Example request','assistant':'Tool reply','complete':True}],
             'unexecuted_messages_after_terminal_action':['Unsent continuation'],
             'events':[{'type':'content','speaker':'AI','content':'Tool reply','promptToolReplyMeta':
                       {'toolReply':True,'toolType':'transfer','toolCode':'transferCall'}}]}
        with tempfile.TemporaryDirectory() as root:
            d=self.make_run(root,c,out);rg.review(d,c['id'],'PASS','Verified action','test')
            with self.assertRaises(planet.PlanetError):rg.finalize(d)
            rg.review(d,c['id'],'PASS','Verified action','test','User explicitly requested transfer; remaining continuation is not applicable')
            self.assertEqual(rg.finalize(d)['pass'],1)
    def test_write_gate_blocks_changed_live_configuration(self):
        with tempfile.TemporaryDirectory() as root:
            d=self.make_run(Path(root)/'run');rg.review(d,'demo-1','FAIL','Known failure needs repair','test')
            c=Mock()
            changed=copy.deepcopy(SNAP);changed['knowledge']=[{'unexpected':'drift'}]
            c.export.side_effect=lambda bot,out:planet.save_json(Path(out)/'snapshot.json',changed)
            with self.assertRaisesRegex(planet.PlanetError,'BASELINE_RESOURCE_DRIFT'):
                iteration.apply_change(c,'prompt',{'bot_id':1000001},d,Path(root)/'receipt.json')
            c.request.assert_not_called()

if __name__=='__main__':unittest.main()
