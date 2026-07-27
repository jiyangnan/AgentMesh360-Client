'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AgentConversationController } = require('../src/conversation-controller');

test('conversation open resolves the Host-owned Main Session and only publishes safe text history', async () => {
  const fixture = makeFixture();
  const states = [];
  fixture.controller.subscribe((state) => states.push(state));
  fixture.host.loadImpl = async () => {
    fixture.host.emitSession('private-session-id', 'user_message_chunk', '上次我们讨论了产品岗位。', {
      accessToken: 'must-not-leak',
    });
    fixture.host.emitSession('private-session-id', 'agent_message_chunk', '对，我还记得。');
    fixture.host.emitSession('another-account-session', 'agent_message_chunk', 'other account secret');
    return {};
  };

  const snapshot = await fixture.controller.open('job-agent');

  assert.equal(fixture.activationCalls, 1);
  assert.deepEqual(fixture.host.loadCalls, [{
    sessionId: 'private-session-id',
    cwd: '/private/account-7/job-agent',
  }]);
  assert.equal(snapshot.phase, 'ready');
  assert.equal(snapshot.agentId, 'job-agent');
  assert.equal(snapshot.displayName, 'Job Agent');
  assert.deepEqual(snapshot.messages.map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: '上次我们讨论了产品岗位。' },
    { role: 'assistant', text: '对，我还记得。' },
  ]);
  const serialized = JSON.stringify(states);
  for (const forbidden of [
    'private-session-id',
    '/private/account-7',
    'must-not-leak',
    'other account secret',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('conversation prompt uses private authority, streams bounded text, and ignores unsafe Host payloads', async () => {
  const fixture = makeFixture();
  await fixture.controller.open('job-agent');

  fixture.host.promptImpl = async ({ sessionId, text }) => {
    assert.equal(sessionId, 'private-session-id');
    assert.equal(text, '继续帮我分析这个岗位');
    fixture.host.emitSession(sessionId, 'user_message_chunk', text);
    fixture.host.emitSession(sessionId, 'tool_call', null, {
      title: 'Read /Users/private/resume.pdf',
      rawInput: { apiKey: 'sk-private' },
    });
    fixture.host.emitSession(sessionId, 'agent_message_chunk', '我会先对齐岗位要求，');
    fixture.host.emitSession(sessionId, 'agent_message_chunk', '再检查你的证据。');
    return { stopReason: 'end_turn', _meta: { providerKey: 'sk-private' } };
  };

  const snapshot = await fixture.controller.send('继续帮我分析这个岗位');

  assert.equal(snapshot.phase, 'ready');
  assert.equal(snapshot.streaming, false);
  assert.equal(snapshot.stopReason, 'end_turn');
  assert.deepEqual(snapshot.messages.map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: '继续帮我分析这个岗位' },
    { role: 'assistant', text: '我会先对齐岗位要求，再检查你的证据。' },
  ]);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('/Users/private'), false);
  assert.equal(serialized.includes('sk-private'), false);
  assert.equal(serialized.includes('rawInput'), false);
});

test('conversation authority is cleared when identity access or the Leader attachment changes', async () => {
  const fixture = makeFixture();
  await fixture.controller.open('job-agent');

  fixture.identity.publish({ phase: 'blocked', account: { id: 7 } });
  assert.deepEqual(fixture.controller.getSnapshot(), { phase: 'idle' });
  await assert.rejects(
    fixture.controller.send('should fail'),
    /尚未打开/,
  );

  fixture.identity.publish(readyIdentity());
  await fixture.controller.open('job-agent');
  fixture.host.emit('reconnected');
  const reconnectSnapshot = fixture.controller.getSnapshot();
  assert.equal(reconnectSnapshot.phase, 'error');
  assert.equal(reconnectSnapshot.agentId, 'job-agent');
  assert.equal(JSON.stringify(reconnectSnapshot).includes('private-session-id'), false);
  await assert.rejects(
    fixture.controller.send('still fails'),
    /重新打开/,
  );
});

test('conversation errors are redacted and invalid Renderer input never reaches the Host', async () => {
  const fixture = makeFixture();
  fixture.host.loadImpl = async () => {
    throw Object.assign(new Error('Host failed at /private/account-7 with sk-private'), {
      code: 'host_request_failed',
    });
  };

  const snapshot = await fixture.controller.open('job-agent');
  assert.equal(snapshot.phase, 'error');
  assert.equal(JSON.stringify(snapshot).includes('/private/account-7'), false);
  assert.equal(JSON.stringify(snapshot).includes('sk-private'), false);

  await assert.rejects(fixture.controller.open('../escape'), /Agent ID 无效/);
  await assert.rejects(fixture.controller.send('x'.repeat(16_001)), /消息过长/);
  assert.equal(fixture.activationCalls, 1);
});

test('conversation rejects a different concurrent open instead of returning the wrong Agent snapshot', async () => {
  const fixture = makeFixture();
  let resolveLoad;
  fixture.host.loadImpl = () => new Promise((resolve) => {
    resolveLoad = resolve;
  });

  const jobOpen = fixture.controller.open('job-agent');
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    fixture.controller.open('lecturecast-agent'),
    /另一个 Agent 对话正在打开/,
  );
  resolveLoad({});
  const snapshot = await jobOpen;

  assert.equal(snapshot.agentId, 'job-agent');
  assert.equal(fixture.activationCalls, 1);
});

test('conversation revokes authority after a prompt timeout and ignores late chunks', async () => {
  const fixture = makeFixture();
  await fixture.controller.open('job-agent');
  fixture.host.promptImpl = async ({ sessionId }) => {
    setImmediate(() => {
      fixture.host.emitSession(sessionId, 'agent_message_chunk', '迟到的内容');
    });
    throw Object.assign(new Error('private timeout details'), { code: 'host_timeout' });
  };

  const snapshot = await fixture.controller.send('继续');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(snapshot.phase, 'error');
  assert.match(snapshot.error, /响应超时/);
  assert.equal(JSON.stringify(fixture.controller.getSnapshot()).includes('迟到的内容'), false);
  await assert.rejects(fixture.controller.send('不能交错重发'), /重新打开/);
});

test('conversation fails closed when a ready-looking identity lacks explicit client access', async () => {
  const fixture = makeFixture();
  fixture.identity.publish({
    ...readyIdentity(),
    access: undefined,
  });

  await assert.rejects(
    fixture.controller.open('job-agent'),
    /订阅验证/,
  );
  assert.equal(fixture.activationCalls, 0);
});

test('conversation opens every current-account catalog agent through the same private Host path', async () => {
  const fixture = makeFixture();

  for (const agentId of [
    'job-agent',
    'lecturecast-agent',
    'deploy-agent',
    'future-agent',
  ]) {
    const snapshot = await fixture.controller.open(agentId);
    assert.equal(snapshot.phase, 'ready');
    assert.equal(snapshot.agentId, agentId);
    assert.equal(snapshot.displayName, fixture.identity.getState().agents
      .find((agent) => agent.agentId === agentId).displayName);
  }

  assert.deepEqual(fixture.host.loadCalls.map((call) => call.sessionId), [
    'private-session-id',
    'private-lecture-session',
    'private-deploy-session',
    'private-future-session',
  ]);
});

test('conversation clears the previous account snapshot on a ready-to-ready account switch', async () => {
  const fixture = makeFixture();
  await fixture.controller.open('future-agent');

  fixture.identity.publish({
    ...readyIdentity(),
    account: { id: 8 },
  });
  fixture.host.emitSession('private-future-session', 'agent_message_chunk', '旧账号迟到内容');

  assert.deepEqual(fixture.controller.getSnapshot(), { phase: 'idle' });
  await assert.rejects(fixture.controller.send('不能沿用旧账号'), /尚未打开/);
});

test('conversation projection is bounded while full history remains Host-owned', async () => {
  const fixture = makeFixture();
  fixture.host.loadImpl = async () => {
    for (let index = 0; index < 260; index += 1) {
      fixture.host.emitSession(
        'private-session-id',
        index % 2 === 0 ? 'user_message_chunk' : 'agent_message_chunk',
        `${index}:${'x'.repeat(1200)}`,
      );
    }
    return {};
  };

  const snapshot = await fixture.controller.open('job-agent');

  assert.equal(snapshot.phase, 'ready');
  assert.equal(snapshot.transcriptTruncated, true);
  assert.ok(snapshot.messages.length <= 200);
  assert.ok(snapshot.messages.reduce((sum, message) => sum + message.text.length, 0) <= 200_000);
  assert.equal(snapshot.messages.at(-1).text.startsWith('259:'), true);
});

test('conversation projects a one-time permission choice and keeps Host authority private', async () => {
  const fixture = makeFixture();
  await fixture.controller.open('job-agent');
  let finishPrompt;
  fixture.host.promptImpl = () => new Promise((resolve) => {
    finishPrompt = resolve;
  });

  const sending = fixture.controller.send('执行部署');
  await new Promise((resolve) => setImmediate(resolve));
  fixture.host.emit('permission-request', {
    requestId: 'host-private-request-id',
    sessionId: 'private-session-id',
    toolCall: {
      toolCallId: 'private-tool-call-id',
      title: 'Run the verified deploy command',
      kind: 'execute',
      rawInput: { command: 'rm private-file' },
      locations: [{ path: '/private/account-7' }],
      _meta: { apiKey: 'sk-private' },
    },
    options: [
      { optionId: 'enable-always-approve', name: 'Enable global approval', kind: 'allow_once' },
      { optionId: 'custom-one-time', name: 'Unknown allow-once semantic', kind: 'allow_once' },
      { optionId: 'allow-once', name: '仅本次允许', kind: 'allow_once' },
      { optionId: 'allow-always', name: '以后总是允许', kind: 'allow_always' },
      { optionId: 'reject-once', name: '本次拒绝', kind: 'reject_once' },
      { optionId: 'reject-always', name: '以后总是拒绝', kind: 'reject_always' },
    ],
    _meta: { private: true },
  });

  const pending = fixture.controller.getSnapshot();
  assert.equal(pending.phase, 'sending');
  assert.equal(pending.interaction.kind, 'permission');
  assert.equal(pending.interaction.title, 'Run the verified deploy command');
  assert.equal(pending.interaction.toolKind, 'execute');
  assert.deepEqual(
    pending.interaction.options.map(({ label, decision }) => ({ label, decision })),
    [
      { label: '仅本次允许', decision: 'allow' },
      { label: '本次拒绝', decision: 'reject' },
    ],
  );
  const serialized = JSON.stringify(pending);
  for (const forbidden of [
    'host-private-request-id',
    'private-session-id',
    'private-tool-call-id',
    'enable-always-approve',
    'custom-one-time',
    'allow-always',
    'reject-always',
    'rm private-file',
    '/private/account-7',
    'sk-private',
    'rawInput',
    'locations',
    '_meta',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }

  const allowed = pending.interaction.options.find((option) => option.decision === 'allow');
  const afterDecision = fixture.controller.respondToPermission(
    pending.interaction.interactionId,
    allowed.optionId,
  );
  assert.equal(afterDecision.interaction, undefined);
  assert.deepEqual(fixture.host.permissionResponses, [{
    requestId: 'host-private-request-id',
    optionId: 'allow-once',
  }]);
  finishPrompt({ stopReason: 'end_turn' });
  await sending;
});

test('conversation cancels permission when authority changes and rejects stale Renderer choices', async () => {
  const fixture = makeFixture();
  await fixture.controller.open('job-agent');
  fixture.host.emit('permission-request', {
    requestId: 'host-private-request-id',
    sessionId: 'private-session-id',
    toolCall: {
      toolCallId: 'private-tool-call-id',
      title: 'Edit a file',
      kind: 'edit',
    },
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
  });
  const interaction = fixture.controller.getSnapshot().interaction;
  assert.throws(
    () => fixture.controller.respondToPermission('forged-interaction', interaction.options[0].optionId),
    /权限请求已失效/,
  );
  assert.throws(
    () => fixture.controller.respondToPermission(interaction.interactionId, 'forged-option'),
    /权限选项无效/,
  );
  assert.deepEqual(fixture.host.permissionResponses, []);

  fixture.identity.publish({ phase: 'blocked', account: { id: 7 } });

  assert.deepEqual(fixture.controller.getSnapshot(), { phase: 'idle' });
  assert.deepEqual(fixture.host.permissionResponses, [{
    requestId: 'host-private-request-id',
    optionId: null,
  }]);
  assert.throws(
    () => fixture.controller.respondToPermission(interaction.interactionId, interaction.options[0].optionId),
    /权限请求已失效/,
  );
});

test('conversation auto-cancels permission requests for another session or without safe options', async () => {
  const fixture = makeFixture();
  await fixture.controller.open('job-agent');

  fixture.host.emit('permission-request', {
    requestId: 'other-session-request',
    sessionId: 'another-private-session',
    toolCall: { toolCallId: 'call-other', title: 'Other account action', kind: 'execute' },
    options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }],
  });
  fixture.host.emit('permission-request', {
    requestId: 'persistent-only-request',
    sessionId: 'private-session-id',
    toolCall: { toolCallId: 'call-persistent', title: 'Remember forever', kind: 'execute' },
    options: [{ optionId: 'always-allow', name: 'Always allow', kind: 'allow_always' }],
  });

  assert.equal(fixture.controller.getSnapshot().interaction, undefined);
  assert.deepEqual(fixture.host.permissionResponses, [
    { requestId: 'other-session-request', optionId: null },
    { requestId: 'persistent-only-request', optionId: null },
  ]);
});

test('conversation keeps the first permission and cancels a concurrent second request', async () => {
  const fixture = makeFixture();
  await fixture.controller.open('job-agent');
  fixture.host.emit('permission-request', permissionRequest('first-request', 'First operation'));
  fixture.host.emit('permission-request', permissionRequest('second-request', 'Second operation'));

  const snapshot = fixture.controller.getSnapshot();
  assert.equal(snapshot.interaction.title, 'First operation');
  assert.deepEqual(fixture.host.permissionResponses, [{
    requestId: 'second-request',
    optionId: null,
  }]);
  fixture.controller.respondToPermission(
    snapshot.interaction.interactionId,
    snapshot.interaction.options.find((option) => option.decision === 'reject').optionId,
  );
  assert.deepEqual(fixture.host.permissionResponses.at(-1), {
    requestId: 'first-request',
    optionId: 'reject-once',
  });
});

test('conversation cancels a pending permission and revokes authority on Host exit', async () => {
  const fixture = makeFixture();
  await fixture.controller.open('job-agent');
  fixture.host.emit('permission-request', permissionRequest('exit-request', 'Exit operation'));

  fixture.host.emit('exit', new Error('private host details'));

  const snapshot = fixture.controller.getSnapshot();
  assert.equal(snapshot.phase, 'error');
  assert.match(snapshot.error, /Host 已断开/);
  assert.equal(snapshot.interaction, undefined);
  assert.equal(JSON.stringify(snapshot).includes('private host details'), false);
  assert.deepEqual(fixture.host.permissionResponses, [{
    requestId: 'exit-request',
    optionId: null,
  }]);
  assert.throws(
    () => fixture.controller.respondToPermission('permission-1', 'option-1'),
    /权限请求已失效/,
  );
});

test('conversation reports an expired permission without exposing Host authority', async () => {
  const fixture = makeFixture();
  await fixture.controller.open('job-agent');
  fixture.host.emit('permission-request', permissionRequest('expired-request', 'Timed operation'));

  fixture.host.emit('permission-resolved', {
    requestId: 'expired-request',
    outcome: 'expired',
  });

  const snapshot = fixture.controller.getSnapshot();
  assert.equal(snapshot.interaction, undefined);
  assert.match(snapshot.error, /确认已超时/);
  assert.equal(JSON.stringify(snapshot).includes('expired-request'), false);
  assert.equal(JSON.stringify(snapshot).includes('private-session-id'), false);
});

function permissionRequest(requestId, title) {
  return {
    requestId,
    sessionId: 'private-session-id',
    toolCall: {
      toolCallId: `call-${requestId}`,
      title,
      kind: 'execute',
    },
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
  };
}

function makeFixture() {
  const identity = Object.assign(new EventEmitter(), {
    state: readyIdentity(),
    getState() { return this.state; },
    subscribe(listener) {
      this.on('state', listener);
      listener(this.state);
      return () => this.off('state', listener);
    },
    publish(state) {
      this.state = state;
      this.emit('state', state);
    },
  });
  const host = Object.assign(new EventEmitter(), {
    loadCalls: [],
    promptCalls: [],
    permissionResponses: [],
    loadImpl: async () => ({}),
    promptImpl: async () => ({ stopReason: 'end_turn' }),
    async listAgents() {
      return {
        agents: [
          {
            agentId: 'job-agent',
            displayName: 'Job Agent',
            mainSessionId: 'private-session-id',
            workspaceDir: '/private/account-7/job-agent',
          },
          {
            agentId: 'lecturecast-agent',
            displayName: 'Lecturecast Agent',
            mainSessionId: 'private-lecture-session',
            workspaceDir: '/private/account-7/lecturecast-agent',
          },
          {
            agentId: 'deploy-agent',
            displayName: 'Deploy Agent',
            mainSessionId: 'private-deploy-session',
            workspaceDir: '/private/account-7/deploy-agent',
          },
          {
            agentId: 'future-agent',
            displayName: 'Future Agent',
            mainSessionId: 'private-future-session',
            workspaceDir: '/private/account-7/future-agent',
          },
        ],
      };
    },
    async loadSession(request) {
      this.loadCalls.push(request);
      return this.loadImpl(request);
    },
    async promptSession(request) {
      this.promptCalls.push(request);
      return this.promptImpl(request);
    },
    respondPermission(requestId, optionId) {
      this.permissionResponses.push({ requestId, optionId });
      this.emit('permission-resolved', { requestId });
    },
    emitSession(sessionId, sessionUpdate, text = null, extra = {}) {
      const update = {
        sessionUpdate,
        ...(text === null ? {} : { content: { type: 'text', text } }),
        ...extra,
      };
      this.emit('notification', {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update,
          _meta: { rawPrivateMetadata: 'do-not-project' },
        },
      });
    },
  });
  let activationCalls = 0;
  const fixture = {
    identity,
    host,
    get activationCalls() { return activationCalls; },
  };
  fixture.controller = new AgentConversationController({
    identity,
    host,
    activateAgent: async () => {
      activationCalls += 1;
      return identity.getState();
    },
  });
  return fixture;
}

function readyIdentity() {
  return {
    phase: 'ready',
    account: { id: 7 },
    agents: [
      {
        agentId: 'job-agent',
        displayName: 'Job Agent',
        description: 'Career copilot',
        desiredState: 'running',
        runtimeState: 'resident',
      },
      {
        agentId: 'lecturecast-agent',
        displayName: 'Lecturecast Agent',
        description: 'Lecture production copilot',
        desiredState: 'inactive',
        runtimeState: 'available',
      },
      {
        agentId: 'deploy-agent',
        displayName: 'Deploy Agent',
        description: 'Deployment copilot',
        desiredState: 'inactive',
        runtimeState: 'available',
      },
      {
        agentId: 'future-agent',
        displayName: 'Future Agent',
        description: 'Dynamically installed agent',
        desiredState: 'inactive',
        runtimeState: 'available',
      },
    ],
    access: { canEnterClient: true, reason: 'subscription_active' },
  };
}
