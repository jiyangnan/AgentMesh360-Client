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
const { AgentManagementController } = require('../src/agent-management-controller');
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

test('real Grok Host fails closed instead of duplicating a product session across workspaces', {
  skip: !hostBinary ? 'set AGENTMESH360_REAL_HOST_BIN to run the real Host workspace isolation test' : false,
  timeout: 45000,
}, async () => {
  const accountId = 41;
  const server = http.createServer((request, response) => {
    if (request.url !== '/v1/account/client-bootstrap') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(bootstrapFixture(true, accountId)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh360-session-isolation-'));
  const grokHome = path.join(home, '.grok');
  const firstStateHome = path.join(home, 'first-state');
  const secondStateHome = path.join(home, 'second-state');
  const clientFor = (stateHome) => new AcpHostClient({
    command: hostBinary,
    env: {
      ...process.env,
      HOME: home,
      GROK_HOME: grokHome,
      AGENTMESH360_HOME: stateHome,
      AGENTMESH360_HOST_MODE: 'embedded',
      AGENTMESH360_CORE_URL: `http://127.0.0.1:${port}`,
    },
    requestTimeoutMs: 15000,
    sessionLoadTimeoutMs: 30000,
  });
  let firstClient = null;
  let secondClient = null;

  try {
    firstClient = clientFor(firstStateHome);
    await firstClient.bootstrap('first-isolated-client-token');
    const firstActivation = await firstClient.activateAgent('job-agent');
    const firstAgent = firstActivation.agent;
    await firstClient.loadSession({
      sessionId: firstAgent.mainSessionId,
      cwd: firstAgent.workspaceDir,
    });
    await firstClient.stop();
    firstClient = null;

    secondClient = clientFor(secondStateHome);
    await secondClient.bootstrap('second-isolated-client-token');
    await assert.rejects(
      () => secondClient.activateAgent('job-agent'),
      /workspace conflict/i,
    );
    const secondAgent = (await secondClient.listAgents()).agents.find(
      (agent) => agent.agentId === 'job-agent',
    );

    assert.equal(secondAgent.mainSessionId, firstAgent.mainSessionId);
    assert.notEqual(secondAgent.workspaceDir, firstAgent.workspaceDir);
    assert.equal(secondAgent.runtimeState, 'error');
    assert.equal(
      findDirectoriesNamed(path.join(grokHome, 'sessions'), firstAgent.mainSessionId).length,
      1,
      'one stable product session id must never be persisted in two workspaces',
    );
  } finally {
    await secondClient?.stop().catch(() => {});
    await firstClient?.stop().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('real controllers save the first Agent model, bind its canonical Session, and open it without Provider access', {
  skip: !hostBinary ? 'set AGENTMESH360_REAL_HOST_BIN to run the real Host Agent journey test' : false,
  timeout: 45000,
}, async () => {
  const accountId = 51;
  const server = http.createServer((request, response) => {
    if (request.url !== '/v1/account/client-bootstrap') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(bootstrapFixture(true, accountId)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh360-agent-journey-'));
  const stateHome = path.join(home, 'state');
  const grokHome = path.join(home, 'grok');
  const env = {
    ...process.env,
    HOME: home,
    GROK_HOME: grokHome,
    AGENTMESH360_HOME: stateHome,
    XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'xdg-state'),
    AGENTMESH360_HOST_MODE: 'embedded',
    AGENTMESH360_CORE_URL: `http://127.0.0.1:${port}`,
  };
  let setupClient = null;
  let client = null;
  let conversation = null;

  try {
    setupClient = new AcpHostClient({
      command: hostBinary,
      env,
      requestTimeoutMs: 15000,
      sessionLoadTimeoutMs: 30000,
    });
    await setupClient.bootstrap('agent-journey-setup-token');
    const activated = await setupClient.activateAgent('job-agent');
    const canonical = {
      sessionId: activated.agent.mainSessionId,
      cwd: activated.agent.workspaceDir,
    };
    assert.ok(canonical.sessionId);
    assert.ok(canonical.cwd.startsWith(stateHome));
    await setupClient.loadSession(canonical);
    assert.deepEqual(
      (await setupClient.getSessionBindingHistory({
        sessionId: canonical.sessionId,
        role: 'main',
        agentId: 'job-agent',
      })).bindings,
      [],
      'a newly activated Agent starts without a model binding',
    );
    await setupClient.stop();
    setupClient = null;

    insertIsolatedProviderProfile(stateHome, accountId);

    client = new AcpHostClient({
      command: hostBinary,
      env,
      requestTimeoutMs: 15000,
      sessionLoadTimeoutMs: 30000,
    });
    await client.bootstrap('agent-journey-runtime-token');
    const hostAgent = (await client.listAgents()).agents.find(
      (agent) => agent.agentId === 'job-agent',
    );
    assert.deepEqual(
      {
        sessionId: hostAgent.mainSessionId,
        cwd: hostAgent.workspaceDir,
      },
      canonical,
      'the restarted Host must keep the Registry canonical Main Session',
    );
    const identity = Object.assign(new EventEmitter(), {
      state: {
        phase: 'ready',
        account: { id: accountId },
        access: { canEnterClient: true },
        agents: [{
          agentId: hostAgent.agentId,
          displayName: hostAgent.displayName,
          description: hostAgent.description,
        }],
      },
      getState() { return this.state; },
      subscribe(listener) {
        this.on('state', listener);
        listener(this.state);
        return () => this.off('state', listener);
      },
    });
    const loadRequests = [];
    const realLoadSession = client.loadSession.bind(client);
    client.loadSession = async (request) => {
      loadRequests.push({ ...request });
      return realLoadSession(request);
    };
    client.promptSession = async () => {
      throw new Error('the save-and-open regression must never send a Provider request');
    };
    const management = new AgentManagementController({ identity, host: client });
    conversation = new AgentConversationController({
      identity,
      host: client,
      activateAgent: async (agentId) => {
        await client.activateAgent(agentId);
        return identity.getState();
      },
    });

    const saved = await management.saveModel(
      'job-agent',
      'pp_glm_isolated',
      'glm-5.2',
    );

    assert.equal(saved.bindingIssue, null);
    assert.equal(saved.modelBinding.scopeKind, 'agent');
    assert.equal(saved.modelBinding.scopeId, 'job-agent');
    assert.equal(saved.modelBinding.role, 'main');
    assert.equal(saved.modelBinding.providerProfileId, 'pp_glm_isolated');
    assert.equal(saved.modelBinding.modelId, 'glm-5.2');
    const history = await client.getSessionBindingHistory({
      sessionId: canonical.sessionId,
      role: 'main',
      agentId: 'job-agent',
    });
    assert.equal(history.bindings.length, 1);
    assert.equal(history.bindings[0].changeReason, 'initial');
    assert.equal(history.bindings[0].sessionId, canonical.sessionId);
    assert.equal(history.bindings[0].agentId, 'job-agent');
    assert.equal(history.bindings[0].route.providerProfileId, 'pp_glm_isolated');
    assert.equal(history.bindings[0].route.modelId, 'glm-5.2');

    const opened = await conversation.open('job-agent');

    assert.equal(opened.phase, 'ready');
    assert.equal(opened.agentId, 'job-agent');
    assert.equal(opened.error, null);
    assert.deepEqual(
      loadRequests.at(-1),
      canonical,
      'ConversationController must load the same canonical Session and workspace',
    );
    assert.deepEqual(opened.messages, []);
  } finally {
    conversation?.dispose();
    await client?.stop().catch(() => {});
    await setupClient?.stop().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
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
    const resumedActivation = await secondClient.activateAgent('job-agent');
    assert.equal(resumedActivation.resumed, true);
    assert.equal(resumedActivation.agent.mainSessionId, sessionId);
    assert.equal(resumedActivation.agent.workspaceDir, workspaceDir);
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

function findDirectoriesNamed(root, targetName, matches = []) {
  if (!fs.existsSync(root)) return matches;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name);
    if (entry.name === targetName) matches.push(candidate);
    findDirectoriesNamed(candidate, targetName, matches);
  }
  return matches;
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

function insertIsolatedProviderProfile(stateHome, ownerAccountId) {
  const database = path.join(stateHome, 'state.db');
  const sql = `
    PRAGMA foreign_keys = ON;
    INSERT INTO provider_profiles (
      profile_id, owner_account_id, preset_id, display_name, protocol, base_url,
      auth_kind, credential_ref, credential_last_four, enabled_models_json,
      route_revision, created_at, updated_at
    ) VALUES (
      'pp_glm_isolated', ${Number(ownerAccountId)}, 'glm-coding-plan',
      'Isolated GLM Coding Plan', 'openai_chat',
      'https://open.bigmodel.cn/api/coding/paas/v4', 'bearer_api_key',
      'credential://vault/h_00000000000000000000000000000051', 'none',
      '["glm-5.2"]', 1, '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z'
    );
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
