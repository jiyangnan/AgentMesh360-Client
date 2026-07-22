'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { AcpHostClient, HostRequestError } = require('../src/host/acp-client');

const hostBinary = process.env.AGENTMESH360_REAL_HOST_BIN;

test('real Grok Host enforces active and expired subscription states over ACP', {
  skip: !hostBinary ? 'set AGENTMESH360_REAL_HOST_BIN to run the real Host contract test' : false,
  timeout: 30000,
}, async () => {
  let canEnter = true;
  const server = http.createServer((request, response) => {
    if (request.url !== '/v1/account/client-bootstrap') {
      response.writeHead(404).end();
      return;
    }
    const payload = bootstrapFixture(canEnter);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh360-real-host-'));
  const client = new AcpHostClient({
    command: hostBinary,
    env: {
      ...process.env,
      HOME: home,
      AGENTMESH360_HOME: path.join(home, '.agentmesh360'),
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
    const catalog = await client.getProviderCatalog();
    assert.equal(catalog.catalog.schemaVersion, 1);
    assert.deepEqual(
      catalog.catalog.providers.slice(0, 3).map((provider) => provider.presetId),
      ['openai', 'xai', 'anthropic'],
    );
    const assignments = await client.listModelAssignments();
    assert.deepEqual(assignments.assignments, []);

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
  } finally {
    await client.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

function bootstrapFixture(canEnter) {
  return {
    schema_version: 1,
    server_time: '2026-07-22T04:00:00Z',
    account: {
      id: 7,
      email: 'integration@example.com',
      account_id: 11,
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
