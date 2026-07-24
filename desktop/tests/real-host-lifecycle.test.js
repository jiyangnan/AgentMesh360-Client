'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { AcpHostClient } = require('../src/host/acp-client');
const { IdentityController } = require('../src/identity-controller');

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
  let identity = null;
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
    let refreshCalls = 0;
    identity = new IdentityController({
      core: {
        async refresh() {
          refreshCalls += 1;
          return {
            access_token: `replacement-access-token-${refreshCalls}`,
            refresh_token: `replacement-refresh-token-${refreshCalls}`,
          };
        },
        async bootstrap() {
          return bootstrapFixture();
        },
      },
      tokenStore: {
        loadRefreshToken() { return 'persistent-refresh-token'; },
        saveRefreshToken() {},
        clear() {},
      },
      host: secondClient,
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: () => {},
    });
    const restoredIdentity = await identity.start();
    assert.equal(restoredIdentity.phase, 'ready');
    const list = await secondClient.listAgents();
    const jobAgent = list.agents.find((agent) => agent.agentId === 'job-agent');

    assert.equal(jobAgent.mainSessionId, sessionId);
    assert.equal(Number(fs.readFileSync(lockPath, 'utf8').trim()), leaderPid);
    assert.equal(secondClient.getRuntimeStatus().bridgeState, 'connected');

    const replacedLeader = waitForEvent(secondClient, 'reconnected', 20000);
    process.kill(leaderPid, 'SIGKILL');
    await waitForProcessExit(leaderPid);
    await replacedLeader;

    const replacementPid = await waitForDifferentLeaderPid(lockPath, leaderPid);
    assert.equal(isProcessAlive(replacementPid), true);
    leaderPid = replacementPid;
    await waitFor(
      () => identity.getState().revalidatedBy === 'host_reconnected',
      20000,
    );
    assert.equal(identity.getState().phase, 'ready');
    assert.equal(refreshCalls, 2);
    const restored = await secondClient.listAgents();
    const restoredJob = restored.agents.find((agent) => agent.agentId === 'job-agent');
    assert.equal(restoredJob.mainSessionId, sessionId);
  } catch (error) {
    const leaderLogPath = path.join(home, '.grok', 'leader.log');
    const leaderLog = fs.existsSync(leaderLogPath)
      ? fs.readFileSync(leaderLogPath, 'utf8')
      : 'leader.log 不存在';
    error.message = `${error.message}\nbridge stderr:\n${bridgeStderr.join('').slice(-4000)}\nleader log:\n${leaderLog.slice(-4000)}`;
    throw error;
  } finally {
    await identity?.shutdown().catch(() => {});
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

async function waitForDifferentLeaderPid(lockPath, previousPid) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const pid = readLeaderPid(lockPath);
    if (pid && pid !== previousPid) return pid;
    await delay(50);
  }
  throw new Error('等待替代 AgentMesh360 Leader PID 超时');
}

function waitForEvent(emitter, eventName, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      emitter.off(eventName, onEvent);
      reject(new Error(`等待 ${eventName} 事件超时`));
    }, timeoutMs);
    const onEvent = () => {
      clearTimeout(timeout);
      resolve();
    };
    emitter.once(eventName, onEvent);
  });
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

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error('等待产品 Host 恢复超时');
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
