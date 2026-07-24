'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  HOST_MODE_EMBEDDED,
  HOST_MODE_PERSISTENT,
  publicHostRuntime,
  resolveHostRuntime,
} = require('../src/host/runtime');

test('Host runtime defaults to a product-scoped persistent Grok Leader', () => {
  const runtime = resolveHostRuntime({
    env: {
      HOME: '/tmp/agentmesh-user',
      GROK_LEADER_SOCKET: '/tmp/unrelated-grok.sock',
    },
  });

  assert.equal(runtime.mode, HOST_MODE_PERSISTENT);
  assert.equal(runtime.ownership, 'grok_leader');
  assert.deepEqual(runtime.args, ['agent', '--leader', 'stdio']);
  assert.equal(runtime.agentmeshHome, '/tmp/agentmesh-user/.agentmesh360');
  assert.equal(runtime.socketPath, '/tmp/agentmesh-user/.agentmesh360/run/host.sock');
  assert.equal(runtime.env.GROK_LEADER_SOCKET, runtime.socketPath);
  assert.notEqual(runtime.env.GROK_LEADER_SOCKET, '/tmp/unrelated-grok.sock');
});

test('Host runtime supports an explicit embedded diagnostic mode', () => {
  const runtime = resolveHostRuntime({
    env: {
      HOME: '/tmp/agentmesh-user',
      AGENTMESH360_HOST_MODE: HOST_MODE_EMBEDDED,
      GROK_LEADER_SOCKET: '/tmp/unrelated-grok.sock',
    },
  });

  assert.equal(runtime.mode, HOST_MODE_EMBEDDED);
  assert.equal(runtime.ownership, 'electron_child');
  assert.deepEqual(runtime.args, ['agent', '--no-leader', 'stdio']);
  assert.equal(runtime.socketPath, null);
  assert.equal(Object.hasOwn(runtime.env, 'GROK_LEADER_SOCKET'), false);
});

test('Host runtime honors product state and socket overrides without mutating input', () => {
  const env = {
    HOME: '/tmp/agentmesh-user',
    AGENTMESH360_HOME: '/tmp/agentmesh-state',
    AGENTMESH360_HOST_SOCKET: '/tmp/agentmesh-runtime/custom.sock',
  };
  const runtime = resolveHostRuntime({ env });

  assert.equal(runtime.agentmeshHome, '/tmp/agentmesh-state');
  assert.equal(runtime.socketPath, '/tmp/agentmesh-runtime/custom.sock');
  assert.equal(Object.hasOwn(env, 'GROK_LEADER_SOCKET'), false);
});

test('Public Host diagnostics expose lifecycle state without local paths or environment', () => {
  const runtime = resolveHostRuntime({
    env: {
      HOME: '/Users/private-account',
      AGENTMESH360_HOST_SOCKET: '/Users/private-account/Library/AgentMesh/private.sock',
      PROVIDER_API_KEY: 'secret-value',
    },
  });
  const diagnostic = publicHostRuntime(runtime, true);

  assert.deepEqual(diagnostic, {
    mode: HOST_MODE_PERSISTENT,
    ownership: 'grok_leader',
    transport: 'leader_stdio_bridge',
    bridgeState: 'connected',
    socketName: path.basename(runtime.socketPath),
  });
  assert.equal(JSON.stringify(diagnostic).includes('private-account'), false);
  assert.equal(JSON.stringify(diagnostic).includes('secret-value'), false);
});

test('Unknown Host runtime modes fail closed', () => {
  assert.throws(
    () => resolveHostRuntime({
      env: { HOME: '/tmp/agentmesh-user', AGENTMESH360_HOST_MODE: 'mystery' },
    }),
    /不支持的 Agent Host 模式/,
  );
});

test('Overlong Unix socket paths fail before spawning the Host', () => {
  assert.throws(
    () => resolveHostRuntime({
      env: {
        HOME: '/tmp',
        AGENTMESH360_HOST_SOCKET: `/tmp/${'very-long-segment-'.repeat(8)}host.sock`,
      },
      platform: 'darwin',
    }),
    /socket 路径过长/,
  );
});
