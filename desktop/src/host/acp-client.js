'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const INITIALIZE_PARAMS = Object.freeze({
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
  _meta: {
    startupHints: {
      nonInteractive: true,
      skipGitStatus: true,
      skipProjectLayout: true,
    },
    clientType: 'agentmesh360-desktop',
    clientVersion: '0.1.0',
    clientIdentifier: 'agentmesh360-desktop',
  },
});

class HostRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HostRequestError';
    this.code = code;
  }
}

class AcpHostClient extends EventEmitter {
  constructor({
    command,
    args,
    env = process.env,
    resourcesPath = process.resourcesPath,
    spawnImpl = spawn,
    requestTimeoutMs = 20000,
  } = {}) {
    super();
    const resolved = command
      ? { command, args: args || ['agent', '--no-leader', 'stdio'] }
      : resolveHostCommand({ env, resourcesPath });
    this.command = resolved.command;
    this.args = resolved.args;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.startPromise = null;
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (this.child) return;
    this.startPromise = this.#spawnAndInitialize();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async bootstrap(accessToken) {
    const response = await this.#extension('x.agentmesh360/account/bootstrap', {
      accessToken,
    });
    return response;
  }

  async listAgents() {
    return this.#extension('x.agentmesh360/agents/list', {});
  }

  async activateAgent(agentId) {
    return this.#extension('x.agentmesh360/agents/activate', { agentId });
  }

  async listProviderProfiles() {
    return this.#extension('x.agentmesh360/providers/list', {});
  }

  async createProviderProfile(profile, apiKey) {
    return this.#extension('x.agentmesh360/providers/create', { profile, apiKey });
  }

  async updateProviderProfile(profileId, profile) {
    return this.#extension('x.agentmesh360/providers/update', { profileId, profile });
  }

  async replaceProviderSecret(profileId, apiKey) {
    return this.#extension('x.agentmesh360/providers/replace-secret', { profileId, apiKey });
  }

  async deleteProviderProfile(profileId) {
    return this.#extension('x.agentmesh360/providers/delete', { profileId });
  }

  async invalidate() {
    if (!this.child) return;
    try {
      await this.bootstrap('');
    } catch {
      // Bootstrap clears the Host access state before it rejects an empty token.
    }
  }

  async stop() {
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    this.#rejectPending(new HostRequestError('host_stopped', 'Agent Host 已停止'));
    if (!child || child.killed) return;
    child.kill('SIGTERM');
  }

  async #spawnAndInitialize() {
    let child;
    try {
      child = this.spawnImpl(this.command, this.args, {
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      throw new HostRequestError('host_unavailable', '无法启动 AgentMesh360 Agent Host');
    }
    this.child = child;
    child.once('error', () => {
      this.#handleExit(child, new HostRequestError('host_unavailable', '无法启动 AgentMesh360 Agent Host'));
    });
    child.once('exit', () => {
      this.#handleExit(child, new HostRequestError('host_exited', 'AgentMesh360 Agent Host 已退出'));
    });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this.#handleLine(line));
    child.stderr?.resume();

    await this.#request('initialize', INITIALIZE_PARAMS);
  }

  #handleExit(child, error) {
    if (this.child !== child) return;
    this.child = null;
    this.#rejectPending(error);
    this.emit('exit', error);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (Object.hasOwn(message, 'id') && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new HostRequestError('host_request_failed', hostErrorMessage(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (Object.hasOwn(message, 'id') && message.method) {
      this.#write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Desktop client method not implemented' },
      });
      return;
    }
    if (message.method) this.emit('notification', message);
  }

  async #extension(method, params) {
    await this.start();
    // ACP reserves bare method names for the protocol itself. Custom methods
    // travel on the wire with a leading underscore; the decoder removes it
    // before dispatching the ExtRequest to the Grok Host.
    const envelope = await this.#request(`_${method}`, params);
    if (!envelope || typeof envelope !== 'object' || !Object.hasOwn(envelope, 'result')) {
      throw new HostRequestError('invalid_host_response', 'Agent Host 返回了无效响应');
    }
    if (envelope.error) {
      throw new HostRequestError('host_extension_failed', hostErrorMessage(envelope.error));
    }
    return envelope.result;
  }

  #request(method, params) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new HostRequestError('host_unavailable', 'Agent Host 尚未运行'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostRequestError('host_timeout', 'Agent Host 响应超时'));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new HostRequestError('host_unavailable', '无法连接 Agent Host'));
      }
    });
  }

  #write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function hostErrorMessage(error) {
  if (typeof error === 'string') return error;
  if (typeof error?.message === 'string') return error.message;
  if (typeof error?.data?.message === 'string') return error.data.message;
  return 'Agent Host 请求失败';
}

function resolveHostCommand({ env = process.env, resourcesPath = process.resourcesPath } = {}) {
  if (env.AGENTMESH360_HOST_BIN) {
    return { command: env.AGENTMESH360_HOST_BIN, args: ['agent', '--no-leader', 'stdio'] };
  }
  const candidates = [];
  if (resourcesPath) candidates.push(path.join(resourcesPath, 'bin', 'agentmesh360-host'));
  const repositoryRoot = path.resolve(__dirname, '..', '..', '..');
  candidates.push(path.join(repositoryRoot, 'target', 'release', 'xai-grok-pager'));
  candidates.push(path.join(repositoryRoot, 'target', 'debug', 'xai-grok-pager'));
  const local = candidates.find((candidate) => fs.existsSync(candidate));
  return {
    command: local || 'grok',
    args: ['agent', '--no-leader', 'stdio'],
  };
}

module.exports = {
  AcpHostClient,
  HostRequestError,
  INITIALIZE_PARAMS,
  resolveHostCommand,
};
