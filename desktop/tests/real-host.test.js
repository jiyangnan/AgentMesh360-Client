'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { AcpHostClient, HostRequestError } = require('../src/host/acp-client');
const { AgentConversationController } = require('../src/conversation-controller');

const hostBinary = process.env.AGENTMESH360_REAL_HOST_BIN;

test('real Grok Host enforces active and expired subscription states over ACP', {
  skip: !hostBinary ? 'set AGENTMESH360_REAL_HOST_BIN to run the real Host contract test' : false,
  timeout: 30000,
}, async () => {
  let canEnter = true;
  let accountId = 11;
  const server = http.createServer((request, response) => {
    if (request.url !== '/v1/account/client-bootstrap') {
      response.writeHead(404).end();
      return;
    }
    const payload = bootstrapFixture(canEnter, accountId);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh360-real-host-'));
  const stateHome = path.join(home, '.agentmesh360');
  const legacySessionId = '11111111-1111-1111-1111-111111111111';
  initializeLegacyState(stateHome, legacySessionId);
  const client = new AcpHostClient({
    command: hostBinary,
    env: {
      ...process.env,
      HOME: home,
      AGENTMESH360_HOME: stateHome,
      AGENTMESH360_HOST_MODE: 'embedded',
      AGENTMESH360_CORE_URL: `http://127.0.0.1:${port}`,
    },
    requestTimeoutMs: 15000,
  });

  try {
    const allowed = await client.bootstrap('integration-access-token');
    assert.equal(allowed.access.canEnterClient, true);
    const list = await client.listAgents();
    assert.deepEqual(list.agents.map((agent) => agent.agentId), [
      'job-agent',
      'lecturecast-agent',
      'deploy-agent',
    ]);
    assert.equal(list.agents[0].mainSessionId, legacySessionId);
    const firstAccountSessions = new Set([legacySessionId]);
    let artifactAgent;
    for (const agentId of ['lecturecast-agent', 'deploy-agent']) {
      const activated = await client.activateAgent(agentId);
      assert.equal(activated.agent.agentId, agentId);
      assert.ok(activated.agent.mainSessionId);
      assert.equal(firstAccountSessions.has(activated.agent.mainSessionId), false);
      firstAccountSessions.add(activated.agent.mainSessionId);
      await client.loadSession({
        sessionId: activated.agent.mainSessionId,
        cwd: activated.agent.workspaceDir,
      });
      if (agentId === 'lecturecast-agent') artifactAgent = activated.agent;
    }
    writeArtifactManifest(artifactAgent.workspaceDir);
    writeProjectStateManifest(artifactAgent.workspaceDir);
    const artifacts = await client.listWorkspaceArtifacts('lecturecast-agent');
    assert.deepEqual(artifacts, {
      schemaVersion: 1,
      revision: 1,
      artifacts: [{
        artifactId: 'lesson-audio',
        title: '课程音频',
        kind: 'audio',
        sizeBytes: 11,
      }],
    });
    const serializedArtifacts = JSON.stringify(artifacts);
    assert.equal(serializedArtifacts.includes('relativePath'), false);
    assert.equal(serializedArtifacts.includes(artifactAgent.workspaceDir), false);
    const projectState = await client.getWorkspaceProjectState('lecturecast-agent');
    assert.deepEqual(projectState, {
      schemaVersion: 1,
      revision: 3,
      project: {
        title: '函数课程',
        status: 'active',
        summary: '正在生成课程音频并校验证据。',
        steps: [{
          stepId: 'generate-audio',
          label: '生成课程音频',
          status: 'in_progress',
        }],
      },
    });
    const serializedProjectState = JSON.stringify(projectState);
    assert.equal(serializedProjectState.includes('workspaceDir'), false);
    assert.equal(serializedProjectState.includes('nextCommand'), false);
    assert.deepEqual(
      await client.listAgentBackgroundActivities('lecturecast-agent'),
      { activities: [] },
    );
    assert.deepEqual(
      await client.getAgentSessionPlan('lecturecast-agent'),
      { entries: [] },
    );
    const emptyBindingHistory = await client.getSessionBindingHistory({
      sessionId: legacySessionId,
      role: 'main',
      agentId: 'job-agent',
    });
    assert.deepEqual(emptyBindingHistory.bindings, []);
    const emptyTurnRoutes = await client.listTurnRoutes({
      sessionId: legacySessionId,
      role: 'main',
      agentId: 'job-agent',
    });
    assert.deepEqual(emptyTurnRoutes.turnRoutes, []);
    const catalog = await client.getProviderCatalog();
    assert.equal(catalog.catalog.schemaVersion, 1);
    assert.deepEqual(
      catalog.catalog.providers.slice(0, 3).map((provider) => provider.presetId),
      ['openai', 'xai', 'anthropic'],
    );
    const assignments = await client.listModelAssignments();
    assert.deepEqual(assignments.assignments, []);
    accountId = 12;
    const secondAccount = await client.bootstrap('second-account-token');
    assert.equal(secondAccount.account.accountId, 12);
    const secondAccountList = await client.listAgents();
    const secondAccountJob = secondAccountList.agents.find((agent) => agent.agentId === 'job-agent');
    assert.equal(secondAccountJob.desiredState, 'inactive');
    assert.equal(secondAccountJob.mainSessionId, null);
    const secondAccountActivation = await client.activateAgent('job-agent');
    const secondAccountSessionId = secondAccountActivation.agent.mainSessionId;
    const secondAccountWorkspace = secondAccountActivation.agent.workspaceDir;
    assert.ok(secondAccountSessionId);
    await client.loadSession({
      sessionId: secondAccountSessionId,
      cwd: secondAccountWorkspace,
    });
    await assert.rejects(
      client.listWorkspaceArtifacts('lecturecast-agent'),
      (error) => error instanceof HostRequestError && error.code === 'host_extension_failed',
    );
    await assert.rejects(
      client.getWorkspaceProjectState('lecturecast-agent'),
      (error) => error instanceof HostRequestError && error.code === 'host_extension_failed',
    );
    await assert.rejects(
      client.listAgentBackgroundActivities('lecturecast-agent'),
      (error) => error instanceof HostRequestError && error.code === 'host_extension_failed',
    );
    await assert.rejects(
      client.getAgentSessionPlan('lecturecast-agent'),
      (error) => error instanceof HostRequestError && error.code === 'host_extension_failed',
    );
    await assert.rejects(
      client.getSessionBindingHistory({
        sessionId: legacySessionId,
        role: 'main',
        agentId: 'job-agent',
      }),
      (error) => error instanceof HostRequestError && error.code === 'host_request_failed',
    );

    accountId = 11;
    await client.bootstrap('integration-access-token');
    const restoredFirstAccount = await client.listAgents();
    const restoredJob = restoredFirstAccount.agents.find((agent) => agent.agentId === 'job-agent');
    assert.equal(restoredJob.mainSessionId, legacySessionId);
    assert.equal(
      (await client.listWorkspaceArtifacts('lecturecast-agent')).artifacts[0].artifactId,
      'lesson-audio',
    );
    assert.equal(
      (await client.getWorkspaceProjectState('lecturecast-agent')).project.title,
      '函数课程',
    );
    assert.deepEqual(
      await client.listAgentBackgroundActivities('lecturecast-agent'),
      { activities: [] },
    );
    assert.deepEqual(
      await client.getAgentSessionPlan('lecturecast-agent'),
      { entries: [] },
    );
    await assert.rejects(
      client.loadSession({
        sessionId: secondAccountSessionId,
        cwd: secondAccountWorkspace,
      }),
      (error) => error instanceof HostRequestError && error.code === 'host_request_failed',
    );

    canEnter = false;
    const denied = await client.bootstrap('integration-access-token');
    assert.equal(denied.access.canEnterClient, false);
    await assert.rejects(
      client.listAgents(),
      (error) => error instanceof HostRequestError && error.code === 'host_request_failed',
    );
    await assert.rejects(
      client.getProviderCatalog(),
      (error) => error instanceof HostRequestError && error.code === 'host_request_failed',
    );
    await assert.rejects(
      client.listWorkspaceArtifacts('lecturecast-agent'),
      (error) => error instanceof HostRequestError && error.code === 'host_request_failed',
    );
    await assert.rejects(
      client.getWorkspaceProjectState('lecturecast-agent'),
      (error) => error instanceof HostRequestError && error.code === 'host_request_failed',
    );
    await assert.rejects(
      client.listAgentBackgroundActivities('lecturecast-agent'),
      (error) => error instanceof HostRequestError && error.code === 'host_request_failed',
    );
    await assert.rejects(
      client.getAgentSessionPlan('lecturecast-agent'),
      (error) => error instanceof HostRequestError && error.code === 'host_request_failed',
    );
    await assert.rejects(
      client.getSessionBindingHistory({
        sessionId: legacySessionId,
        role: 'main',
        agentId: 'job-agent',
      }),
      (error) => error instanceof HostRequestError && error.code === 'host_request_failed',
    );
    await assert.rejects(
      client.promptSession({
        sessionId: secondAccountSessionId,
        text: 'must fail before Provider routing',
      }),
      (error) => error instanceof HostRequestError && error.code === 'host_request_failed',
    );
  } finally {
    await client.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('real Grok Host restores canonical Session plan and closes cold-start background tasks safely', {
  skip: !hostBinary ? 'set AGENTMESH360_REAL_HOST_BIN to run the real Host background replay test' : false,
  timeout: 45000,
}, async () => {
  const server = http.createServer((request, response) => {
    if (request.url !== '/v1/account/client-bootstrap') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(bootstrapFixture(true, 31)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh360-background-host-'));
  const stateHome = path.join(home, '.agentmesh360');
  const grokHome = path.join(home, '.grok');
  const env = {
    ...process.env,
    HOME: home,
    GROK_HOME: grokHome,
    AGENTMESH360_HOME: stateHome,
    AGENTMESH360_HOST_MODE: 'embedded',
    AGENTMESH360_CORE_URL: `http://127.0.0.1:${port}`,
  };
  let firstClient = null;
  let secondClient = null;
  let controller = null;

  try {
    firstClient = new AcpHostClient({
      command: hostBinary,
      env,
      requestTimeoutMs: 15000,
    });
    await firstClient.bootstrap('background-first-token');
    const activation = await firstClient.activateAgent('job-agent');
    const { mainSessionId: sessionId, workspaceDir } = activation.agent;
    assert.ok(sessionId);
    await firstClient.loadSession({ sessionId, cwd: workspaceDir });
    await firstClient.stop();
    firstClient = null;

    const sessionDir = findDirectoryNamed(path.join(grokHome, 'sessions'), sessionId);
    assert.ok(sessionDir, 'real Host must persist the activated Main Session');
    const updatesPath = path.join(sessionDir, 'updates.jsonl');
    fs.appendFileSync(updatesPath, `${JSON.stringify({
      timestamp: 1,
      method: '_x.ai/session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'task_backgrounded',
          tool_call_id: 'private-real-tool-call',
          task_id: 'private-real-background-task',
          command: 'curl -H "Authorization: Bearer sk-private" https://private.example',
          cwd: '/private/real/workspace',
          output_file: '/private/real/task.log',
          monitor_description: null,
          description: 'Private real background operation',
        },
      },
    })}\n`);
    fs.writeFileSync(path.join(sessionDir, 'resources_state.json'), JSON.stringify({
      state: {
        'grok_build.Todo': {
          todos: {
            'private-real-todo-id': {
              content: '核对恢复后的 Session 计划',
              priority: 'high',
              status: 'in_progress',
              meta: {
                apiKey: 'sk-private-plan',
                workspaceDir: '/private/plan/workspace',
              },
            },
          },
        },
      },
    }));

    secondClient = new AcpHostClient({
      command: hostBinary,
      env,
      requestTimeoutMs: 15000,
    });
    await secondClient.bootstrap('background-second-token');
    const agents = (await secondClient.listAgents()).agents.map((agent) => ({
      agentId: agent.agentId,
      displayName: agent.displayName,
      description: agent.description,
    }));
    const identity = Object.assign(new EventEmitter(), {
      state: {
        phase: 'ready',
        account: { id: 31 },
        access: { canEnterClient: true },
        agents,
      },
      getState() { return this.state; },
      subscribe(listener) {
        this.on('state', listener);
        listener(this.state);
        return () => this.off('state', listener);
      },
    });
    controller = new AgentConversationController({
      identity,
      host: secondClient,
      activateAgent: async () => identity.getState(),
    });

    const snapshot = await controller.open('job-agent');

    assert.deepEqual(snapshot.backgroundTasks, [{
      backgroundId: 'background-1',
      kind: 'command',
      status: 'stopped',
    }]);
    assert.deepEqual(snapshot.planEntries, [{
      planId: 'plan-1',
      content: '核对恢复后的 Session 计划',
      status: 'in_progress',
    }]);
    assert.equal(snapshot.planStatus, 'ready');
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of [
      'private-real',
      'sk-private',
      '/private/plan/workspace',
      'priority',
      'meta',
      'private.example',
      'session_restart',
      sessionId,
      workspaceDir,
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    controller?.dispose();
    await secondClient?.stop().catch(() => {});
    await firstClient?.stop().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function findDirectoryNamed(root, targetName) {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name);
    if (entry.name === targetName) return candidate;
    const nested = findDirectoryNamed(candidate, targetName);
    if (nested) return nested;
  }
  return null;
}

function writeArtifactManifest(workspaceDir) {
  const controlDir = path.join(workspaceDir, '.agentmesh360');
  const artifactsDir = path.join(workspaceDir, 'artifacts');
  fs.mkdirSync(controlDir, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.writeFileSync(path.join(artifactsDir, 'lesson.mp3'), 'audio-bytes');
  fs.writeFileSync(path.join(controlDir, 'artifacts-v1.json'), JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    artifacts: [{
      artifactId: 'lesson-audio',
      title: '课程音频',
      kind: 'audio',
      relativePath: 'artifacts/lesson.mp3',
    }],
  }));
}

function writeProjectStateManifest(workspaceDir) {
  const controlDir = path.join(workspaceDir, '.agentmesh360');
  fs.mkdirSync(controlDir, { recursive: true });
  fs.writeFileSync(path.join(controlDir, 'project-state-v1.json'), JSON.stringify({
    schemaVersion: 1,
    revision: 3,
    project: {
      title: '函数课程',
      status: 'active',
      summary: '正在生成课程音频并校验证据。',
      steps: [{
        stepId: 'generate-audio',
        label: '生成课程音频',
        status: 'in_progress',
      }],
    },
  }));
}

function initializeLegacyState(stateHome, sessionId) {
  fs.mkdirSync(stateHome, { recursive: true });
  const database = path.join(stateHome, 'state.db');
  const sql = `
    CREATE TABLE product_agents (
      agent_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      description TEXT NOT NULL,
      version TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      desired_state TEXT NOT NULL,
      runtime_state TEXT NOT NULL,
      main_session_id TEXT UNIQUE,
      workspace_dir TEXT,
      activated_at TEXT,
      updated_at TEXT NOT NULL,
      last_error TEXT
    );
    INSERT INTO product_agents (
      agent_id, display_name, description, version, sort_order, desired_state,
      runtime_state, main_session_id, workspace_dir, updated_at
    ) VALUES (
      'job-agent', 'Job Agent', 'Legacy', '0.1.0', 10, 'inactive', 'available',
      '${sessionId}', '/legacy/workspace', '2026-07-22T00:00:00Z'
    );
    PRAGMA user_version = 3;
  `;
  execFileSync('/usr/bin/sqlite3', [database, sql]);
}

function bootstrapFixture(canEnter, accountId) {
  return {
    schema_version: 1,
    server_time: '2026-07-22T04:00:00Z',
    account: {
      id: 7,
      email: 'integration@example.com',
      account_id: accountId,
      display_name: 'Integration',
      avatar_url: null,
    },
    subscription: {
      status: canEnter ? 'active' : 'expired',
      source: 'integration_test',
      plan: 'pro',
      period_start: '2026-07-01 00:00:00',
      period_end: canEnter ? '2026-08-22 00:00:00' : '2026-07-21 00:00:00',
      auto_renews: canEnter,
    },
    credits: { balance: 0, source: 'integration_test', expires_at: null },
    access: {
      can_enter_client: canEnter,
      reason: canEnter ? 'subscription_active' : 'subscription_expired',
    },
  };
}
