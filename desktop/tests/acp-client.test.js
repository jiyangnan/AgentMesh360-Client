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

test('Provider catalog and model assignments use Host-owned routing extensions', async () => {
  const received = [];
  const assignment = {
    scopeKind: 'agent',
    scopeId: 'job-agent',
    role: 'main',
    providerProfileId: 'pp_1234',
    modelId: 'model-main',
  };
  const spawnImpl = () => fakeChild((request) => {
    received.push(request);
    if (request.method === 'initialize') return { capabilities: {} };
    if (request.method === '_x.agentmesh360/providers/catalog') {
      return { result: { catalog: { schemaVersion: 1, providers: [] } } };
    }
    if (request.method === '_x.agentmesh360/model-assignments/list') {
      return { result: { assignments: [] } };
    }
    if (request.method === '_x.agentmesh360/model-assignments/delete') {
      return { result: { deleted: true } };
    }
    return { result: { assignment: { assignmentId: 'ma_1234', ...assignment } } };
  });
  const client = new AcpHostClient({ command: '/fake/host', spawnImpl, requestTimeoutMs: 500 });

  await client.getProviderCatalog();
  await client.listModelAssignments();
  const upserted = await client.upsertModelAssignment(assignment);
  const deleted = await client.deleteModelAssignment('ma_1234');

  assert.equal(upserted.assignment.assignmentId, 'ma_1234');
  assert.equal(deleted.deleted, true);
  assert.deepEqual(
    received.slice(1).map((request) => request.method),
    [
      '_x.agentmesh360/providers/catalog',
      '_x.agentmesh360/model-assignments/list',
      '_x.agentmesh360/model-assignments/upsert',
      '_x.agentmesh360/model-assignments/delete',
    ],
  );
  assert.deepEqual(received[3].params, { assignment });
  assert.deepEqual(received[4].params, { assignmentId: 'ma_1234' });
  await client.stop();
});

test('Provider Probe methods preserve explicit level and paid confirmation', async () => {
  const received = [];
  const spawnImpl = () => fakeChild((request) => {
    received.push(request);
    if (request.method === 'initialize') return { capabilities: {} };
    if (request.method === '_x.agentmesh360/providers/probes/list') {
      return { result: { probes: [] } };
    }
    return {
      result: {
        probe: {
          probeId: 'probe_1234',
          status: 'confirmation_required',
          networkAttempted: false,
        },
      },
    };
  });
  const client = new AcpHostClient({ command: '/fake/host', spawnImpl, requestTimeoutMs: 500 });

  const unconfirmed = await client.runProviderProbe({
    profileId: 'pp_1234',
    modelId: 'gpt-5',
    level: 'minimal_inference',
    confirmPaidInference: false,
  });
  const history = await client.listProviderProbes('pp_1234');

  assert.equal(unconfirmed.probe.status, 'confirmation_required');
  assert.deepEqual(history.probes, []);
  assert.deepEqual(received[1], {
    jsonrpc: '2.0',
    id: 2,
    method: '_x.agentmesh360/providers/probes/run',
    params: {
      profileId: 'pp_1234',
      modelId: 'gpt-5',
      level: 'minimal_inference',
      confirmPaidInference: false,
    },
  });
  assert.deepEqual(received[2].params, { profileId: 'pp_1234' });
  await client.stop();
});

test('Session Provider Binding methods keep route snapshots Host-owned', async () => {
  const received = [];
  const binding = {
    bindingId: 'spb_1234',
    sessionId: 'session-a',
    role: 'main',
    agentId: 'job-agent',
    bindingRevision: 1,
    changeReason: 'initial',
    snapshotHash: 'hash',
    route: { providerProfileId: 'pp_1234', modelId: 'model-main' },
  };
  const spawnImpl = () => fakeChild((request) => {
    received.push(request);
    if (request.method === 'initialize') return { capabilities: {} };
    if (request.method === '_x.agentmesh360/session-bindings/history') {
      return { result: { bindings: [binding] } };
    }
    if (request.method === '_x.agentmesh360/turn-routes/list') {
      return { result: { turnRoutes: [] } };
    }
    return { result: { binding } };
  });
  const client = new AcpHostClient({ command: '/fake/host', spawnImpl, requestTimeoutMs: 500 });

  await client.resolveSessionBinding({ sessionId: 'session-a', role: 'main', agentId: 'job-agent' });
  const history = await client.getSessionBindingHistory({
    sessionId: 'session-a',
    role: 'main',
    agentId: 'job-agent',
  });
  await client.switchSessionBinding({
    sessionId: 'session-a',
    role: 'main',
    agentId: 'job-agent',
    kind: 'rollback',
    targetBindingRevision: 1,
  });
  const turnRoutes = await client.listTurnRoutes({
    sessionId: 'session-a',
    role: 'main',
    agentId: 'job-agent',
  });

  assert.deepEqual(history.bindings, [binding]);
  assert.deepEqual(turnRoutes.turnRoutes, []);
  assert.deepEqual(
    received.slice(1).map((request) => request.method),
    [
      '_x.agentmesh360/session-bindings/resolve',
      '_x.agentmesh360/session-bindings/history',
      '_x.agentmesh360/session-bindings/switch',
      '_x.agentmesh360/turn-routes/list',
    ],
  );
  assert.deepEqual(received[3].params, {
    sessionId: 'session-a',
    role: 'main',
    agentId: 'job-agent',
    kind: 'rollback',
    targetBindingRevision: 1,
  });
  assert.ok(received.every((request) => !JSON.stringify(request.params).includes('preparedRoute')));
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
