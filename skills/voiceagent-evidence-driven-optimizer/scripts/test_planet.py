import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

import planet


CONFIG = {'robotDefId': 1000001, 'sceneDefId': 10, 'sceneNodeId': 20,
          'abEnabled': 0, 'globalPromptSwitch': 1, 'firstAiWord': '',
          'firstNodeEnableVad': 0, 'functionCallConfig': [],
          'promptList': [{'prompt': 'original', 'sortIndex': 1, 'ratio': 1.0},
                         {'prompt': '', 'sortIndex': 2, 'ratio': 0.5}]}


class Response:
    def __init__(self, status, data): self.status_code, self.data = status, data
    def json(self): return self.data


class FakeClient:
    def __init__(self): self.current, self.writes = copy.deepcopy(CONFIG), []
    def bind(self, *args): return {'robotDefId': 1000001}
    def nodes(self, *args): return [{'sceneNodeId': 20, 'sceneFlowType': 2}]
    def prompt(self, *args): return self.current
    def request(self, path, payload=None, **kwargs):
        self.writes.append((path, copy.deepcopy(payload)))
        self.current = copy.deepcopy(payload)


class AuthenticationTests(unittest.TestCase):
    def test_http_auth_failure_is_not_empty_success(self):
        for status in (302, 401, 403):
            with self.subTest(status=status), self.assertRaises(planet.PlanetError):
                planet.decode_response(Response(status, {}))

    def test_application_failure_is_rejected_even_at_http_200(self):
        for data in ({'code': 500, 'resultMsg': 'failure'},
                     {'code': 200, 'success': False, 'data': {}},
                     {'code': 412, 'resultMsg': 'invalid args'}):
            with self.subTest(data=data), self.assertRaises(planet.PlanetError):
                planet.decode_response(Response(200, data))

    def test_error_does_not_echo_credential_message(self):
        with self.assertRaises(planet.PlanetError) as error:
            planet.decode_response(Response(200, {'code': 401, 'message': 'token=PRIVATE_TEST_VALUE'}))
        self.assertNotIn('PRIVATE_TEST_VALUE', str(error.exception))

    def test_permissive_session_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / 'session.json'
            planet.save_json(file, {'origin': planet.ORIGIN, 'cookie': 'FAKE'})
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            file.chmod(0o644)
            with self.assertRaisesRegex(planet.PlanetError, 'INSECURE_SESSION_FILE'):
                planet.Planet(root)

    def test_save_restricts_existing_file_permissions(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / 'session.json'
            file.write_text('{}')
            file.chmod(0o644)
            planet.save_json(file, {'cookie': 'FAKE'})
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)

    def test_bot_identity_mismatch_is_rejected(self):
        client = object.__new__(planet.Planet)
        client.request = lambda *args, **kwargs: {'robotDefId': 999}
        with self.assertRaisesRegex(planet.PlanetError, 'BOT_ID_MISMATCH'):
            client.identity(1000001)

    def test_bot_bootstrap_cannot_send_cookie_to_arbitrary_host(self):
        client = object.__new__(planet.Planet)
        client.identity = lambda bot: {'robotDefId': bot, 'companyId': 1}
        responses = iter([{'id': 1, 'mobile': 'FAKE'}, 'attacker.example'])
        client.request = lambda *args, **kwargs: next(responses)
        with self.assertRaisesRegex(planet.PlanetError, 'UNEXPECTED_BOT_SERVICE_HOST'):
            client.bind(1000001)


class ProtocolTests(unittest.TestCase):
    def test_sockjs_heartbeat_and_open_are_not_replies(self):
        self.assertEqual(planet.parse_sockjs('o'), [])
        self.assertEqual(planet.parse_sockjs('h'), [])

    def test_sockjs_batched_frames_keep_json_and_order(self):
        body = json.dumps({'type': 'content', 'content': '160'})
        raw = 'a' + json.dumps([planet.stomp_frame('CONNECTED', {'version': '1.1'}) +
                                planet.stomp_frame('MESSAGE', {'subscription': 'cli0'}, body)])
        frames = planet.parse_sockjs(raw)
        self.assertEqual([x[0] for x in frames], ['CONNECTED', 'MESSAGE'])
        self.assertEqual(json.loads(frames[1][2])['content'], '160')

    def test_partial_cumulative_chunk_cannot_finish_a_turn(self):
        event = {'type': 'content', 'speaker': 'AI', 'content': '160',
                 'stream': True, 'streamFinish': False}
        self.assertFalse(planet.completed_ai(event))
        event['streamFinish'] = True
        self.assertTrue(planet.completed_ai(event))
        event['speaker'] = 'ME'
        self.assertFalse(planet.completed_ai(event))

    def test_actual_transfer_receipts_finish_without_stream_flag(self):
        # Both captured server receipts were incorrectly classified as timeouts.
        directory = Path(__file__).resolve().parent / 'fixtures'
        fixtures = sorted(directory.glob('transfer-*.json'))
        self.assertEqual(len(fixtures), 2)
        for file in fixtures:
            event = json.loads(file.read_text())['events'][-1]
            with self.subTest(fixture=file.name):
                self.assertIs(event['stream'], True)
                self.assertIs(event['streamFinish'], False)
                self.assertTrue(planet.completed_ai(event))

    def test_unconfirmed_or_foreign_tool_metadata_is_not_completion(self):
        base = {'type': 'content', 'speaker': 'AI', 'content': 'oral promise',
                'stream': True, 'streamFinish': False}
        for meta in ({'toolReply': False, 'toolType': 'transfer', 'toolCode': 'transferCall'},
                     {'toolReply': True, 'toolType': 'transfer', 'toolCode': 'other'},
                     {'toolReply': True, 'toolType': 'other', 'toolCode': 'transferCall'}):
            self.assertFalse(planet.completed_ai({**base, 'promptToolReplyMeta': meta}))
        self.assertFalse(planet.completed_ai({**base, 'speaker': 'ME', 'promptToolReplyMeta':
                         {'toolReply': True, 'toolType': 'transfer', 'toolCode': 'transferCall'}}))


class PreparationTests(unittest.TestCase):
    def client(self, responses):
        client = object.__new__(planet.Planet)
        client.bind = Mock(return_value={'nlpType': 'EXTERNAL'})
        client.request = Mock(side_effect=responses)
        client.state = {'cookie': 'FAKE'}
        client.context = {'headers': {'x-bind-robot': '7_1000001'}}
        client.session = Mock()
        client.session.post.return_value = Response(200, {'code': 200, 'data': 123})
        return client

    def test_no_changes_uses_native_gate_without_post(self):
        client = self.client([False])
        result = client.prepare_dev(1000001)
        self.assertTrue(result['ready'])
        self.assertFalse(result['performed_sync'])
        client.session.post.assert_not_called()

    def test_inner_preparation_does_not_claim_classic_nls_success(self):
        client = self.client([None])
        client.bind.return_value = {'nlpType': 'INNER'}
        result = client.prepare_dev(1000001)
        self.assertTrue(result['preparation_request_completed'])
        self.assertTrue(result['retrieval_validation_required'])
        self.assertFalse(result['classic_nls_loading_success_claimed'])
        client.session.post.assert_not_called()
        self.assertIn('synKnowledge', client.request.call_args.args[0])

    @patch('planet.time.sleep')
    def test_multipart_sync_waits_for_loading_success(self, sleep):
        client = self.client([True, 0, 1, 2, False])
        result = client.prepare_dev(1000001)
        self.assertEqual(result['states'], [0, 1, 2])
        self.assertTrue(result['ready'])
        self.assertFalse(result['formal_publish'])
        self.assertEqual(sleep.call_count, 2)
        kwargs = client.session.post.call_args.kwargs
        self.assertEqual(kwargs['files'], {'robotDefId': (None, '1000001')})
        self.assertNotIn('json', kwargs)
        self.assertTrue(client.session.post.call_args.args[0].endswith('/knowledgeBase/publishTest'))

    def test_loading_failure_is_not_ready(self):
        client = self.client([True, 4])
        with self.assertRaisesRegex(planet.PlanetError, 'DEV_KNOWLEDGE_SYNC_FAILED'):
            client.prepare_dev(1000001)

    def test_unexpected_change_status_never_posts(self):
        client = self.client(['true'])
        with self.assertRaisesRegex(planet.PlanetError, 'UNEXPECTED_DEV_CHANGE_STATUS'):
            client.prepare_dev(1000001)
        client.session.post.assert_not_called()


class WriteTests(unittest.TestCase):
    def test_generated_tool_identity_changes_do_not_hide_behavior_changes(self):
        a = copy.deepcopy(CONFIG)
        a['functionCallConfig'] = [{'configId': 123, 'name': 'transfer', 'configJson': '{"enabled":1}'}]
        b = copy.deepcopy(a)
        b['functionCallConfig'][0]['configId'] = 456
        self.assertEqual(planet.prompt_fingerprint(a), planet.prompt_fingerprint(b))
        b['functionCallConfig'][0]['configJson'] = '{"enabled":0}'
        self.assertNotEqual(planet.prompt_fingerprint(a), planet.prompt_fingerprint(b))

    def test_plan_does_not_mutate_and_preserves_other_variant(self):
        client = FakeClient()
        plan = planet.make_prompt_plan(client, 1000001, 'edited')
        self.assertEqual(client.writes, [])
        self.assertEqual(client.current, CONFIG)
        self.assertEqual(plan['after']['promptList'][1], CONFIG['promptList'][1])


class TerminalSessionTests(unittest.IsolatedAsyncioTestCase):
    async def run_session(self, events, messages):
        def packet(value):
            return 'a' + json.dumps([planet.stomp_frame('MESSAGE', {}, json.dumps(value))])
        class Socket:
            def __init__(self):
                self.frames = ['o', 'a'+json.dumps([planet.stomp_frame('CONNECTED')])]
                self.frames += [packet({'type':'content','speaker':'AI','content':'opening','stream':False})]
                self.frames += [packet(e) for e in events]
                self.sent=[]
            async def __aenter__(self): return self
            async def __aexit__(self,*args): return False
            async def recv(self): return self.frames.pop(0)
            async def send(self,value): self.sent.append(value)
        socket=Socket()
        client=object.__new__(planet.Planet)
        client.bind=Mock(return_value={'companyId':1})
        client.context={'cos_origin':'https://test.cos.byai.com','headers':{}}
        client.state={'cookie':'FAKE'}
        with patch('planet.websockets.connect',return_value=socket), patch('planet.asyncio.sleep',new_callable=AsyncMock):
            return await planet.text_test(client,1000001,messages,{}),socket

    async def test_transfer_stops_before_unsent_followup(self):
        output,_=await self.run_session([
            {'type':'content','speaker':'ME','content':'refund'},
            {'type':'content','speaker':'AI','content':'transferring','stream':False,
             'promptToolReplyMeta':{'toolReply':True,'toolType':'transfer','toolCode':'transferCall'}}],['refund','followup'])
        self.assertEqual(output['terminal_action'],'transfer_tool_invoked')
        self.assertEqual(output['unexecuted_messages_after_terminal_action'],['followup'])
        self.assertEqual(len(output['turns']),1)

    async def test_verified_streaming_transfer_stops_without_final_chunk(self):
        output, socket = await self.run_session([
            {'type':'content','speaker':'ME','content':'refund'},
            {'type':'content','speaker':'AI','content':'actual tool reply',
             'stream':True,'streamFinish':False,
             'promptToolReplyMeta':{'toolReply':True,'toolType':'transfer','toolCode':'transferCall'}}],
            ['refund','must not be sent'])
        self.assertEqual(output['terminal_action'], 'transfer_tool_invoked')
        self.assertEqual(output['unexecuted_messages_after_terminal_action'], ['must not be sent'])
        self.assertEqual(output['turns'][0]['assistant'], 'actual tool reply')
        self.assertEqual(output['turns'][0]['completion_basis'], 'verified_transfer_tool_reply')
        self.assertEqual(len(output['turns']), 1)

    async def test_server_end_is_not_transfer_or_timeout(self):
        output,_=await self.run_session([
            {'type':'content','speaker':'ME','content':'first'},
            {'type':'content','speaker':'AI','content':'oral promise','stream':False},
            {'type':'hangup'}],['first','second'])
        self.assertEqual(output['terminal_action'],'server_ended_before_reply')
        self.assertEqual(output['sent_messages_without_reply'],['second'])
        self.assertEqual(len(output['turns']),1)
        self.assertFalse(any(e.get('promptToolReplyMeta') for e in output['events']))

    async def test_server_end_before_first_reply_retains_attempted_message(self):
        output,_=await self.run_session([{'type':'hangup'}],['first','second'])
        self.assertEqual(output['turns'],[])
        self.assertEqual(output['sent_messages_without_reply'],['first'])
        self.assertEqual(output['unexecuted_messages_after_terminal_action'],['second'])


class WriteMutationTests(unittest.TestCase):
    def test_forward_and_rollback_verify_exact_payload(self):
        client = FakeClient()
        plan = planet.make_prompt_plan(client, 1000001, 'edited')
        self.assertTrue(planet.apply_prompt_plan(client, plan)['readback_verified'])
        self.assertTrue(planet.apply_prompt_plan(client, plan, rollback=True)['rolled_back'])
        self.assertEqual(planet.fingerprint(client.current), planet.fingerprint(CONFIG))

    def test_stale_plan_never_writes(self):
        client = FakeClient()
        plan = planet.make_prompt_plan(client, 1000001, 'edited')
        client.current['promptList'][0]['prompt'] = 'concurrent user edit'
        with self.assertRaisesRegex(planet.PlanetError, 'STALE_PLAN'):
            planet.apply_prompt_plan(client, plan)
        self.assertEqual(client.writes, [])

    def test_modified_plan_is_rejected(self):
        client = FakeClient()
        plan = planet.make_prompt_plan(client, 1000001, 'edited')
        plan['after']['promptList'][0]['prompt'] = 'tampered'
        with self.assertRaisesRegex(planet.PlanetError, 'PLAN_INTEGRITY_FAILED'):
            planet.apply_prompt_plan(client, plan)
        self.assertEqual(client.writes, [])

    def test_prod_write_is_not_supported(self):
        client = FakeClient()
        plan = planet.make_prompt_plan(client, 1000001, 'edited')
        plan['environment'] = 'prod'
        with self.assertRaisesRegex(planet.PlanetError, 'ONLY_DEV'):
            planet.apply_prompt_plan(client, plan)
        self.assertEqual(client.writes, [])


if __name__ == '__main__': unittest.main()
