'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const packageJson = require('../package.json');
const { AcpHostClient } = require('../src/host/acp-client');

test('ACP dictation transport sends only Agent/operation authority and never a Provider secret', async () => {
  const received = [];
  let child;
  const client = new AcpHostClient({
    command: '/fake/host',
    env: { ...process.env, AGENTMESH360_HOST_MODE: 'embedded' },
    requestTimeoutMs: 500,
    spawnImpl: () => {
      child = fakeChild((request) => {
        received.push(request);
        if (request.method === 'initialize') return { capabilities: {} };
        if (request.method.endsWith('/status')) {
          return { result: hostSnapshot({ revision: 1, phase: 'idle', dictationId: null }) };
        }
        if (request.method.endsWith('/start')) {
          return { result: hostSnapshot({ revision: 2, phase: 'listening' }) };
        }
        if (request.method.endsWith('/stop')) {
          return { result: hostSnapshot({ revision: 3, phase: 'transcribing' }) };
        }
        if (request.method.endsWith('/cancel')) {
          return { result: hostSnapshot({ revision: 4, phase: 'idle', dictationId: null }) };
        }
        return { result: null };
      });
      return child;
    },
  });

  await client.getDictationStatus('job-agent');
  await client.startDictation({ agentId: 'job-agent', disclosureAccepted: true });
  await client.stopDictation('dict_test');
  await client.cancelDictation('dict_test');

  assert.deepEqual(
    received.slice(1).map(({ method, params }) => ({ method, params })),
    [
      {
        method: '_x.agentmesh360/dictation/status',
        params: { agentId: 'job-agent' },
      },
      {
        method: '_x.agentmesh360/dictation/start',
        params: { agentId: 'job-agent', disclosureAccepted: true },
      },
      {
        method: '_x.agentmesh360/dictation/stop',
        params: { dictationId: 'dict_test' },
      },
      {
        method: '_x.agentmesh360/dictation/cancel',
        params: { dictationId: 'dict_test' },
      },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(received),
    /api.?key|authorization|bearer|credential|secret/i,
  );

  const notification = once(client, 'notification');
  child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    method: 'x.agentmesh360/dictation/changed',
    params: hostSnapshot({ revision: 5, phase: 'complete', transcript: '草稿文字' }),
  })}\n`);
  const [message] = await notification;
  assert.equal(message.method, 'x.agentmesh360/dictation/changed');
  assert.equal(message.params.transcript, '草稿文字');

  const beforeInvalid = received.length;
  await assert.rejects(
    client.startDictation({ agentId: 'job-agent', disclosureAccepted: false }),
    /请先确认录音会交给所选听写服务进行转写/u,
  );
  await assert.rejects(client.stopDictation('bad\u0000id'), /听写 ID 无效/u);
  assert.equal(received.length, beforeInvalid);
  await client.stop();
});

test('macOS package declares a microphone purpose string scoped to explicit dictation', () => {
  assert.equal(
    packageJson.build.mac.extendInfo.NSMicrophoneUsageDescription,
    'AgentMesh360 仅在你主动开启听写时使用麦克风，将语音转换为可编辑文字。',
  );
});

function fakeChild(handler) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.stdin = {
    writable: true,
    write(line) {
      const request = JSON.parse(line);
      queueMicrotask(() => {
        Promise.resolve(handler(request)).then((result) => {
          child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
        });
      });
      return true;
    },
  };
  child.kill = () => {
    child.killed = true;
    child.emit('exit', 0);
  };
  return child;
}

function hostSnapshot(overrides = {}) {
  return {
    revision: 1,
    phase: 'listening',
    dictationId: 'dict_test',
    agentId: 'job-agent',
    interimText: '',
    transcript: '',
    error: null,
    service: {
      providerProfileId: 'profile-xai',
      displayName: 'xAI',
    },
    limits: {
      maxDurationSeconds: 60,
      maxAudioBytes: 1_920_000,
    },
    disclosure: '录音会发送给你选择的听写服务进行转写；听写结果不会自动发送。',
    ...overrides,
  };
}
