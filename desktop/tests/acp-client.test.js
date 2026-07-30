'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { AcpHostClient, resolveHostCommand } = require('../src/host/acp-client');

const embeddedHostEnv = {
  ...process.env,
  AGENTMESH360_HOST_MODE: 'embedded',
};

test('ACP client initializes the Host and unwraps AgentMesh360 extension responses', async () => {
  const received = [];
  let child;
  const spawnImpl = () => {
    child = fakeChild((request) => {
    received.push(request);
    if (request.method === 'initialize') return { capabilities: {} };
    if (request.method === '_x.agentmesh360/account/bootstrap') {
      return { result: { schemaVersion: 1, account: { id: 7 }, access: { canEnterClient: true } } };
    }
    if (request.method === '_x.agentmesh360/agents/list') {
      return { result: { agents: [{ agentId: 'job-agent' }] } };
    }
    if (request.method === '_x.agentmesh360/agents/artifacts/list') {
      return {
        result: {
          schemaVersion: 1,
          revision: 2,
          artifacts: [{
            artifactId: 'role-fit-report',
            title: '岗位匹配报告',
            kind: 'document',
            sizeBytes: 183421,
          }],
        },
      };
    }
    if (request.method === '_x.agentmesh360/agents/project-state/get') {
      return {
        result: {
          schemaVersion: 1,
          revision: 4,
          project: {
            title: '产品岗位第 3 轮',
            status: 'active',
            summary: '正在核对岗位。',
            steps: [],
          },
        },
      };
    }
    if (request.method === '_x.agentmesh360/agents/background-activities/list') {
      return {
        result: {
          activities: [{
            taskId: 'private-host-task',
            kind: 'monitor',
            status: 'running',
          }],
        },
      };
    }
    if (request.method === '_x.agentmesh360/agents/session-plan/get') {
      return {
        result: {
          entries: [{
            content: '核对岗位要求',
            status: 'in_progress',
          }],
        },
      };
    }
    return { result: null, error: 'unsupported' };
    });
    return child;
  };
  const client = new AcpHostClient({
    command: '/fake/host',
    env: embeddedHostEnv,
    spawnImpl,
    requestTimeoutMs: 500,
  });

  assert.equal(client.getRuntimeStatus().bridgeState, 'detached');
  const bootstrap = await client.bootstrap('access-token-private');
  const list = await client.listAgents();
  const artifacts = await client.listWorkspaceArtifacts('job-agent');
  const projectState = await client.getWorkspaceProjectState('job-agent');
  const background = await client.listAgentBackgroundActivities('job-agent');
  const sessionPlan = await client.getAgentSessionPlan('job-agent');

  assert.equal(bootstrap.account.id, 7);
  assert.equal(list.agents[0].agentId, 'job-agent');
  assert.equal(artifacts.artifacts[0].artifactId, 'role-fit-report');
  assert.equal(projectState.project.title, '产品岗位第 3 轮');
  assert.equal(background.activities[0].taskId, 'private-host-task');
  assert.equal(sessionPlan.entries[0].content, '核对岗位要求');
  assert.equal(received[0].method, 'initialize');
  assert.equal(received[0].params._meta.clientIdentifier, 'agentmesh360-desktop');
  assert.equal(received[0].params._meta.clientVersion, require('../package.json').version);
  assert.equal(received[1].method, '_x.agentmesh360/account/bootstrap');
  assert.deepEqual(received[1].params, { accessToken: 'access-token-private' });
  assert.equal(received[3].method, '_x.agentmesh360/agents/artifacts/list');
  assert.deepEqual(received[3].params, { agentId: 'job-agent' });
  assert.equal(received[4].method, '_x.agentmesh360/agents/project-state/get');
  assert.deepEqual(received[4].params, { agentId: 'job-agent' });
  assert.equal(received[5].method, '_x.agentmesh360/agents/background-activities/list');
  assert.deepEqual(received[5].params, { agentId: 'job-agent' });
  assert.equal(received[6].method, '_x.agentmesh360/agents/session-plan/get');
  assert.deepEqual(received[6].params, { agentId: 'job-agent' });
  assert.equal(client.getRuntimeStatus().bridgeState, 'connected');

  let reconnectEvents = 0;
  client.on('reconnected', () => { reconnectEvents += 1; });
  child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    method: 'x.ai/leader_reconnected',
    params: { sessionId: 'private-session-id' },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reconnectEvents, 1);

  await client.stop();
  assert.equal(client.getRuntimeStatus().bridgeState, 'detached');
});

test('Host access refresh keeps Provider requests queued until authentication is ready', async () => {
  const received = [];
  let releaseBootstrap;
  const bootstrapGate = new Promise((resolve) => {
    releaseBootstrap = resolve;
  });
  const spawnImpl = () => fakeChild(async (request) => {
    received.push(request);
    if (request.method === 'initialize') return { capabilities: {} };
    if (request.method === '_x.agentmesh360/account/bootstrap') {
      await bootstrapGate;
      return {
        result: {
          schemaVersion: 1,
          account: { id: 7 },
          access: { canEnterClient: true },
        },
      };
    }
    if (request.method === '_x.agentmesh360/providers/list') {
      return { result: { profiles: [] } };
    }
    return { result: null, error: 'unsupported' };
  });
  const client = new AcpHostClient({
    command: '/fake/host',
    env: embeddedHostEnv,
    spawnImpl,
    requestTimeoutMs: 500,
  });

  const refresh = client.bootstrap('renewed-access-token');
  await waitFor(() => received.some(
    (request) => request.method === '_x.agentmesh360/account/bootstrap',
  ));
  const providers = client.listProviderProfiles();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    received.some((request) => request.method === '_x.agentmesh360/providers/list'),
    false,
    'Provider request must not enter the Host authentication gap',
  );

  releaseBootstrap();
  await refresh;
  assert.deepEqual(await providers, { profiles: [] });
  assert.deepEqual(
    received.slice(1).map((request) => request.method),
    [
      '_x.agentmesh360/account/bootstrap',
      '_x.agentmesh360/providers/list',
    ],
  );
  await client.stop();
});

test('Host command resolution prefers explicit and packaged binaries', () => {
  assert.equal(resolveHostCommand({ env: { AGENTMESH360_HOST_BIN: '/custom/host' } }).command, '/custom/host');
  const fallback = resolveHostCommand({ env: {}, resourcesPath: '/definitely/missing' });
  assert.ok(['grok', '/Users/ferdinandji/AgentMesh360-Client/target/release/xai-grok-pager', '/Users/ferdinandji/AgentMesh360-Client/target/debug/xai-grok-pager'].includes(fallback.command));
  assert.deepEqual(fallback.args, ['agent', '--leader', 'stdio']);
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
  const client = new AcpHostClient({
    command: '/fake/host',
    env: embeddedHostEnv,
    spawnImpl,
    requestTimeoutMs: 500,
  });

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

test('Agent Package management exposes only Host-owned package and approval identifiers', async () => {
  const received = [];
  const spawnImpl = () => fakeChild((request) => {
    received.push(request);
    if (request.method === 'initialize') return { capabilities: {} };
    if (request.method === '_x.agentmesh360/agent-packages/catalog') {
      return { result: { catalog: { schemaVersion: 1, packages: [] } } };
    }
    if (request.method === '_x.agentmesh360/agent-packages/status') {
      return { result: { packages: [] } };
    }
    if (request.method === '_x.agentmesh360/agent-packages/remote-catalog') {
      return {
        result: {
          outcome: 'ready',
          registryRevision: 7,
          registryExpiresAt: '2026-08-01T00:00:00Z',
          packages: [],
        },
      };
    }
    if (request.method === '_x.agentmesh360/agent-packages/remote-refresh') {
      return { result: { outcome: 'disabled', reason: 'not_configured' } };
    }
    if (request.method === '_x.agentmesh360/agent-packages/download') {
      return {
        result: {
          status: 'approval_required',
          approval: { approvalId: 'approval-1234' },
        },
      };
    }
    if (request.method === '_x.agentmesh360/agent-packages/approve') {
      return {
        result: {
          packageId: 'com.agentmesh360.job-agent',
          runtimeVisibility: { status: 'visible' },
        },
      };
    }
    if (request.method === '_x.agentmesh360/agent-packages/rollback') {
      return {
        result: null,
        error: {
          code: 'package_rollback_unavailable',
          message: 'The Agent Package could not be rolled back.',
        },
      };
    }
    return {
      result: {
        packageId: 'com.agentmesh360.job-agent',
        runtimeVisibility: { status: 'visible' },
      },
    };
  });
  const client = new AcpHostClient({
    command: '/fake/host',
    env: embeddedHostEnv,
    spawnImpl,
    requestTimeoutMs: 500,
  });

  await client.getAgentPackageCatalog();
  await client.getAgentPackageStatus();
  await client.getRemoteAgentPackageCatalog();
  await client.refreshAgentPackageRegistry();
  const challenge = await client.downloadAgentPackage('com.agentmesh360.job-agent');
  const installed = await client.approveAgentPackage('approval-1234');
  await assert.rejects(
    client.rollbackAgentPackage('com.agentmesh360.job-agent'),
    (error) => error.code === 'package_rollback_unavailable',
  );
  const reconciled = await client.reconcileAgentPackage('com.agentmesh360.job-agent');

  assert.equal(challenge.approval.approvalId, 'approval-1234');
  assert.equal(installed.runtimeVisibility.status, 'visible');
  assert.equal(reconciled.runtimeVisibility.status, 'visible');
  assert.deepEqual(
    received.slice(1).map((request) => request.method),
    [
      '_x.agentmesh360/agent-packages/catalog',
      '_x.agentmesh360/agent-packages/status',
      '_x.agentmesh360/agent-packages/remote-catalog',
      '_x.agentmesh360/agent-packages/remote-refresh',
      '_x.agentmesh360/agent-packages/download',
      '_x.agentmesh360/agent-packages/approve',
      '_x.agentmesh360/agent-packages/rollback',
      '_x.agentmesh360/agent-packages/reconcile',
    ],
  );
  assert.deepEqual(received[5].params, {
    packageId: 'com.agentmesh360.job-agent',
  });
  assert.deepEqual(received[6].params, { approvalId: 'approval-1234' });
  assert.deepEqual(received[7].params, {
    packageId: 'com.agentmesh360.job-agent',
  });
  assert.deepEqual(received[8].params, {
    packageId: 'com.agentmesh360.job-agent',
  });
  const serialized = JSON.stringify(received.slice(1));
  for (const forbidden of ['url', 'path', 'digest', 'publisher', 'permissionsApproved']) {
    assert.equal(serialized.includes(forbidden), false);
  }
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
  const client = new AcpHostClient({
    command: '/fake/host',
    env: embeddedHostEnv,
    spawnImpl,
    requestTimeoutMs: 500,
  });

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
  const client = new AcpHostClient({
    command: '/fake/host',
    env: embeddedHostEnv,
    spawnImpl,
    requestTimeoutMs: 500,
  });

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

test('unsaved Provider connection test preserves one-shot credential and explicit confirmation', async () => {
  const received = [];
  const spawnImpl = () => fakeChild((request) => {
    received.push(request);
    if (request.method === 'initialize') return { capabilities: {} };
    return {
      result: {
        connectionTest: {
          status: 'passed',
          networkAttempted: true,
          mayIncurCost: true,
        },
      },
    };
  });
  const client = new AcpHostClient({
    command: '/fake/host',
    env: embeddedHostEnv,
    spawnImpl,
    requestTimeoutMs: 500,
  });
  const profile = {
    presetId: 'google-gemini',
    displayName: 'Google Gemini',
    protocol: 'openai_chat',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authKind: 'bearer_api_key',
    enabledModels: ['gemini-3.5-flash-lite'],
  };

  const result = await client.testProviderConnection({
    profile,
    apiKey: 'ephemeral-secret',
    modelId: 'gemini-3.5-flash-lite',
    confirmPaidInference: true,
  });

  assert.equal(result.connectionTest.status, 'passed');
  assert.deepEqual(received[1], {
    jsonrpc: '2.0',
    id: 2,
    method: '_x.agentmesh360/providers/test-connection',
    params: {
      profile,
      apiKey: 'ephemeral-secret',
      modelId: 'gemini-3.5-flash-lite',
      confirmPaidInference: true,
    },
  });
  await client.stop();
});

test('Provider model discovery forwards one-shot credentials without inference confirmation', async () => {
  const received = [];
  const spawnImpl = () => fakeChild((request) => {
    received.push(request);
    if (request.method === 'initialize') return { capabilities: {} };
    return {
      result: {
        modelDiscovery: {
          status: 'passed',
          authenticationVerified: true,
          mayIncurCost: false,
          models: [{ modelId: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash' }],
        },
      },
    };
  });
  const client = new AcpHostClient({
    command: '/fake/host',
    env: embeddedHostEnv,
    spawnImpl,
    requestTimeoutMs: 500,
  });
  const profile = {
    presetId: 'google-gemini',
    displayName: 'Google Gemini',
    protocol: 'openai_chat',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authKind: 'bearer_api_key',
    enabledModels: [],
  };

  const result = await client.discoverProviderModels({
    profile,
    apiKey: 'ephemeral-model-secret',
  });

  assert.equal(result.modelDiscovery.models[0].modelId, 'gemini-3.6-flash');
  assert.deepEqual(received[1], {
    jsonrpc: '2.0',
    id: 2,
    method: '_x.agentmesh360/providers/discover-models',
    params: {
      profile,
      apiKey: 'ephemeral-model-secret',
    },
  });
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
  const client = new AcpHostClient({
    command: '/fake/host',
    env: embeddedHostEnv,
    spawnImpl,
    requestTimeoutMs: 500,
  });

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

test('ACP session methods keep Main Session authority private and forward streaming notifications', async () => {
  const received = [];
  let child;
  const spawnImpl = () => {
    child = fakeChild((request) => {
      received.push(request);
      if (request.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
      if (request.method === 'session/load') return {};
      if (request.method === 'session/prompt') return { stopReason: 'end_turn' };
      return {};
    });
    return child;
  };
  const client = new AcpHostClient({
    command: '/fake/host',
    env: embeddedHostEnv,
    spawnImpl,
    requestTimeoutMs: 500,
  });
  const notifications = [];
  client.on('notification', (message) => notifications.push(message));

  await client.loadSession({
    sessionId: 'private-main-session',
    cwd: '/private/account/job-agent',
  });
  child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'private-main-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'streamed reply' },
      },
    },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  const response = await client.promptSession({
    sessionId: 'private-main-session',
    text: 'hello',
  });

  assert.equal(response.stopReason, 'end_turn');
  assert.deepEqual(received.slice(1), [
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/load',
      params: {
        sessionId: 'private-main-session',
        cwd: '/private/account/job-agent',
        mcpServers: [],
      },
    },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId: 'private-main-session',
        prompt: [{ type: 'text', text: 'hello' }],
      },
    },
  ]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].params.update.content.text, 'streamed reply');
  await client.stop();
});

test('ACP client handles standard permission reverse requests without exposing arbitrary responses', async () => {
  const received = [];
  let child;
  const spawnImpl = () => {
    child = fakeChild((request) => {
      received.push(request);
      if (request.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
      if (request.method === 'session/prompt') {
        child.stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: 'host-permission-1',
          method: 'session/request_permission',
          params: {
            sessionId: 'private-main-session',
            toolCall: {
              toolCallId: 'private-tool-call',
              title: 'Run the verified deploy command',
              kind: 'execute',
              rawInput: { command: 'private command' },
              locations: [{ path: '/private/workspace' }],
              _meta: { secret: 'private metadata' },
            },
            options: [
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
            ],
            _meta: { secret: 'private request metadata' },
          },
        })}\n`);
        return { stopReason: 'end_turn' };
      }
      return {};
    });
    return child;
  };
  const client = new AcpHostClient({
    command: '/fake/host',
    env: embeddedHostEnv,
    spawnImpl,
    requestTimeoutMs: 500,
  });
  const requests = [];
  client.on('permission-request', (request) => {
    requests.push(request);
    client.respondPermission(request.requestId, 'allow-once');
  });

  const result = await client.promptSession({
    sessionId: 'private-main-session',
    text: 'deploy',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.stopReason, 'end_turn');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].sessionId, 'private-main-session');
  assert.deepEqual(received.find((message) => message.id === 'host-permission-1'), {
    jsonrpc: '2.0',
    id: 'host-permission-1',
    result: {
      outcome: {
        outcome: 'selected',
        optionId: 'allow-once',
      },
    },
  });
  assert.throws(
    () => client.respondPermission('host-permission-1', 'not-offered'),
    /权限请求已失效/,
  );
  await client.stop();
});

test('ACP client cancels unattended permission requests and rejects unsupported reverse methods', async () => {
  const received = [];
  let child;
  const spawnImpl = () => {
    child = fakeChild((request) => {
      received.push(request);
      if (request.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
      return {};
    });
    return child;
  };
  const client = new AcpHostClient({
    command: '/fake/host',
    env: embeddedHostEnv,
    spawnImpl,
    requestTimeoutMs: 500,
  });
  await client.start();

  child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 'host-permission-unattended',
    method: 'session/request_permission',
    params: {
      sessionId: 'private-main-session',
      toolCall: { toolCallId: 'call-1', title: 'Do work' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    },
  })}\n`);
  child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 'host-unknown-method',
    method: 'x.ai/ask_user_question',
    params: {},
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(received.find((message) => message.id === 'host-permission-unattended'), {
    jsonrpc: '2.0',
    id: 'host-permission-unattended',
    result: {
      outcome: { outcome: 'cancelled' },
    },
  });
  assert.deepEqual(received.find((message) => message.id === 'host-unknown-method'), {
    jsonrpc: '2.0',
    id: 'host-unknown-method',
    error: {
      code: -32601,
      message: 'Desktop client method not implemented',
    },
  });
  await client.stop();
});

test('ACP client expires an unanswered permission request as cancelled', async () => {
  const received = [];
  let child;
  const spawnImpl = () => {
    child = fakeChild((request) => {
      received.push(request);
      if (request.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
      return {};
    });
    return child;
  };
  const client = new AcpHostClient({
    command: '/fake/host',
    env: embeddedHostEnv,
    spawnImpl,
    requestTimeoutMs: 500,
    permissionRequestTimeoutMs: 5,
  });
  const resolved = [];
  client.on('permission-request', () => {});
  client.on('permission-resolved', (event) => resolved.push(event));
  await client.start();

  child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 'host-permission-timeout',
    method: 'session/request_permission',
    params: {
      sessionId: 'private-main-session',
      toolCall: { toolCallId: 'call-timeout', title: 'Do time-bounded work' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    },
  })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(received.find((message) => message.id === 'host-permission-timeout'), {
    jsonrpc: '2.0',
    id: 'host-permission-timeout',
    result: {
      outcome: { outcome: 'cancelled' },
    },
  });
  assert.deepEqual(resolved, [{
    requestId: 'host-permission-timeout',
    outcome: 'expired',
  }]);
  await client.stop();
});

test('ACP client cancels permissions before stop and reports transport closure on exit', async () => {
  const first = permissionLifecycleFixture();
  first.client.on('permission-request', () => {});
  await first.client.start();
  first.emitPermission('permission-before-stop');
  await new Promise((resolve) => setImmediate(resolve));
  await first.client.stop();
  assert.deepEqual(first.received.find((message) => message.id === 'permission-before-stop'), {
    jsonrpc: '2.0',
    id: 'permission-before-stop',
    result: { outcome: { outcome: 'cancelled' } },
  });

  const second = permissionLifecycleFixture();
  const resolved = [];
  second.client.on('permission-request', () => {});
  second.client.on('permission-resolved', (event) => resolved.push(event));
  await second.client.start();
  second.emitPermission('permission-before-exit');
  await new Promise((resolve) => setImmediate(resolve));
  second.child.emit('exit', 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(resolved, [{
    requestId: 'permission-before-exit',
    outcome: 'transport_closed',
  }]);
  assert.equal(
    second.received.some((message) => message.id === 'permission-before-exit'),
    false,
  );
});

test('ACP client rejects malformed and duplicate permission requests', async () => {
  const fixture = permissionLifecycleFixture();
  fixture.client.on('permission-request', () => {});
  await fixture.client.start();
  fixture.emitPermission('duplicate-permission');
  fixture.emitPermission('duplicate-permission');
  fixture.child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 'malformed-permission',
    method: 'session/request_permission',
    params: {
      sessionId: 'private-main-session',
      toolCall: { toolCallId: 'call-malformed', title: 'Malformed work' },
      options: [],
    },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    fixture.received.find((message) => (
      message.id === 'duplicate-permission'
      && message.error
    )),
    {
      jsonrpc: '2.0',
      id: 'duplicate-permission',
      error: { code: -32602, message: 'Invalid permission request' },
    },
  );
  assert.deepEqual(
    fixture.received.find((message) => message.id === 'malformed-permission'),
    {
      jsonrpc: '2.0',
      id: 'malformed-permission',
      error: { code: -32602, message: 'Invalid permission request' },
    },
  );
  await fixture.client.stop();
});

function permissionLifecycleFixture() {
  const received = [];
  let child;
  const client = new AcpHostClient({
    command: '/fake/host',
    env: embeddedHostEnv,
    requestTimeoutMs: 500,
    spawnImpl: () => {
      child = fakeChild((request) => {
        received.push(request);
        if (request.method === 'initialize') {
          return { protocolVersion: 1, agentCapabilities: {} };
        }
        return {};
      });
      return child;
    },
  });
  return {
    client,
    received,
    get child() { return child; },
    emitPermission(id) {
      child.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: {
          sessionId: 'private-main-session',
          toolCall: { toolCallId: `call-${id}`, title: 'Lifecycle work' },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
          ],
        },
      })}\n`);
    },
  };
}

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

async function waitFor(predicate, timeoutMs = 500) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setImmediate(resolve));
  }
}
