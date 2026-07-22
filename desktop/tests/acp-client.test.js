'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { AcpHostClient, resolveHostCommand } = require('../src/host/acp-client');

test('ACP client initializes the Host and unwraps AgentMesh360 extension responses', async () => {
  const received = [];
  const spawnImpl = () => fakeChild((request) => {
    received.push(request);
    if (request.method === 'initialize') return { capabilities: {} };
    if (request.method === '_x.agentmesh360/account/bootstrap') {
      return { result: { schemaVersion: 1, account: { id: 7 }, access: { canEnterClient: true } } };
    }
    if (request.method === '_x.agentmesh360/agents/list') {
      return { result: { agents: [{ agentId: 'job-agent' }] } };
    }
    return { result: null, error: 'unsupported' };
  });
  const client = new AcpHostClient({ command: '/fake/host', spawnImpl, requestTimeoutMs: 500 });

  const bootstrap = await client.bootstrap('access-token-private');
  const list = await client.listAgents();

  assert.equal(bootstrap.account.id, 7);
  assert.equal(list.agents[0].agentId, 'job-agent');
  assert.equal(received[0].method, 'initialize');
  assert.equal(received[0].params._meta.clientIdentifier, 'agentmesh360-desktop');
  assert.equal(received[1].method, '_x.agentmesh360/account/bootstrap');
  assert.deepEqual(received[1].params, { accessToken: 'access-token-private' });
  await client.stop();
});

test('Host command resolution prefers explicit and packaged binaries', () => {
  assert.equal(resolveHostCommand({ env: { AGENTMESH360_HOST_BIN: '/custom/host' } }).command, '/custom/host');
  const fallback = resolveHostCommand({ env: {}, resourcesPath: '/definitely/missing' });
  assert.ok(['grok', '/Users/ferdinandji/AgentMesh360-Client/target/release/xai-grok-pager', '/Users/ferdinandji/AgentMesh360-Client/target/debug/xai-grok-pager'].includes(fallback.command));
  assert.deepEqual(fallback.args, ['agent', '--no-leader', 'stdio']);
});

test('Provider management uses write-only AgentMesh360 Host extensions', async () => {
  const received = [];
  const profile = {
    presetId: 'openai',
    displayName: 'Personal OpenAI',
    protocol: 'openai_responses',
    baseUrl: 'https://api.openai.com/v1',
    authKind: 'bearer_api_key',
    enabledModels: ['model-main'],
  };
  const spawnImpl = () => fakeChild((request) => {
    received.push(request);
    if (request.method === 'initialize') return { capabilities: {} };
    if (request.method === '_x.agentmesh360/providers/list') {
      return { result: { profiles: [] } };
    }
    if (request.method === '_x.agentmesh360/providers/delete') {
      return { result: { deleted: true } };
    }
    return { result: { profile: { profileId: 'pp_1234', credentialLastFour: '1234' } } };
  });
  const client = new AcpHostClient({ command: '/fake/host', spawnImpl, requestTimeoutMs: 500 });

  await client.listProviderProfiles();
  const created = await client.createProviderProfile(profile, 'sk-test-1234');
  await client.updateProviderProfile('pp_1234', { ...profile, displayName: 'Renamed' });
  await client.replaceProviderSecret('pp_1234', 'sk-replaced-5678');
  const deleted = await client.deleteProviderProfile('pp_1234');

  assert.equal(created.profile.credentialLastFour, '1234');
  assert.equal(deleted.deleted, true);
  assert.deepEqual(
    received.slice(1).map((request) => request.method),
    [
      '_x.agentmesh360/providers/list',
      '_x.agentmesh360/providers/create',
      '_x.agentmesh360/providers/update',
      '_x.agentmesh360/providers/replace-secret',
      '_x.agentmesh360/providers/delete',
    ],
  );
  assert.deepEqual(received[2].params, { profile, apiKey: 'sk-test-1234' });
  assert.deepEqual(received[4].params, { profileId: 'pp_1234', apiKey: 'sk-replaced-5678' });
  assert.ok(received.every((request) => !request.method.includes('get-secret')));
  await client.stop();
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
        const result = handler(request);
        child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
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
