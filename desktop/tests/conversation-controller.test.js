'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AgentConversationController } = require('../src/conversation-controller');

async function waitFor(predicate, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for conversation state');
}

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
      toolCallId: 'private-tool-call-id',
      title: 'Read /Users/private/resume.pdf',
      kind: 'read',
      status: 'pending',
      rawInput: { apiKey: 'sk-private' },
      rawOutput: { token: 'private-output' },
      content: [{ type: 'content', content: { type: 'text', text: 'private content' } }],
      locations: [{ path: '/Users/private/resume.pdf' }],
    });
    fixture.host.emitSession(sessionId, 'tool_call_update', null, {
      toolCallId: 'private-tool-call-id',
      title: 'Finished reading /Users/private/resume.pdf',
      status: 'completed',
      rawOutput: { token: 'private-result' },
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
  assert.deepEqual(snapshot.activities, [{
    activityId: 'activity-1',
    toolKind: 'read',
    status: 'completed',
  }]);
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [
    'private-tool-call-id',
    '/Users/private',
    'sk-private',
    'private-output',
    'private content',
    'private-result',
    'rawInput',
    'rawOutput',
    'locations',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('running conversation accepts a bounded Grok interjection and projects its Host echo once', async () => {
  const fixture = makeFixture();
  await fixture.controller.open('job-agent');
  let releasePrompt;
  fixture.host.promptImpl = async ({ sessionId, text }) => {
    fixture.host.emitSession(sessionId, 'user_message_chunk', text);
    await new Promise((resolve) => { releasePrompt = resolve; });
    fixture.host.emitSession(sessionId, 'agent_message_chunk', '已经调整执行方向。');
    return { stopReason: 'end_turn' };
  };
  fixture.host.interjectImpl = async ({ sessionId, text, interjectionId }) => {
    assert.equal(sessionId, 'private-session-id');
    assert.equal(text, '先检查测试，再继续原任务。');
    assert.match(interjectionId, /^[0-9a-f-]{36}$/u);
    const notification = {
      jsonrpc: '2.0',
      method: 'x.ai/session/interjection',
      params: { sessionId, text, interjectionId },
    };
    fixture.host.emit('notification', notification);
    fixture.host.emit('notification', notification);
    return { status: 'queued' };
  };

  const runningPrompt = fixture.controller.send('先完成这个任务');
  await waitFor(() => (
    fixture.controller.getSnapshot().streaming === true
    && typeof releasePrompt === 'function'
  ));
  const interjected = await fixture.controller.interject('先检查测试，再继续原任务。');

  assert.equal(interjected.streaming, true);
  assert.equal(fixture.host.interjectCalls.length, 1);
  assert.equal(fixture.host.interjectCalls[0].sessionId, 'private-session-id');
  assert.equal(fixture.host.interjectCalls[0].text, '先检查测试，再继续原任务。');
  assert.match(fixture.host.interjectCalls[0].interjectionId, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(interjected.messages.map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: '先完成这个任务' },
    { role: 'user', text: '先检查测试，再继续原任务。' },
  ]);

  releasePrompt();
  const completed = await runningPrompt;
  assert.equal(completed.streaming, false);
  assert.equal(completed.messages.at(-1).text, '已经调整执行方向。');
});

test('conversation interjection fails closed when no turn is running or the Host rejects it', async () => {
  const fixture = makeFixture();
  await fixture.controller.open('job-agent');

  await assert.rejects(
    fixture.controller.interject('不应在空闲状态插话'),
    /没有正在执行/u,
  );
  assert.equal(fixture.host.interjectCalls.length, 0);

  let releasePrompt;
  fixture.host.promptImpl = () => new Promise((resolve) => { releasePrompt = resolve; });
  fixture.host.interjectImpl = async () => ({ status: 'ignored' });
  const runningPrompt = fixture.controller.send('开始任务');
  await waitFor(() => (
    fixture.controller.getSnapshot().streaming === true
    && typeof releasePrompt === 'function'
  ));
  await assert.rejects(
    fixture.controller.interject('这次 Host 没接受'),
    /没有接受/u,
  );
  releasePrompt({ stopReason: 'end_turn' });
  await runningPrompt;
});

test('conversation authority is cleared when identity access or the Leader attachment changes', async () => {
  const fixture = makeFixture();
  fixture.host.artifactImpl = async () => ({
    schemaVersion: 1,
    revision: 1,
    artifacts: [{
      artifactId: 'saved-report',
      title: '已保存报告',
      kind: 'document',
      sizeBytes: 1024,
    }],
  });
  await fixture.controller.open('job-agent');
  fixture.host.emitSession('private-session-id', 'tool_call', null, {
    toolCallId: 'private-before-block',
    title: 'Private blocked activity',
    kind: 'search',
    status: 'in_progress',
  });
  assert.equal(fixture.controller.getSnapshot().activities.length, 1);
  assert.equal(fixture.controller.getSnapshot().artifacts.length, 1);

  fixture.identity.publish({ phase: 'blocked', account: { id: 7 } });
  assert.deepEqual(fixture.controller.getSnapshot(), { phase: 'idle' });
  await assert.rejects(
    fixture.controller.send('should fail'),
    /尚未打开/,
  );

  fixture.identity.publish(readyIdentity());
  await fixture.controller.open('job-agent');
  fixture.host.emitSession('private-session-id', 'tool_call', null, {
    toolCallId: 'private-before-reconnect',
    title: 'Private reconnect activity',
    kind: 'fetch',
    status: 'pending',
  });
  fixture.host.emit('reconnected');
  const reconnectSnapshot = fixture.controller.getSnapshot();
  assert.equal(reconnectSnapshot.phase, 'error');
  assert.equal(reconnectSnapshot.agentId, 'job-agent');
  assert.deepEqual(reconnectSnapshot.activities, []);
  assert.deepEqual(reconnectSnapshot.artifacts, []);
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
  fixture.host.artifactImpl = async () => ({
    schemaVersion: 1,
    revision: 1,
    artifacts: [{
      artifactId: 'saved-report',
      title: '已保存报告',
      kind: 'document',
      sizeBytes: 1024,
    }],
  });
  await fixture.controller.open('job-agent');
  fixture.host.emitSession('private-session-id', 'tool_call', null, {
    toolCallId: 'private-timeout-activity',
    title: 'Private timed activity',
    kind: 'execute',
    status: 'in_progress',
  });
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
  assert.deepEqual(snapshot.activities, []);
  assert.deepEqual(snapshot.artifacts, []);
  assert.equal(JSON.stringify(fixture.controller.getSnapshot()).includes('迟到的内容'), false);
  await assert.rejects(fixture.controller.send('不能交错重发'), /重新打开/);
});

test('conversation restores terminal activities from Host replay without exposing tool payloads', async () => {
  const fixture = makeFixture();
  fixture.host.loadImpl = async () => {
    fixture.host.emitSession('private-session-id', 'tool_call', null, {
      toolCallId: 'private-replay-tool-id',
      title: 'Search /private/account-7/contracts',
      kind: 'search',
      status: 'completed',
      rawInput: { query: 'private-customer' },
      rawOutput: { matches: ['/private/account-7/contracts/a.md'] },
      content: [{ type: 'content', content: { type: 'text', text: 'private replay output' } }],
      locations: [{ path: '/private/account-7/contracts/a.md' }],
      _meta: { isReplay: true, secret: 'private-replay-meta' },
    });
    fixture.host.emitSession('another-account-session', 'tool_call', null, {
      toolCallId: 'other-account-tool-id',
      title: 'Other account work',
      kind: 'execute',
      status: 'completed',
    });
    return {};
  };

  const snapshot = await fixture.controller.open('job-agent');

  assert.deepEqual(snapshot.activities, [{
    activityId: 'activity-1',
    toolKind: 'search',
    status: 'completed',
  }]);
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [
    'private-replay-tool-id',
    'other-account-tool-id',
    '/private/account-7',
    'private-customer',
    'private replay output',
    'private-replay-meta',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('conversation loads and refreshes a bounded Host-owned artifact projection', async () => {
  const fixture = makeFixture();
  let revision = 1;
  fixture.host.artifactImpl = async () => ({
    schemaVersion: 1,
    revision,
    artifacts: revision === 1
      ? [{
        artifactId: 'role-fit-report',
        title: '岗位匹配报告',
        kind: 'document',
        sizeBytes: 183421,
        relativePath: 'artifacts/private-report.pdf',
        digest: 'private-digest',
      }]
      : [{
        artifactId: 'role-fit-report',
        title: '岗位匹配报告（已更新）',
        kind: 'document',
        sizeBytes: 193421,
        absolutePath: '/private/account-7/job-agent/artifacts/report.pdf',
      }],
  });

  const opened = await fixture.controller.open('job-agent');
  assert.deepEqual(opened.artifacts, [{
    artifactId: 'role-fit-report',
    title: '岗位匹配报告',
    kind: 'document',
    sizeBytes: 183421,
  }]);
  assert.deepEqual(fixture.host.artifactCalls, ['job-agent']);

  revision = 2;
  const sent = await fixture.controller.send('更新报告');
  assert.deepEqual(sent.artifacts, [{
    artifactId: 'role-fit-report',
    title: '岗位匹配报告（已更新）',
    kind: 'document',
    sizeBytes: 193421,
  }]);
  assert.deepEqual(fixture.host.artifactCalls, ['job-agent', 'job-agent']);
  const serialized = JSON.stringify(sent);
  for (const forbidden of [
    'relativePath',
    'private-digest',
    'absolutePath',
    '/private/account-7',
    'schemaVersion',
    'revision',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('conversation loads and refreshes a bounded Workspace project read model', async () => {
  const fixture = makeFixture();
  let revision = 1;
  fixture.host.projectStateImpl = async () => ({
    schemaVersion: 1,
    revision,
    project: {
      title: revision === 1 ? '产品岗位第 3 轮' : '产品岗位第 3 轮（继续）',
      status: revision === 1 ? 'active' : 'waiting_for_user',
      summary: '正在核对岗位与证据。',
      canonicalStatePath: '/private/account-7/round.json',
      nextCommand: 'jobagent round status',
      steps: [{
        stepId: 'review-boss',
        label: '审核 Boss 机会',
        status: revision === 1 ? 'in_progress' : 'completed',
        privateEvidence: 'private-digest',
      }],
    },
    sourcePath: '/private/account-7/job-agent',
  });

  const opened = await fixture.controller.open('job-agent');
  assert.deepEqual(opened.project, {
    title: '产品岗位第 3 轮',
    status: 'active',
    summary: '正在核对岗位与证据。',
    steps: [{
      stepId: 'review-boss',
      label: '审核 Boss 机会',
      status: 'in_progress',
    }],
  });
  assert.deepEqual(fixture.host.projectStateCalls, ['job-agent']);

  revision = 2;
  const sent = await fixture.controller.send('继续');
  assert.equal(sent.project.title, '产品岗位第 3 轮（继续）');
  assert.equal(sent.project.status, 'waiting_for_user');
  assert.equal(sent.project.steps[0].status, 'completed');
  assert.deepEqual(fixture.host.projectStateCalls, ['job-agent', 'job-agent']);
  const serialized = JSON.stringify(sent);
  for (const forbidden of [
    'canonicalStatePath',
    'nextCommand',
    'privateEvidence',
    'sourcePath',
    '/private/account-7',
    'schemaVersion',
    'revision',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('conversation fails closed on malformed project state without closing chat', async () => {
  const fixture = makeFixture();
  fixture.host.projectStateImpl = async () => ({
    schemaVersion: 1,
    revision: 1,
    project: {
      title: 'Private\u0085Project',
      status: 'future-status',
      summary: '/private/account-7',
      steps: [{
        stepId: '../escape',
        label: 'private',
        status: 'future-step',
      }],
    },
  });

  const snapshot = await fixture.controller.open('job-agent');

  assert.equal(snapshot.phase, 'ready');
  assert.equal(snapshot.project, null);
  assert.equal(snapshot.projectStatus, 'unavailable');
  assert.equal(JSON.stringify(snapshot).includes('Private'), false);
  assert.equal(JSON.stringify(snapshot).includes('/private/account-7'), false);
});

test('conversation ignores stale project state and uses the same path for a future Agent', async () => {
  const fixture = makeFixture();
  let resolveProject;
  fixture.host.projectStateImpl = () => new Promise((resolve) => {
    resolveProject = resolve;
  });

  const opening = fixture.controller.open('job-agent');
  await new Promise((resolve) => setImmediate(resolve));
  fixture.identity.publish({ phase: 'blocked', account: { id: 7 } });
  resolveProject({
    schemaVersion: 1,
    revision: 1,
    project: {
      title: '旧账号项目',
      status: 'active',
      summary: '不应出现',
      steps: [],
    },
  });
  assert.deepEqual(await opening, { phase: 'idle' });

  fixture.identity.publish(readyIdentity());
  fixture.host.projectStateImpl = async (agentId) => ({
    schemaVersion: 1,
    revision: 1,
    project: {
      title: `${agentId} current work`,
      status: 'active',
      summary: '通用状态',
      steps: [],
    },
  });
  const future = await fixture.controller.open('future-agent');
  assert.equal(future.project.title, 'future-agent current work');
  assert.equal(JSON.stringify(future).includes('旧账号项目'), false);
});

test('conversation fails closed on malformed artifact projections without closing chat', async () => {
  const fixture = makeFixture();
  fixture.host.artifactImpl = async () => ({
    schemaVersion: 1,
    revision: 1,
    artifacts: [{
      artifactId: '../escape',
      title: 'Private /path',
      kind: 'future-kind',
      sizeBytes: -1,
    }],
  });

  const snapshot = await fixture.controller.open('job-agent');

  assert.equal(snapshot.phase, 'ready');
  assert.deepEqual(snapshot.artifacts, []);
  assert.equal(snapshot.artifactStatus, 'unavailable');
  assert.equal(JSON.stringify(snapshot).includes('../escape'), false);
  assert.equal(JSON.stringify(snapshot).includes('Private /path'), false);
});

test('conversation rejects C1 control characters in artifact titles', async () => {
  const fixture = makeFixture();
  fixture.host.artifactImpl = async () => ({
    schemaVersion: 1,
    revision: 1,
    artifacts: [{
      artifactId: 'control-title',
      title: 'Private\u0085Title',
      kind: 'document',
      sizeBytes: 10,
    }],
  });

  const snapshot = await fixture.controller.open('job-agent');

  assert.equal(snapshot.phase, 'ready');
  assert.deepEqual(snapshot.artifacts, []);
  assert.equal(snapshot.artifactStatus, 'unavailable');
  assert.equal(JSON.stringify(snapshot).includes('Private'), false);
});

test('conversation ignores a stale artifact response after account authority is revoked', async () => {
  const fixture = makeFixture();
  let resolveArtifacts;
  fixture.host.artifactImpl = () => new Promise((resolve) => {
    resolveArtifacts = resolve;
  });

  const opening = fixture.controller.open('job-agent');
  await new Promise((resolve) => setImmediate(resolve));
  fixture.identity.publish({ phase: 'blocked', account: { id: 7 } });
  resolveArtifacts({
    schemaVersion: 1,
    revision: 1,
    artifacts: [{
      artifactId: 'stale-private-report',
      title: '旧账号报告',
      kind: 'document',
      sizeBytes: 10,
    }],
  });

  const snapshot = await opening;
  assert.deepEqual(snapshot, { phase: 'idle' });
  assert.equal(JSON.stringify(fixture.controller.getSnapshot()).includes('stale-private-report'), false);
});

test('conversation keeps activities bounded and ignores malformed or regressive tool updates', async () => {
  const fixture = makeFixture();
  await fixture.controller.open('job-agent');

  fixture.host.emitSession('private-session-id', 'tool_call', null, {
    toolCallId: 'terminal-private-id',
    title: 'Private completed title',
    kind: 'execute',
    status: 'completed',
  });
  fixture.host.emitSession('private-session-id', 'tool_call_update', null, {
    toolCallId: 'terminal-private-id',
    title: 'Regressive private title',
    kind: 'delete',
    status: 'in_progress',
  });
  assert.deepEqual(fixture.controller.getSnapshot().activities, [
    {
      activityId: 'activity-1',
      toolKind: 'execute',
      status: 'completed',
    },
  ]);
  fixture.host.emitSession('private-session-id', 'tool_call', null, {
    toolCallId: 'unknown-status-private-id',
    title: 'Unknown future status',
    kind: 'edit',
    status: 'future_status',
  });
  assert.equal(fixture.controller.getSnapshot().activities.length, 1);
  fixture.host.emitSession('private-session-id', 'tool_call_update', null, {
    toolCallId: 'missing-private-id',
    status: 'completed',
  });
  assert.equal(fixture.controller.getSnapshot().activities.length, 1);
  fixture.host.emitSession('private-session-id', 'tool_call', null, {
    toolCallId: 42,
    title: 'Malformed id',
    kind: 'read',
    status: 'pending',
  });
  for (let index = 0; index < 60; index += 1) {
    fixture.host.emitSession('private-session-id', 'tool_call', null, {
      toolCallId: `bounded-private-id-${index}`,
      title: `Private title ${index}`,
      kind: index % 2 === 0 ? 'read' : 'future_kind',
      status: index % 3 === 0 ? 'in_progress' : 'completed',
    });
  }

  const snapshot = fixture.controller.getSnapshot();
  assert.equal(snapshot.activities.length, 50);
  assert.equal(snapshot.activities[0].activityId.startsWith('activity-'), true);
  assert.equal(snapshot.activities.at(-1).toolKind, 'other');
  assert.equal(
    snapshot.activities.some(({ status }) => ![
      'pending',
      'in_progress',
      'completed',
      'failed',
    ].includes(status)),
    false,
  );
  const terminal = snapshot.activities.find(({ activityId }) => activityId === 'activity-1');
  assert.equal(terminal, undefined);
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [
    'terminal-private-id',
    'unknown-status-private-id',
    'missing-private-id',
    'bounded-private-id',
    'Private title',
    'Regressive private title',
    'future_status',
    'future_kind',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
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

test('conversation cancels the old permission before opening another Agent', async () => {
  const fixture = makeFixture();
  fixture.host.artifactImpl = async (agentId) => ({
    schemaVersion: 1,
    revision: agentId === 'job-agent' ? 1 : 0,
    artifacts: agentId === 'job-agent'
      ? [{
        artifactId: 'job-report',
        title: 'Job Report',
        kind: 'document',
        sizeBytes: 10,
      }]
      : [],
  });
  await fixture.controller.open('job-agent');
  fixture.host.emit('permission-request', permissionRequest(
    'job-switch-request',
    'Job operation',
  ));
  fixture.host.emitSession('private-session-id', 'tool_call', null, {
    toolCallId: 'private-job-activity',
    title: 'Private Job activity',
    kind: 'search',
    status: 'in_progress',
  });

  const deploySnapshot = await fixture.controller.open('deploy-agent');

  assert.deepEqual(fixture.host.permissionResponses, [{
    requestId: 'job-switch-request',
    optionId: null,
  }]);
  assert.deepEqual(deploySnapshot.activities, []);
  assert.deepEqual(deploySnapshot.artifacts, []);
  fixture.host.emitSession('private-session-id', 'tool_call', null, {
    toolCallId: 'late-private-job-activity',
    title: 'Late private Job activity',
    kind: 'read',
    status: 'completed',
  });
  assert.deepEqual(fixture.controller.getSnapshot().activities, []);
  fixture.host.emit('permission-request', permissionRequest(
    'deploy-request',
    'Deploy operation',
    'private-deploy-session',
  ));
  const snapshot = fixture.controller.getSnapshot();
  assert.equal(snapshot.agentId, 'deploy-agent');
  assert.equal(snapshot.interaction.title, 'Deploy operation');
  assert.equal(
    fixture.host.permissionResponses.some(({ requestId }) => requestId === 'deploy-request'),
    false,
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
  fixture.host.artifactImpl = async () => ({
    schemaVersion: 1,
    revision: 1,
    artifacts: [{
      artifactId: 'exit-report',
      title: 'Exit Report',
      kind: 'document',
      sizeBytes: 10,
    }],
  });
  await fixture.controller.open('job-agent');
  fixture.host.emit('permission-request', permissionRequest('exit-request', 'Exit operation'));
  fixture.host.emitSession('private-session-id', 'tool_call', null, {
    toolCallId: 'private-exit-activity',
    title: 'Private exit activity',
    kind: 'edit',
    status: 'in_progress',
  });

  fixture.host.emit('exit', new Error('private host details'));

  const snapshot = fixture.controller.getSnapshot();
  assert.equal(snapshot.phase, 'error');
  assert.match(snapshot.error, /Host 已断开/);
  assert.equal(snapshot.interaction, undefined);
  assert.deepEqual(snapshot.activities, []);
  assert.deepEqual(snapshot.artifacts, []);
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

test('conversation projects live Harness background tasks without exposing raw task fields', async () => {
  const fixture = makeFixture();
  await fixture.controller.open('job-agent');

  fixture.host.emitSessionMethod('x.ai/task_backgrounded', 'private-session-id', {
    sessionUpdate: 'task_backgrounded',
    tool_call_id: 'private-tool-call',
    task_id: 'private-task-command',
    command: 'curl -H "Authorization: Bearer sk-private" https://private.example',
    cwd: '/private/account-7/job-agent',
    output_file: '/private/account-7/task.log',
    description: 'Deploy private service',
  });
  fixture.host.emitSessionMethod('x.ai/task_backgrounded', 'private-session-id', {
    sessionUpdate: 'task_backgrounded',
    tool_call_id: 'private-monitor-call',
    task_id: 'private-task-monitor',
    command: '[monitor] tail private.log',
    cwd: '/private/account-7/job-agent',
    output_file: '/private/account-7/monitor.log',
    monitor_description: 'Watch private errors',
  });

  assert.deepEqual(fixture.controller.getSnapshot().backgroundTasks, [
    {
      backgroundId: 'background-1',
      kind: 'command',
      status: 'running',
    },
    {
      backgroundId: 'background-2',
      kind: 'monitor',
      status: 'running',
    },
  ]);

  fixture.host.emitSessionMethod('x.ai/task_completed', 'private-session-id', {
    sessionUpdate: 'task_completed',
    task_snapshot: {
      task_id: 'private-task-command',
      command: 'private completed command',
      cwd: '/private/account-7/job-agent',
      output: 'private output',
      output_file: '/private/account-7/task.log',
      exit_code: 0,
      signal: null,
      completed: true,
      kind: 'bash',
      explicitly_killed: false,
    },
    will_wake: false,
  });
  fixture.host.emitSessionMethod('x.ai/task_completed', 'private-session-id', {
    sessionUpdate: 'task_completed',
    task_snapshot: {
      task_id: 'private-task-monitor',
      command: 'private monitor command',
      cwd: '/private/account-7/job-agent',
      output: 'private monitor output',
      output_file: '/private/account-7/monitor.log',
      exit_code: null,
      signal: 'SIGTERM',
      completed: true,
      kind: 'monitor',
      explicitly_killed: true,
    },
    will_wake: false,
  });

  const snapshot = fixture.controller.getSnapshot();
  assert.deepEqual(snapshot.backgroundTasks, [
    {
      backgroundId: 'background-1',
      kind: 'command',
      status: 'completed',
    },
    {
      backgroundId: 'background-2',
      kind: 'monitor',
      status: 'stopped',
    },
  ]);
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [
    'private-task',
    'private-tool-call',
    'private-monitor-call',
    '/private/account-7',
    'sk-private',
    'private.example',
    'private output',
    'Deploy private service',
    'Watch private errors',
    'SIGTERM',
    'exit_code',
    'output_file',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('conversation replays Harness background state and closes cold-start orphans as stopped', async () => {
  const fixture = makeFixture();
  fixture.host.loadImpl = async ({ sessionId }) => {
    fixture.host.emitSessionMethod('x.ai/session/update', sessionId, {
      sessionUpdate: 'task_backgrounded',
      tool_call_id: 'replayed-private-tool-call',
      task_id: 'replayed-private-task',
      command: 'sleep 999 with private args',
      cwd: '/private/replayed/cwd',
      output_file: '/private/replayed/output.log',
    }, { isReplay: true });
    fixture.host.emitSessionMethod('x.ai/task_completed', sessionId, {
      sessionUpdate: 'task_completed',
      task_snapshot: {
        task_id: 'replayed-private-task',
        command: 'sleep 999 with private args',
        cwd: '/private/replayed/cwd',
        output: '',
        output_file: '',
        exit_code: null,
        signal: 'session_restart',
        completed: true,
        kind: 'bash',
        explicitly_killed: false,
      },
      will_wake: false,
    });
    return {};
  };

  const snapshot = await fixture.controller.open('job-agent');

  assert.deepEqual(snapshot.backgroundTasks, [{
    backgroundId: 'background-1',
    kind: 'command',
    status: 'stopped',
  }]);
  assert.equal(JSON.stringify(snapshot).includes('replayed-private'), false);
  assert.equal(JSON.stringify(snapshot).includes('session_restart'), false);
});

test('conversation reconciles missed startup notifications with the Host-owned safe task snapshot', async () => {
  const fixture = makeFixture();
  fixture.host.backgroundActivityImpl = async () => ({
    activities: [
      {
        taskId: 'private-live-task',
        kind: 'monitor',
        status: 'running',
        command: 'must not cross the Host boundary',
        cwd: '/private/cwd',
      },
      {
        taskId: 'private-completed-task',
        kind: 'command',
        status: 'completed',
        output: 'private output',
      },
    ],
  });

  const snapshot = await fixture.controller.open('job-agent');

  assert.deepEqual(snapshot.backgroundTasks, [
    {
      backgroundId: 'background-1',
      kind: 'monitor',
      status: 'running',
    },
    {
      backgroundId: 'background-2',
      kind: 'command',
      status: 'completed',
    },
  ]);
  assert.deepEqual(fixture.host.backgroundActivityCalls, ['job-agent']);
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [
    'private-live-task',
    'private-completed-task',
    'Host boundary',
    '/private/cwd',
    'private output',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('conversation does not stop a concurrent live task merely because it missed one snapshot', async () => {
  const fixture = makeFixture();
  fixture.host.loadImpl = async ({ sessionId }) => {
    fixture.host.emitSessionMethod('x.ai/task_backgrounded', sessionId, {
      sessionUpdate: 'task_backgrounded',
      task_id: 'private-concurrent-live-task',
      command: 'private concurrent command',
      cwd: '/private/concurrent',
      output_file: '/private/concurrent.log',
    });
    return {};
  };

  const snapshot = await fixture.controller.open('job-agent');

  assert.deepEqual(snapshot.backgroundTasks, [{
    backgroundId: 'background-1',
    kind: 'command',
    status: 'running',
  }]);
  assert.equal(JSON.stringify(snapshot).includes('private-concurrent'), false);
});

test('conversation fails a malformed Host background snapshot closed without closing text chat', async () => {
  const fixture = makeFixture();
  fixture.host.backgroundActivityImpl = async () => ({
    activities: [{
      taskId: 'private-invalid-task',
      kind: 'future-kind',
      status: 'running',
      command: 'private invalid command',
    }],
  });

  const snapshot = await fixture.controller.open('job-agent');

  assert.equal(snapshot.phase, 'ready');
  assert.equal(snapshot.backgroundStatus, 'unavailable');
  assert.deepEqual(snapshot.backgroundTasks, []);
  assert.equal(JSON.stringify(snapshot).includes('private-invalid'), false);
});

test('conversation bounds background tasks, freezes terminal state, and clears them with authority', async () => {
  const fixture = makeFixture();
  await fixture.controller.open('job-agent');

  fixture.host.emitSessionMethod('session/update', 'private-session-id', {
    sessionUpdate: 'task_backgrounded',
    task_id: 'wrong-method-private-task',
  });
  fixture.host.emitSessionMethod('x.ai/task_backgrounded', 'another-private-session', {
    sessionUpdate: 'task_backgrounded',
    task_id: 'wrong-session-private-task',
  });
  fixture.host.emitSessionMethod('x.ai/task_completed', 'private-session-id', {
    sessionUpdate: 'task_completed',
    task_snapshot: { task_id: 'unknown-private-task', exit_code: 0 },
  });
  fixture.host.emitSessionMethod('x.ai/task_backgrounded', 'private-session-id', {
    sessionUpdate: 'task_backgrounded',
    task_id: 42,
  });
  assert.deepEqual(fixture.controller.getSnapshot().backgroundTasks, []);

  for (let index = 0; index < 55; index += 1) {
    const taskId = `private-bounded-task-${index}`;
    fixture.host.emitSessionMethod('x.ai/task_backgrounded', 'private-session-id', {
      sessionUpdate: 'task_backgrounded',
      tool_call_id: `private-bounded-call-${index}`,
      task_id: taskId,
      command: `private command ${index}`,
      cwd: '/private/cwd',
      output_file: '/private/output',
      ...(index === 54 ? { monitor_description: 'private monitor' } : {}),
    });
    fixture.host.emitSessionMethod('x.ai/task_completed', 'private-session-id', {
      sessionUpdate: 'task_completed',
      task_snapshot: {
        task_id: taskId,
        exit_code: index % 2 === 0 ? 0 : 1,
        signal: null,
        completed: true,
        kind: index === 54 ? 'monitor' : 'bash',
        explicitly_killed: false,
      },
    });
  }
  fixture.host.emitSessionMethod('x.ai/task_backgrounded', 'private-session-id', {
    sessionUpdate: 'task_backgrounded',
    task_id: 'private-bounded-task-54',
    monitor_description: null,
  });
  fixture.host.emitSessionMethod('x.ai/task_completed', 'private-session-id', {
    sessionUpdate: 'task_completed',
    task_snapshot: {
      task_id: 'private-bounded-task-54',
      exit_code: 1,
      signal: 'late-regression',
      kind: 'bash',
      explicitly_killed: false,
    },
  });

  const snapshot = fixture.controller.getSnapshot();
  assert.equal(snapshot.backgroundTasks.length, 50);
  assert.deepEqual(snapshot.backgroundTasks.at(-1), {
    backgroundId: 'background-55',
    kind: 'monitor',
    status: 'completed',
  });
  assert.equal(
    snapshot.backgroundTasks.some(({ kind, status }) => (
      !['command', 'monitor'].includes(kind)
      || !['running', 'completed', 'failed', 'stopped'].includes(status)
    )),
    false,
  );
  assert.equal(JSON.stringify(snapshot).includes('private-bounded'), false);

  fixture.host.emit('reconnected');
  assert.deepEqual(fixture.controller.getSnapshot().backgroundTasks, []);
});

test('conversation reads the Host-owned canonical Session plan without exposing Todo authority', async () => {
  const fixture = makeFixture();
  fixture.host.sessionPlanImpl = async () => ({
    entries: [
      {
        content: '核对岗位要求',
        status: 'in_progress',
        todoId: 'private-todo-id',
        priority: 'high',
        meta: { apiKey: 'sk-private' },
      },
      {
        content: '输出岗位清单',
        status: 'pending',
      },
    ],
  });

  const snapshot = await fixture.controller.open('job-agent');

  assert.deepEqual(snapshot.planEntries, [
    {
      planId: 'plan-1',
      content: '核对岗位要求',
      status: 'in_progress',
    },
    {
      planId: 'plan-2',
      content: '输出岗位清单',
      status: 'pending',
    },
  ]);
  assert.deepEqual(fixture.host.sessionPlanCalls, ['job-agent']);
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of ['private-todo-id', 'priority', 'meta', 'sk-private']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('conversation treats live ACP Plan as a refresh signal and ignores raw notification content', async () => {
  const fixture = makeFixture();
  await fixture.controller.open('job-agent');
  fixture.host.sessionPlanImpl = async () => ({
    entries: [{
      content: '运行交叉测试',
      status: 'completed',
    }],
  });

  fixture.host.emitSession('private-session-id', 'plan', null, {
    entries: [{
      content: '泄露 /private/account-7 和 sk-private',
      priority: 'high',
      status: 'in_progress',
      meta: { todoId: 'private-plan-id' },
    }],
  });
  await flushAsync();

  const snapshot = fixture.controller.getSnapshot();
  assert.deepEqual(snapshot.planEntries, [{
    planId: 'plan-1',
    content: '运行交叉测试',
    status: 'completed',
  }]);
  assert.deepEqual(fixture.host.sessionPlanCalls, ['job-agent', 'job-agent']);
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of ['/private/account-7', 'sk-private', 'private-plan-id', 'priority']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('conversation coalesces a burst of live Plan signals behind one queued canonical refresh', async () => {
  const fixture = makeFixture();
  await fixture.controller.open('job-agent');
  let resolveFirstRefresh;
  let refreshCount = 0;
  fixture.host.sessionPlanImpl = async () => {
    refreshCount += 1;
    if (refreshCount === 1) {
      return new Promise((resolve) => {
        resolveFirstRefresh = resolve;
      });
    }
    return {
      entries: [{
        content: '合并后的最终计划',
        status: 'in_progress',
      }],
    };
  };

  for (let index = 0; index < 3; index += 1) {
    fixture.host.emitSession('private-session-id', 'plan', null, {
      entries: [{ content: `不可信通知 ${index}`, status: 'completed' }],
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshCount, 1);
  resolveFirstRefresh({
    entries: [{
      content: '可能已过期的第一次刷新',
      status: 'pending',
    }],
  });
  await flushAsync();

  assert.equal(refreshCount, 2);
  assert.deepEqual(fixture.controller.getSnapshot().planEntries, [{
    planId: 'plan-1',
    content: '合并后的最终计划',
    status: 'in_progress',
  }]);
  assert.equal(JSON.stringify(fixture.controller.getSnapshot()).includes('不可信通知'), false);
});

test('conversation ignores replay Plan payloads and reconciles once from canonical Resources', async () => {
  const fixture = makeFixture();
  fixture.host.loadImpl = async ({ sessionId }) => {
    fixture.host.emitSessionMethod('session/update', sessionId, {
      sessionUpdate: 'plan',
      entries: [{
        content: '历史 cosmetic completed',
        priority: 'high',
        status: 'completed',
      }],
    }, { isReplay: true });
    return {};
  };
  fixture.host.sessionPlanImpl = async () => ({
    entries: [{
      content: '仍在执行的真实步骤',
      status: 'in_progress',
    }],
  });

  const snapshot = await fixture.controller.open('job-agent');

  assert.deepEqual(snapshot.planEntries, [{
    planId: 'plan-1',
    content: '仍在执行的真实步骤',
    status: 'in_progress',
  }]);
  assert.deepEqual(fixture.host.sessionPlanCalls, ['job-agent']);
  assert.equal(JSON.stringify(snapshot).includes('cosmetic'), false);
});

test('conversation bounds and validates Session plan snapshots without closing text chat', async () => {
  const fixture = makeFixture();
  fixture.host.sessionPlanImpl = async () => ({
    entries: [{
      content: 'Private\u0085Plan',
      status: 'pending',
      todoId: 'private-invalid-plan',
    }],
  });

  const snapshot = await fixture.controller.open('job-agent');

  assert.equal(snapshot.phase, 'ready');
  assert.equal(snapshot.planStatus, 'unavailable');
  assert.deepEqual(snapshot.planEntries, []);
  assert.equal(JSON.stringify(snapshot).includes('private-invalid-plan'), false);

  fixture.host.emit('reconnected');
  assert.deepEqual(fixture.controller.getSnapshot().planEntries, []);
  assert.equal(fixture.controller.getSnapshot().planStatus, 'ready');
});

test('conversation sends structured attachment prompts, supports attachment-only turns, and consumes drafts on success', async () => {
  const attachmentId = 'attachment-11111111-1111-4111-8111-111111111111';
  const records = new Map([[
    attachmentId,
    {
      attachmentId,
      kind: 'image',
      name: 'screen.png',
      mimeType: 'image/png',
      sizeBytes: 16,
    },
  ]]);
  const preparedPrompt = [
    { type: 'text', text: '请查看我附加的内容。\n\n[本条消息附带内容]\n- 图片：screen.png' },
    { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
  ];
  const attachmentStore = {
    prepareCalls: [],
    consumeCalls: [],
    list: () => [...records.values()].map((record) => ({ ...record })),
    async preparePrompt(request) {
      this.prepareCalls.push(request);
      return { prompt: preparedPrompt, attachmentIds: request.attachmentIds };
    },
    async consume(request) {
      this.consumeCalls.push(request);
      request.attachmentIds.forEach((id) => records.delete(id));
    },
    async clearAccount() {},
  };
  const fixture = makeFixture({ attachmentStore });
  const opened = await fixture.controller.open('job-agent');
  assert.deepEqual(opened.draftAttachments, [...records.values()]);
  fixture.host.promptImpl = async (request) => {
    assert.equal(request.sessionId, 'private-session-id');
    assert.equal(request.text, '');
    assert.equal(request.prompt, preparedPrompt);
    return { stopReason: 'end_turn' };
  };

  const sent = await fixture.controller.send({ text: '', attachmentIds: [attachmentId] });

  assert.equal(sent.phase, 'ready');
  assert.deepEqual(sent.draftAttachments, []);
  assert.deepEqual(attachmentStore.prepareCalls, [{
    accountId: 7,
    agentId: 'job-agent',
    text: '',
    attachmentIds: [attachmentId],
  }]);
  assert.equal(attachmentStore.consumeCalls.length, 1);
  assert.equal(JSON.stringify(sent).includes('iVBORw0KGgo'), false);
});

test('conversation keeps staged attachments and a retryable snapshot when structured prompt delivery fails', async () => {
  const attachmentId = 'attachment-22222222-2222-4222-8222-222222222222';
  const record = {
    attachmentId,
    kind: 'file',
    name: 'brief.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 4_096,
  };
  let consumed = false;
  const attachmentStore = {
    list: () => consumed ? [] : [{ ...record }],
    async preparePrompt({ attachmentIds }) {
      return {
        prompt: [
          { type: 'text', text: '分析这个文件' },
          {
            type: 'resource',
            resource: {
              uri: 'file:///agentmesh360-attachment/brief.pdf',
              mimeType: 'application/pdf',
              blob: 'JVBERg==',
            },
          },
        ],
        attachmentIds,
      };
    },
    async consume() { consumed = true; },
    async clearAccount() {},
  };
  const fixture = makeFixture({ attachmentStore });
  await fixture.controller.open('job-agent');
  fixture.host.promptImpl = async () => {
    throw Object.assign(new Error('provider rejected vision'), { code: 'provider_error' });
  };

  const failed = await fixture.controller.send({
    text: '分析这个文件',
    attachmentIds: [attachmentId],
  });

  assert.equal(failed.phase, 'ready');
  assert.equal(failed.streaming, false);
  assert.match(failed.error, /包含附件/u);
  assert.deepEqual(failed.draftAttachments, [record]);
  assert.equal(consumed, false);
  assert.equal(JSON.stringify(failed).includes('JVBERg'), false);
});

function permissionRequest(requestId, title, sessionId = 'private-session-id') {
  return {
    requestId,
    sessionId,
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

function makeFixture({ attachmentStore = null } = {}) {
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
    interjectCalls: [],
    artifactCalls: [],
    projectStateCalls: [],
    backgroundActivityCalls: [],
    sessionPlanCalls: [],
    permissionResponses: [],
    loadImpl: async () => ({}),
    promptImpl: async () => ({ stopReason: 'end_turn' }),
    interjectImpl: async () => ({ status: 'queued' }),
    artifactImpl: async () => ({
      schemaVersion: 1,
      revision: 0,
      artifacts: [],
    }),
    projectStateImpl: async () => ({
      schemaVersion: 1,
      revision: 0,
      project: null,
    }),
    backgroundActivityImpl: async () => ({ activities: [] }),
    sessionPlanImpl: async () => ({ entries: [] }),
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
    async interjectSession(request) {
      this.interjectCalls.push(request);
      return this.interjectImpl(request);
    },
    async listWorkspaceArtifacts(agentId) {
      this.artifactCalls.push(agentId);
      return this.artifactImpl(agentId);
    },
    async getWorkspaceProjectState(agentId) {
      this.projectStateCalls.push(agentId);
      return this.projectStateImpl(agentId);
    },
    async listAgentBackgroundActivities(agentId) {
      this.backgroundActivityCalls.push(agentId);
      return this.backgroundActivityImpl(agentId);
    },
    async getAgentSessionPlan(agentId) {
      this.sessionPlanCalls.push(agentId);
      return this.sessionPlanImpl(agentId);
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
      this.emitSessionMethod('session/update', sessionId, update);
    },
    emitSessionMethod(method, sessionId, update, meta = {}) {
      this.emit('notification', {
        jsonrpc: '2.0',
        method,
        params: {
          sessionId,
          update,
          _meta: { rawPrivateMetadata: 'do-not-project', ...meta },
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
    attachmentStore,
  });
  return fixture;
}

async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
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
