#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""BOTID-first HTTP / SockJS-STOMP client for the observed Shanghai Planet API."""
import argparse
import asyncio
from collections import Counter
import hashlib
from http.cookies import SimpleCookie
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time
from urllib.parse import urlencode, urlsplit
import uuid

import requests
import websockets

ORIGIN = 'https://sh.planet.byai.com'
STATE = Path.home() / '.local/share/byai-planet-cli'
ANCHORS = 'base,llm,prompt,asr,tts,dialogueVariable,functionCall,dialogueContext'


class PlanetError(Exception):
    pass


class ServerSessionEnded(PlanetError):
    pass


def save_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(value, ensure_ascii=False, indent=2)
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        os.fchmod(handle.fileno(), 0o600)
        handle.write(data + '\n')


def fingerprint(value):
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(raw.encode()).hexdigest()


def prompt_payload(config):
    keys = ['robotDefId', 'sceneDefId', 'sceneNodeId', 'abEnabled', 'globalPromptSwitch',
            'firstAiWord', 'firstNodeEnableVad', 'functionCallConfig']
    payload = {key: config[key] for key in keys}
    payload['promptList'] = [{key: item[key] for key in ('prompt', 'sortIndex', 'ratio')}
                             for item in config['promptList']]
    return payload


def prompt_fingerprint(payload):
    semantic = json.loads(json.dumps(payload))
    # The observed gpt/update endpoint recreates tool rows on every save.
    # configId alone is a generated storage identity, not tool behavior.
    for tool in semantic.get('functionCallConfig', []):
        tool.pop('configId', None)
    return fingerprint(semantic)


def make_prompt_plan(client, bot_id, text, node_id=None, variant=1):
    client.bind(bot_id, 'dev')
    nodes = [n for n in client.nodes('dev') if int(n.get('sceneFlowType') or 0) == 2]
    if node_id is None:
        if len(nodes) != 1:
            raise PlanetError('SELECT_NODE: this BOT has multiple Prompt flows')
        node_id = nodes[0]['sceneNodeId']
    if not any(int(n['sceneNodeId']) == int(node_id) for n in nodes):
        raise PlanetError('NODE_NOT_IN_BOT')
    before = prompt_payload(client.prompt(node_id, 'dev'))
    after = json.loads(json.dumps(before))
    target = [p for p in after['promptList'] if int(p['sortIndex']) == variant]
    if len(target) != 1:
        raise PlanetError('PROMPT_VARIANT_NOT_FOUND')
    target[0]['prompt'] = text
    return {'kind': 'dev-prompt-change-v2', 'bot_id': int(bot_id), 'environment': 'dev',
            'node_id': int(node_id), 'variant': variant, 'before': before, 'after': after,
            'before_sha256': prompt_fingerprint(before), 'after_sha256': prompt_fingerprint(after)}


def apply_prompt_plan(client, plan, rollback=False):
    if plan.get('kind') != 'dev-prompt-change-v2' or plan.get('environment') != 'dev':
        raise PlanetError('ONLY_DEV_PROMPT_PLANS_SUPPORTED')
    for key in ('before', 'after'):
        if prompt_fingerprint(plan[key]) != plan[key + '_sha256']:
            raise PlanetError('PLAN_INTEGRITY_FAILED')
        if int(plan[key]['robotDefId']) != int(plan['bot_id']) or int(plan[key]['sceneNodeId']) != int(plan['node_id']):
            raise PlanetError('PLAN_TARGET_MISMATCH')
    expected, target = ('after', 'before') if rollback else ('before', 'after')
    client.bind(plan['bot_id'], 'dev')
    nodes = client.nodes('dev')
    if not any(int(n['sceneNodeId']) == plan['node_id'] for n in nodes):
        raise PlanetError('NODE_NOT_IN_BOT')
    current = prompt_payload(client.prompt(plan['node_id'], 'dev'))
    if prompt_fingerprint(current) != plan[expected + '_sha256']:
        raise PlanetError('STALE_PLAN: current configuration changed; no write performed')
    payload = json.loads(json.dumps(plan[target]))
    payload['functionCallConfig'] = current['functionCallConfig']
    client.request('/decision/api/gpt/update', payload=payload, method='POST')
    actual = prompt_payload(client.prompt(plan['node_id'], 'dev'))
    if prompt_fingerprint(actual) != plan[target + '_sha256']:
        raise PlanetError('WRITE_READBACK_MISMATCH: inspect current config and saved plan')
    return {'bot_id': plan['bot_id'], 'environment': 'dev', 'node_id': plan['node_id'],
            'rolled_back': rollback, 'readback_verified': True, 'sha256': prompt_fingerprint(actual),
            'generated_tool_ids_changed': [x.get('configId') for x in current['functionCallConfig']]
                != [x.get('configId') for x in actual['functionCallConfig']]}


def decode_response(response):
    if response.status_code in (301, 302, 303, 307, 308, 401, 403):
        raise PlanetError('AUTH_REQUIRED: login session expired or access denied')
    if response.status_code != 200:
        raise PlanetError('HTTP_ERROR: status=' + str(response.status_code))
    try:
        body = response.json()
    except ValueError:
        raise PlanetError('INVALID_RESPONSE: expected JSON, possibly login required')
    if body.get('success') is False or str(body.get('code')) != '200':
        code = str(body.get('code'))
        message = str(body.get('resultMsg') or body.get('message') or 'request failed')
        # Never include stack traces, URLs or server authentication values.
        if any(word in message.lower() for word in ('token', 'cookie', 'http:', 'https:')):
            message = 'request rejected'
        raise PlanetError('API_ERROR: code=' + code + '; ' + message[:150])
    return body.get('data')


class Planet:
    def __init__(self, state_dir=STATE):
        self.state_dir = Path(state_dir)
        file = self.state_dir / 'session.json'
        if not file.exists():
            raise PlanetError('AUTH_REQUIRED: run auth login once')
        if file.stat().st_mode & 0o077:
            raise PlanetError('INSECURE_SESSION_FILE: chmod 600 ' + str(file))
        self.state = json.loads(file.read_text())
        if self.state.get('origin') != ORIGIN or not self.state.get('cookie'):
            raise PlanetError('INVALID_SESSION_FILE')
        self.session = requests.Session()
        self.context = None

    def request(self, path, params=None, payload=None, method='GET', bound=True):
        headers = {'Accept': 'application/json', 'Cookie': self.state['cookie']}
        if bound:
            if not self.context:
                raise PlanetError('BOT_CONTEXT_REQUIRED')
            headers.update(self.context['headers'])
        response = self.session.request(method, ORIGIN + '/bygw' + path, params=params,
                                        json=payload, headers=headers, timeout=45,
                                        allow_redirects=False)
        return decode_response(response)

    def identity(self, bot_id):
        data = self.request('/api/boss/robot/info', {'robotDefId': int(bot_id)}, bound=False)
        if int(data.get('robotDefId', 0)) != int(bot_id):
            raise PlanetError('BOT_ID_MISMATCH')
        return data

    def prepare_dev(self, bot_id, timeout=600, strategy='auto'):
        """Replay observed test preparation; INNER sync and classic NLS differ.

        Completion of a sync request is not evidence that every FAQ is indexed.
        Retrieval probes and a full FAQ regression must verify that separately.
        """
        robot = self.bind(bot_id, 'dev')
        if strategy == 'auto' and robot.get('nlpType') == 'INNER':
            data = self.request('/decision/api/robot/test/synKnowledge', {'robotDefId': int(bot_id)})
            if data is False:
                raise PlanetError('INNER_TEST_SYNC_REJECTED')
            return {'bot_id': int(bot_id), 'environment': 'dev', 'formal_publish': False,
                    'strategy': 'native INNER synKnowledge before SockJS text test',
                    'preparation_request_completed': True, 'response_data': data,
                    'retrieval_validation_required': True,
                    'classic_nls_loading_success_claimed': False}
        changed = self.request('/decision/api/robot/getSingleChangeStatus', {'robotDefId': int(bot_id)})
        if not isinstance(changed, bool):
            raise PlanetError('UNEXPECTED_DEV_CHANGE_STATUS')
        receipt = {'bot_id': int(bot_id), 'environment': 'dev', 'change_before': changed,
                   'performed_sync': False, 'formal_publish': False, 'states': []}
        if not changed:
            receipt.update(ready=True, ready_basis='native change gate reports no pending changes')
            return receipt
        response = self.session.post(ORIGIN + '/bygw/decision/api/knowledgeBase/publishTest',
            files={'robotDefId': (None, str(bot_id))},
            headers={'Accept': 'application/json', 'Cookie': self.state['cookie'], **self.context['headers']},
            timeout=45, allow_redirects=False)
        app_id = decode_response(response)
        if isinstance(app_id, bool) or not isinstance(app_id, (int, str)) or not app_id:
            raise PlanetError('UNEXPECTED_DEV_SYNC_JOB')
        receipt.update(performed_sync=True, nls_app_id=app_id)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            state = self.request('/decision/api/knowledgeBase/getSingleOnlineStatus', {'nlsAppId': app_id})
            receipt['states'].append(state)
            if state == 2:
                receipt.update(ready=True, ready_basis='native loading-success status=2',
                    change_after=self.request('/decision/api/robot/getSingleChangeStatus', {'robotDefId': int(bot_id)}))
                return receipt
            if state not in (0, 1):
                error = PlanetError('DEV_KNOWLEDGE_SYNC_FAILED: state=' + str(state))
                error.preparation_receipt = {**receipt, 'ready': False}
                raise error
            time.sleep(20)
        error = PlanetError('DEV_KNOWLEDGE_SYNC_TIMEOUT')
        error.preparation_receipt = {**receipt, 'ready': False}
        raise error

    def bind(self, bot_id, environment='dev'):
        """Replay the observed BOT page bootstrap; all routing context is derived."""
        robot = self.identity(bot_id)
        profile = self.request('/apiUser/common/user/userrole', bound=False)
        host = self.request('/apiUser/common/user/company/url',
                            {'companyId': robot['companyId']}, bound=False)
        # The host comes from the authenticated BOT lookup, never a caller URL.
        if not isinstance(host, str) or not re.fullmatch(r'[a-zA-Z0-9-]+\.cos\.byai\.com', host):
            raise PlanetError('UNEXPECTED_BOT_SERVICE_HOST')
        cos_origin = 'https://' + host
        query = {'agentScope': 'AGENT', 'entrySource': 'planet-tenant',
                 'planetCompanyId': robot['companyId'], 'currentPlatform': 'BYXQ',
                 'currentRobotDefId': int(bot_id), 'currentUserId': profile['id'],
                 'mobile': profile['mobile'], 'singlespa': 'false', 'hidelayout': 'true'}
        url = cos_origin + '/voice-bot/bot-gui/' + str(bot_id) + '/agent/' + environment
        response = self.session.get(url, params=query,
                                     headers={'Cookie': self.state['cookie']},
                                     timeout=45, allow_redirects=False)
        if response.status_code != 200:
            raise PlanetError('BOT_BOOTSTRAP_FAILED: status=' + str(response.status_code))
        match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', response.text, re.S)
        if not match:
            raise PlanetError('BOT_BOOTSTRAP_FAILED: missing page context')
        info = json.loads(match.group(1)).get('props', {}).get('globalInfo', {})
        headers = info.get('botEditorRequestHeader') or {}
        if headers.get('x-bind-robot') != '7_' + str(bot_id) or not headers.get('x-bind-token'):
            raise PlanetError('BOT_BOOTSTRAP_FAILED: missing or mismatched BOT binding')
        self.context = {'bot_id': int(bot_id), 'robot': robot, 'headers': headers,
                        'cos_origin': cos_origin,
                        'user': {key: profile.get(key) for key in ('id', 'mobile', 'realName')}}
        return robot

    def global_config(self, environment):
        return self.request('/decision/api/agent/info', {
            'robotDefId': self.context['bot_id'], 'environment': environment, 'anchors': ANCHORS})

    def nodes(self, environment):
        return self.request('/decision/api/sceneNode/list', {
            'sceneDefId': self.context['robot']['sceneDefId'], 'environment': environment})

    def prompt(self, node_id, environment):
        return self.request('/decision/api/gpt/detail', {
            'robotDefId': self.context['bot_id'], 'sceneDefId': self.context['robot']['sceneDefId'],
            'sceneNodeId': node_id, 'environment': environment.upper()})

    def export(self, bot_id, output, environment='dev'):
        robot = self.bind(bot_id, environment)
        global_config = self.global_config(environment)
        nodes = self.nodes(environment)
        prompts = []
        unsupported = []
        for node in nodes:
            if int(node.get('sceneFlowType') or 0) == 2:
                prompts.append({'node': node, 'config': self.prompt(node['sceneNodeId'], environment)})
            else:
                unsupported.append({'sceneNodeId': node['sceneNodeId'], 'reason': 'non-Prompt flow'})
        tree = self.request('/decision/api/datacenter/knowledge/statistics', {
            'robotDefId': int(bot_id), 'sceneDefId': robot['sceneDefId'],
            'environment': environment, 'categoryIds': '1,2,3'})
        faq = self.request('/decision/api/knowledgeBase/list', {
            'robotDefId': int(bot_id), 'environment': environment,
            'categoryIds': '1,2,3', 'knowledgeGroupId': tree['id']})
        if not isinstance(faq, list) or len(faq) != int(tree['count']):
            raise PlanetError('KNOWLEDGE_COUNT_MISMATCH: export not accepted')
        if len(set(str(x['knowledgeBaseId']) for x in faq)) != len(faq):
            raise PlanetError('DUPLICATE_KNOWLEDGE_IDS')
        extras = {}
        for key, path, params in (
                ('variables', '/decision/api/scene/variable/list',
                 {'sceneDefId': robot['sceneDefId'], 'robotDefId': int(bot_id), 'environment': environment}),
                ('postCallSms', '/decision/api/robot/getPostCallSmsConfig',
                 {'robotDefId': int(bot_id), 'environment': environment}),
                ('interfaceQuery', '/decision/api/robot/getInterfaceQueryConfig',
                 {'robotDefId': int(bot_id), 'environment': environment}),
                ('dialogueContext', '/decision/api/crm/botlab/entity/listForRobotDefId',
                 {'robotDefId': int(bot_id), 'environment': environment})):
            try:
                extras[key] = {'status': 'read', 'data': self.request(path, params)}
            except PlanetError as exc:
                extras[key] = {'status': 'unresolved', 'error': str(exc)}
        snapshot = {'bot_id': int(bot_id), 'environment': environment, 'robot': robot,
                    'global_config': global_config, 'nodes': nodes, 'flow_prompts': prompts,
                    'knowledge_tree': tree, 'knowledge': faq, 'extras': extras,
                    'unsupported_flows': unsupported,
                    'source': {'api_origin': ORIGIN, 'captured_at_epoch': int(time.time())}}
        output = Path(output)
        output.mkdir(parents=True, exist_ok=True)
        output.chmod(0o700)
        save_json(output / 'snapshot.json', snapshot)
        save_json(output / 'knowledge.json', faq)
        save_json(output / 'global-config.json', global_config)
        for item in prompts:
            node_id = item['node']['sceneNodeId']
            save_json(output / ('flow-' + str(node_id) + '.json'), item)
            for prompt in item['config'].get('promptList', []):
                file = output / ('flow-' + str(node_id) + '-prompt-' + str(prompt['sortIndex']) + '.txt')
                file.write_text(prompt.get('prompt') or '')
                file.chmod(0o600)
        for prompt in global_config.get('prompt', {}).get('list', []):
            file = output / ('global-prompt-' + str(prompt['sortIndex']) + '.txt')
            file.write_text(prompt.get('prompt') or '')
            file.chmod(0o600)
        entities = extras.get('dialogueContext', {}).get('data')
        entity_counts = ({'builtin': sum(x.get('id') is None for x in entities),
                          'custom': sum(x.get('id') is not None for x in entities)}
                         if isinstance(entities, list) else None)
        manifest = {'bot_id': int(bot_id), 'environment': environment,
                    'flow_count': len(nodes), 'prompt_flow_count': len(prompts),
                    'faq_count': len(faq),
                    'similar_question_count': sum(len(x.get('similarQuestionList') or []) for x in faq),
                    'answer_count': sum(len(x.get('knowledgeBaseAnswerList') or []) for x in faq),
                    'global_sections': sorted(global_config),
                    'dialogue_context_entity_counts': entity_counts, 'extras':
                    {k: v['status'] for k, v in extras.items()}, 'unsupported_flows': unsupported,
                    'snapshot_sha256': fingerprint(snapshot)}
        save_json(output / 'manifest.json', manifest)
        return manifest


def stomp_frame(command, headers=None, body=''):
    return command + '\n' + '\n'.join(k + ':' + str(v) for k, v in (headers or {}).items()) + '\n\n' + body + '\x00'


def parse_sockjs(raw):
    if raw in ('o', 'h'):
        return []
    if raw.startswith('c'):
        raise PlanetError('SOCKJS_CLOSED')
    packets = json.loads(raw[1:]) if raw.startswith('a') else [raw]
    frames = []
    for packet in packets:
        for part in packet.split('\x00'):
            part = part.lstrip('\n')
            if not part:
                continue
            head, _, body = part.partition('\n\n')
            lines = head.split('\n')
            headers = dict(line.split(':', 1) for line in lines[1:] if ':' in line)
            frames.append((lines[0], headers, body))
    return frames


def verified_terminal_transfer(event):
    meta = event.get('promptToolReplyMeta') or {}
    return (event.get('type') == 'content' and event.get('speaker') == 'AI'
            and bool(event.get('content')) and meta.get('toolReply') is True
            and meta.get('toolType') == 'transfer' and meta.get('toolCode') == 'transferCall')


def completed_ai(event):
    return (event.get('type') == 'content' and event.get('speaker') == 'AI'
            and bool(event.get('content'))
            and (event.get('streamFinish') is True or event.get('stream') is False
                 or verified_terminal_transfer(event)))


async def text_test(client, bot_id, messages, variables, environment='dev', timeout=60, settle_time=0):
    if environment != 'dev':
        raise PlanetError('TEXT_TEST_ENVIRONMENT_NOT_VERIFIED: currently supports dev only')
    robot = client.bind(bot_id, environment)
    context = client.context
    transport_id = uuid.uuid4().hex
    debug_id = str(uuid.uuid4())
    unique_id = 'CALL_SCRIPT_' + uuid.uuid4().hex
    origin = context['cos_origin']
    url = origin.replace('https:', 'wss:') + '/ws/endpoint/000/' + transport_id + '/websocket'
    all_events = []
    ignored_foreign = 0
    output = {'bot_id': int(bot_id), 'environment': environment, 'debug_session_id': debug_id,
              'unique_id': unique_id, 'turns': [], 'opening': None, 'cleanly_stopped': False,
              'events': all_events}
    async with websockets.connect(url, origin=origin, proxy=None,
                                  additional_headers={'Cookie': client.state['cookie'], **context['headers']},
                                  open_timeout=20, max_size=8 * 1024 * 1024) as socket:
        async def send(command, headers=None, body=''):
            await socket.send(json.dumps([stomp_frame(command, headers, body)]))

        async def receive_events():
            nonlocal ignored_foreign
            raw = await asyncio.wait_for(socket.recv(), timeout)
            events = []
            for command, headers, body in parse_sockjs(raw):
                if command == 'ERROR':
                    raise PlanetError('STOMP_ERROR: server rejected the test session')
                if command != 'MESSAGE':
                    continue
                event = json.loads(body)
                if event.get('debugSessionId') not in (None, debug_id):
                    ignored_foreign += 1
                    continue
                events.append(event)
                all_events.append(event)
            return events

        async def collect_turn(user_text=None):
            started = time.monotonic()
            seen_user = user_text is None
            while time.monotonic() - started < timeout:
                for event in await receive_events():
                    if event.get('type') in ('hangup', 'hangupResult'):
                        raise ServerSessionEnded('SERVER_SESSION_ENDED_BEFORE_REPLY')
                    if event.get('type') == 'content' and event.get('speaker') == 'ME' and event.get('content') == user_text:
                        seen_user = True
                    if seen_user and completed_ai(event):
                        turn = {'user': user_text, 'assistant': event['content'], 'complete': True,
                                'elapsed_ms': round((time.monotonic() - started) * 1000),
                                'stream_instance_id': event.get('streamInstanceId'),
                                'dialogue_index': event.get('dialogueIndex'),
                                'sentence_id': event.get('sentenceId')}
                        if verified_terminal_transfer(event):
                            # The server can issue a completed transfer tool result while
                            # leaving streamFinish false. The real receipt is terminal;
                            # an oral promise or an unconfirmed tool request is not.
                            turn['completion_basis'] = 'verified_transfer_tool_reply'
                        return turn
            raise PlanetError('TEXT_REPLY_TIMEOUT: no completed AI reply')

        raw = await asyncio.wait_for(socket.recv(), 20)
        if raw != 'o':
            raise PlanetError('SOCKJS_OPEN_FAILED')
        await send('CONNECT', {'accept-version': '1.1,1.2', 'heart-beat': '10000,10000', 'login': '', 'passcode': ''})
        frames = parse_sockjs(await asyncio.wait_for(socket.recv(), 20))
        if not any(command == 'CONNECTED' for command, _, _ in frames):
            raise PlanetError('STOMP_CONNECT_FAILED')
        await send('SUBSCRIBE', {'id': 'cli0', 'destination':
                   '/ws/user/DEBUG_SESSION_' + debug_id + '/queue/response/chatbot', 'ack': 'auto'})
        await asyncio.sleep(0.3)
        base = {'debugSessionId': debug_id, 'uniqueId': unique_id}
        async def event_send(value):
            await send('SEND', {'destination': '/ws/chatbot', 'content-type': 'application/json'},
                       json.dumps({**base, **value}, ensure_ascii=False))
        try:
            await event_send({'type': 'start', 'isProd': False, 'robotDefId': int(bot_id),
                              'companyId': robot['companyId'], 'userName': '', 'properties': variables})
            output['opening'] = await collect_turn()
            for message_index, message in enumerate(messages):
                if not message.strip():
                    raise PlanetError('EMPTY_TEST_MESSAGE')
                await event_send({'type': 'ChatMsg', 'text': message.strip()})
                event_start = len(all_events)
                try:
                    output['turns'].append(await collect_turn(message.strip()))
                except ServerSessionEnded:
                    output['terminal_action'] = 'server_ended_before_reply'
                    output['sent_messages_without_reply'] = [message]
                    output['unexecuted_messages_after_terminal_action'] = messages[message_index+1:]
                    break
                if settle_time:
                    # Diagnostic observation window for post-utterance actions.
                    # Preserve events without treating a spoken promise as a tool.
                    deadline = time.monotonic() + settle_time
                    while time.monotonic() < deadline:
                        try:
                            tail = await asyncio.wait_for(receive_events(), deadline-time.monotonic())
                        except asyncio.TimeoutError:
                            break
                        if any(e.get('type') in ('hangup','hangupResult') for e in tail):
                            break
                if any(verified_terminal_transfer(e) for e in all_events[event_start:]):
                    output['terminal_action'] = 'transfer_tool_invoked'
                    output['unexecuted_messages_after_terminal_action'] = messages[len(output['turns']):]
                    break
                if any(e.get('type') in ('hangup', 'hangupResult') for e in all_events[event_start:]):
                    output['terminal_action'] = 'server_ended_after_reply'
                    output['unexecuted_messages_after_terminal_action'] = messages[message_index+1:]
                    break
        except Exception as exc:
            exc.partial_output = output
            raise
        finally:
            await event_send({'type': 'stop', 'isProd': False, 'robotDefId': int(bot_id)})
            await send('UNSUBSCRIBE', {'id': 'cli0'})
            await send('DISCONNECT')
            output['cleanly_stopped'] = True
    output['ignored_foreign_events'] = ignored_foreign
    output['post_reply_observation_seconds'] = settle_time
    output['events'] = all_events
    return output


async def login(state_dir, timeout):
    """One user login in a dedicated Chrome profile, then HTTP-only session reuse."""
    root = Path(state_dir)
    root.mkdir(parents=True, exist_ok=True)
    root.chmod(0o700)
    chrome = next((x for x in ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                             shutil.which('google-chrome'), shutil.which('chromium')]
                   if x and Path(x).exists()), None)
    if not chrome:
        raise PlanetError('CHROME_NOT_FOUND')
    profile = root / 'login-browser'
    profile.mkdir(exist_ok=True)
    profile.chmod(0o700)
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
    process = subprocess.Popen([chrome, '--user-data-dir=' + str(profile),
        '--remote-debugging-port=' + str(port), '--remote-debugging-address=127.0.0.1',
        '--no-first-run', '--no-default-browser-check', ORIGIN],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print('请在新打开的星球窗口完成登录；完成后会自动保存会话。', file=sys.stderr)
    deadline = time.monotonic() + timeout
    channel = None
    try:
        while time.monotonic() < deadline:
            try:
                version = requests.get('http://127.0.0.1:' + str(port) + '/json/version', timeout=2).json()
                channel = await websockets.connect(version['webSocketDebuggerUrl'], proxy=None, open_timeout=3)
                break
            except (requests.RequestException, OSError, ValueError):
                await asyncio.sleep(1)
        if channel is None:
            raise PlanetError('LOGIN_BROWSER_UNAVAILABLE')
        request_id = 0
        while time.monotonic() < deadline:
            request_id += 1
            await channel.send(json.dumps({'id': request_id, 'method': 'Storage.getCookies'}))
            while True:
                response = json.loads(await asyncio.wait_for(channel.recv(), 5))
                if response.get('id') == request_id:
                    break
            cookies = response.get('result', {}).get('cookies', [])
            pairs = [c['name'] + '=' + c['value'] for c in cookies
                     if 'sh.planet.byai.com'.endswith(c['domain'].lstrip('.')) and c.get('path', '/') == '/']
            cookie = '; '.join(pairs)
            if cookie:
                try:
                    result = requests.get(ORIGIN + '/bygw/apiUser/common/user/userrole',
                        headers={'Cookie': cookie}, timeout=8, allow_redirects=False)
                    user = decode_response(result)
                    if user and user.get('id'):
                        save_json(root / 'session.json', {'origin': ORIGIN, 'cookie': cookie})
                        return {'authenticated': True, 'session_saved': True}
                except (requests.RequestException, PlanetError):
                    pass
            await asyncio.sleep(2)
        raise PlanetError('LOGIN_TIMEOUT')
    finally:
        if channel:
            try:
                await channel.send(json.dumps({'id': 999999, 'method': 'Browser.close'}))
                await channel.close()
            except Exception:
                pass
        if process.poll() is None:
            process.terminate()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', default=str(STATE), help='private authentication state directory')
    sub = parser.add_subparsers(dest='command', required=True)
    auth = sub.add_parser('auth')
    auth.add_argument('action', choices=['login', 'status'])
    auth.add_argument('--timeout', type=int, default=180)
    export = sub.add_parser('export', help='export BOT configuration and knowledge')
    export.add_argument('bot_id', type=int)
    export.add_argument('--environment', choices=['dev', 'prod'], default='dev')
    export.add_argument('--out', required=True)
    prepare = sub.add_parser('prepare', help='synchronize dev test knowledge and wait until ready')
    prepare.add_argument('bot_id', type=int)
    prepare.add_argument('--out', required=True)
    prepare.add_argument('--strategy', choices=['auto', 'classic'], default='auto')
    test = sub.add_parser('test', help='run an isolated multiround text test')
    test.add_argument('bot_id', type=int)
    test.add_argument('--text', action='append', default=[])
    test.add_argument('--messages-file', help='JSON array of user messages')
    test.add_argument('--variables', default='{}', help='JSON object, e.g. {"queue_count":"0"}')
    test.add_argument('--timeout', type=int, default=60)
    test.add_argument('--out', required=True)
    plan = sub.add_parser('prompt-plan', help='prepare a reversible dev Prompt change; does not write')
    plan.add_argument('bot_id', type=int)
    plan.add_argument('--file', required=True)
    plan.add_argument('--node-id', type=int)
    plan.add_argument('--variant', type=int, default=1)
    plan.add_argument('--out', required=True)
    apply = sub.add_parser('prompt-apply', help='apply or roll back a saved dev-only plan')
    apply.add_argument('--plan', required=True)
    apply.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    try:
        if args.command == 'auth' and args.action == 'login':
            result = asyncio.run(login(args.state_dir, args.timeout))
        else:
            client = Planet(args.state_dir)
            if args.command == 'auth':
                data = client.request('/apiUser/common/user/userrole', bound=False)
                result = {'authenticated': bool(data and data.get('id'))}
            elif args.command == 'export':
                result = client.export(args.bot_id, args.out, args.environment)
            elif args.command == 'prepare':
                result = client.prepare_dev(args.bot_id, strategy=args.strategy)
                save_json(args.out, result)
            elif args.command == 'prompt-plan':
                plan = make_prompt_plan(client, args.bot_id, Path(args.file).read_text(), args.node_id, args.variant)
                save_json(args.out, plan)
                result = {k: v for k, v in plan.items() if k not in ('before', 'after')}
            elif args.command == 'prompt-apply':
                result = apply_prompt_plan(client, json.loads(Path(args.plan).read_text()), args.rollback)
            else:
                messages = json.loads(Path(args.messages_file).read_text()) if args.messages_file else args.text
                variables = json.loads(args.variables)
                if not isinstance(messages, list) or not messages or not all(isinstance(m, str) for m in messages):
                    raise PlanetError('INVALID_MESSAGES: expected a nonempty JSON array of strings')
                if not isinstance(variables, dict):
                    raise PlanetError('INVALID_VARIABLES: expected a JSON object')
                preparation = client.prepare_dev(args.bot_id)
                result = asyncio.run(text_test(client, args.bot_id, messages, variables, timeout=args.timeout))
                result['preparation'] = preparation
                save_json(args.out, result)
                result = {k: v for k, v in result.items() if k != 'events'}
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except PlanetError as exc:
        if getattr(args, 'out', None) and hasattr(exc, 'partial_output'):
            save_json(args.out + '.partial.json', exc.partial_output)
        if getattr(args, 'out', None) and hasattr(exc, 'preparation_receipt'):
            save_json(args.out, {'ok': False, 'error': str(exc), 'preparation': exc.preparation_receipt})
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(2)
    except (requests.RequestException, OSError, asyncio.TimeoutError, websockets.WebSocketException) as exc:
        if getattr(args, 'out', None) and hasattr(exc, 'partial_output'):
            save_json(args.out + '.partial.json', exc.partial_output)
        print(json.dumps({'ok': False, 'error': 'TRANSPORT_ERROR', 'type': type(exc).__name__}), file=sys.stderr)
        sys.exit(3)


if __name__ == '__main__':
    main()
