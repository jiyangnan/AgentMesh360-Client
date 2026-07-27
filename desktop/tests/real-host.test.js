'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { AcpHostClient, HostRequestError } = require('../src/host/acp-client');

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
    }
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
