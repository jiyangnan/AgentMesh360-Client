'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOST_MODE_PERSISTENT = 'persistent_leader';
const HOST_MODE_EMBEDDED = 'embedded';
const HOST_MODES = new Set([HOST_MODE_PERSISTENT, HOST_MODE_EMBEDDED]);
const MAX_UNIX_SOCKET_PATH_BYTES = 100;

function resolveHostRuntime({
  env = process.env,
  homeDir = env.HOME || os.homedir(),
  platform = process.platform,
} = {}) {
  const mode = env.AGENTMESH360_HOST_MODE || HOST_MODE_PERSISTENT;
  if (!HOST_MODES.has(mode)) {
    throw new Error(`不支持的 Agent Host 模式：${mode}`);
  }

  const agentmeshHome = path.resolve(
    env.AGENTMESH360_HOME || path.join(homeDir, '.agentmesh360'),
  );
  const childEnv = { ...env, AGENTMESH360_HOME: agentmeshHome };

  if (mode === HOST_MODE_EMBEDDED) {
    delete childEnv.GROK_LEADER_SOCKET;
    return Object.freeze({
      mode,
      ownership: 'electron_child',
      transport: 'stdio',
      args: Object.freeze(['agent', '--no-leader', 'stdio']),
      agentmeshHome,
      socketPath: null,
      env: Object.freeze(childEnv),
    });
  }

  const socketPath = path.resolve(
    env.AGENTMESH360_HOST_SOCKET || path.join(agentmeshHome, 'run', 'host.sock'),
  );
  if (
    platform !== 'win32'
    && Buffer.byteLength(socketPath, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES
  ) {
    throw new Error('Agent Host socket 路径过长，请缩短 AGENTMESH360_HOME 或设置 AGENTMESH360_HOST_SOCKET');
  }
  childEnv.GROK_LEADER_SOCKET = socketPath;
  return Object.freeze({
    mode,
    ownership: 'grok_leader',
    transport: 'leader_stdio_bridge',
    args: Object.freeze(['agent', '--leader', 'stdio']),
    agentmeshHome,
    socketPath,
    env: Object.freeze(childEnv),
  });
}

function prepareHostRuntime(runtime) {
  if (runtime.mode !== HOST_MODE_PERSISTENT) return;
  fs.mkdirSync(path.dirname(runtime.socketPath), {
    recursive: true,
    mode: 0o700,
  });
}

function publicHostRuntime(runtime, bridgeConnected = false) {
  return Object.freeze({
    mode: runtime.mode,
    ownership: runtime.ownership,
    transport: runtime.transport,
    bridgeState: bridgeConnected ? 'connected' : 'detached',
    socketName: runtime.socketPath ? path.basename(runtime.socketPath) : null,
  });
}

module.exports = {
  HOST_MODE_EMBEDDED,
  HOST_MODE_PERSISTENT,
  MAX_UNIX_SOCKET_PATH_BYTES,
  prepareHostRuntime,
  publicHostRuntime,
  resolveHostRuntime,
};
