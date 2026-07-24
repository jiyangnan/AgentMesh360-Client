'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { AcpHostClient } = require('../src/host/acp-client');

const hostBinary = process.env.AGENTMESH360_REAL_HOST_BIN;

test('persistent Grok Host survives desktop detach and restores the same product Agent', {
  skip: !hostBinary ? 'set AGENTMESH360_REAL_HOST_BIN to run the persistent Host lifecycle test' : false,
  timeout: 60000,
}, async () => {
  const server = http.createServer((request, response) => {
    if (request.url !== '/v1/account/client-bootstrap') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(bootstrapFixture()));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const home = fs.mkdtempSync('/tmp/am360-leader-');
  const stateHome = path.join(home, '.agentmesh360');
  const socketPath = path.join(stateHome, 'run', 'host.sock');
  const lockPath = path.join(stateHome, 'run', 'host.lock');
  const env = {
    ...process.env,
    HOME: home,
    GROK_HOME: path.join(home, '.grok'),
    AGENTMESH360_HOME: stateHome,
    AGENTMESH360_HOST_MODE: 'persistent_leader',
    AGENTMESH360_HOST_SOCKET: socketPath,
    AGENTMESH360_CORE_URL: `http://127.0.0.1:${port}`,
  };
  let firstClient = null;
  let secondClient = null;
  let leaderPid = null;
  const bridgeStderr = [];
  const spawnWithDiagnostics = (command, args, options) => {
    const child = spawn(command, args, options);
    child.stderr?.on('data', (chunk) => bridgeStderr.push(chunk.toString()));
    return child;
  };

  try {
    firstClient = new AcpHostClient({
      command: hostBinary,
      env,
      spawnImpl: spawnWithDiagnostics,
      requestTimeoutMs: 20000,
    });
    const allowed = await firstClient.bootstrap('persistent-host-access-token');
    assert.equal(allowed.access.canEnterClient, true);
    const activated = await firstClient.activateAgent('job-agent');
    const sessionId = activated.agent.mainSessionId;
    assert.ok(sessionId);

    leaderPid = await waitForLeaderPid(lockPath);
    assert.equal(isProcessAlive(leaderPid), true);
    assert.equal(firstClient.getRuntimeStatus().bridgeState, 'connected');

    await firstClient.stop();
    assert.equal(firstClient.getRuntimeStatus().bridgeState, 'detached');
    assert.equal(isProcessAlive(leaderPid), true);

    secondClient = new AcpHostClient({
      command: hostBinary,
      env,
      spawnImpl: spawnWithDiagnostics,
      requestTimeoutMs: 20000,
    });
    await secondClient.bootstrap('persistent-host-access-token');
    const list = await secondClient.listAgents();
    const jobAgent = list.agents.find((agent) => agent.agentId === 'job-agent');

    assert.equal(jobAgent.mainSessionId, sessionId);
    assert.equal(Number(fs.readFileSync(lockPath, 'utf8').trim()), leaderPid);
    assert.equal(secondClient.getRuntimeStatus().bridgeState, 'connected');
  } catch (error) {
    const leaderLogPath = path.join(home, '.grok', 'leader.log');
    const leaderLog = fs.existsSync(leaderLogPath)
      ? fs.readFileSync(leaderLogPath, 'utf8')
      : 'leader.log 不存在';
    error.message = `${error.message}\nbridge stderr:\n${bridgeStderr.join('').slice(-4000)}\nleader log:\n${leaderLog.slice(-4000)}`;
    throw error;
  } finally {
    await secondClient?.stop().catch(() => {});
    await firstClient?.stop().catch(() => {});
    const cleanupPid = leaderPid || readLeaderPid(lockPath);
    if (cleanupPid && isProcessAlive(cleanupPid)) {
      process.kill(cleanupPid, 'SIGTERM');
      try {
        await waitForProcessExit(cleanupPid);
      } catch {
        process.kill(cleanupPid, 'SIGKILL');
        await waitForProcessExit(cleanupPid).catch(() => {});
      }
    }
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

async function waitForLeaderPid(lockPath) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(fs.readFileSync(lockPath, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // The Leader creates and fills the lock asynchronously.
    }
    await delay(50);
  }
  throw new Error('等待 AgentMesh360 Leader PID 超时');
}

function readLeaderPid(lockPath) {
  try {
    const pid = Number(fs.readFileSync(lockPath, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await delay(50);
  }
  throw new Error(`Leader ${pid} 未在超时前退出`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function bootstrapFixture() {
  return {
    schema_version: 1,
    server_time: '2026-07-24T00:00:00Z',
    account: {
      id: 7,
      email: 'lifecycle@example.com',
      account_id: 19,
      display_name: 'Lifecycle',
      avatar_url: null,
    },
    subscription: {
      status: 'active',
      source: 'integration_test',
      plan: 'pro',
      period_start: '2026-07-01 00:00:00',
      period_end: '2026-08-24 00:00:00',
      auto_renews: true,
    },
    credits: { balance: 0, source: 'integration_test', expires_at: null },
    access: { can_enter_client: true, reason: 'subscription_active' },
  };
}
