'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const {
  HOST_MODE_PERSISTENT,
  prepareHostRuntime,
  publicHostRuntime,
  resolveHostRuntime,
} = require('./runtime');
const { version: DESKTOP_VERSION } = require('../../package.json');

const PERSISTENT_START_ATTEMPTS = 2;

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
    clientVersion: DESKTOP_VERSION,
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
    initializeTimeoutMs = 60000,
    sessionLoadTimeoutMs = 120000,
    sessionPromptTimeoutMs = 30 * 60 * 1000,
    permissionRequestTimeoutMs = 5 * 60 * 1000,
  } = {}) {
    super();
    this.runtime = resolveHostRuntime({ env });
    const resolved = command
      ? { command, args: args || this.runtime.args }
      : resolveHostCommand({ env: this.runtime.env, resourcesPath, args: this.runtime.args });
    this.command = resolved.command;
    this.args = resolved.args;
    this.env = this.runtime.env;
    this.spawnImpl = spawnImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.initializeTimeoutMs = initializeTimeoutMs;
    this.sessionLoadTimeoutMs = sessionLoadTimeoutMs;
    this.sessionPromptTimeoutMs = sessionPromptTimeoutMs;
    this.permissionRequestTimeoutMs = permissionRequestTimeoutMs;
    this.child = null;
    this.pending = new Map();
    this.incomingPermissions = new Map();
    this.nextId = 1;
    this.startPromise = null;
    this.accessRefreshPromise = null;
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (this.child) return;
    prepareHostRuntime(this.runtime);
    this.startPromise = this.#startWithBoundedRetry();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async bootstrap(accessToken) {
    const previous = this.accessRefreshPromise?.catch(() => {});
    const operation = (previous || Promise.resolve()).then(() => this.#extensionRequest(
      'x.agentmesh360/account/bootstrap',
      { accessToken },
    ));
    this.accessRefreshPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.accessRefreshPromise === operation) {
        this.accessRefreshPromise = null;
      }
    }
  }

  async listAgents() {
    return this.#extension('x.agentmesh360/agents/list', {});
  }

  async activateAgent(agentId) {
    return this.#extension('x.agentmesh360/agents/activate', { agentId });
  }

  async getAgentCustomization(agentId) {
    return this.#extension('x.agentmesh360/agents/customization/get', { agentId });
  }

  async upsertAgentCustomization({
    agentId,
    kind,
    content,
    expectedRevision,
  }) {
    return this.#extension('x.agentmesh360/agents/customization/upsert', {
      agentId,
      kind,
      content,
      expectedRevision,
    });
  }

  async clearAgentCustomization({ agentId, kind, expectedRevision }) {
    return this.#extension('x.agentmesh360/agents/customization/clear', {
      agentId,
      kind,
      expectedRevision,
    });
  }

  async listWorkspaceArtifacts(agentId) {
    return this.#extension('x.agentmesh360/agents/artifacts/list', { agentId });
  }

  async getWorkspaceProjectState(agentId) {
    return this.#extension('x.agentmesh360/agents/project-state/get', { agentId });
  }

  async listAgentBackgroundActivities(agentId) {
    return this.#extension('x.agentmesh360/agents/background-activities/list', { agentId });
  }

  async getAgentSessionPlan(agentId) {
    return this.#extension('x.agentmesh360/agents/session-plan/get', { agentId });
  }

  async loadSession({ sessionId, cwd }) {
    await this.start();
    return this.#request('session/load', {
      sessionId,
      cwd,
      mcpServers: [],
    }, this.sessionLoadTimeoutMs);
  }

  async promptSession({ sessionId, prompt, text }) {
    await this.start();
    const content = prompt === undefined
      ? [{ type: 'text', text: String(text || '') }]
      : validatePromptBlocks(prompt);
    return this.#request('session/prompt', {
      sessionId,
      prompt: content,
    }, this.sessionPromptTimeoutMs);
  }

  async getAgentPackageCatalog() {
    return this.#extension('x.agentmesh360/agent-packages/catalog', {});
  }

  async getAgentPackageStatus() {
    return this.#extension('x.agentmesh360/agent-packages/status', {});
  }

  async getRemoteAgentPackageCatalog() {
    return this.#extension('x.agentmesh360/agent-packages/remote-catalog', {});
  }

  async refreshAgentPackageRegistry() {
    return this.#extension('x.agentmesh360/agent-packages/remote-refresh', {});
  }

  async downloadAgentPackage(packageId) {
    return this.#extension('x.agentmesh360/agent-packages/download', { packageId });
  }

  async approveAgentPackage(approvalId) {
    return this.#extension('x.agentmesh360/agent-packages/approve', { approvalId });
  }

  async rollbackAgentPackage(packageId) {
    return this.#extension('x.agentmesh360/agent-packages/rollback', { packageId });
  }

  async reconcileAgentPackage(packageId) {
    return this.#extension('x.agentmesh360/agent-packages/reconcile', { packageId });
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

  async getProviderCatalog() {
    return this.#extension('x.agentmesh360/providers/catalog', {});
  }

  async runProviderProbe({
    profileId,
    modelId,
    level,
    confirmPaidInference = false,
  }) {
    return this.#extension('x.agentmesh360/providers/probes/run', {
      profileId,
      modelId,
      level,
      confirmPaidInference,
    });
  }

  async testProviderConnection({
    profile,
    apiKey,
    modelId,
    confirmPaidInference = false,
  }) {
    return this.#extension('x.agentmesh360/providers/test-connection', {
      profile,
      apiKey,
      modelId,
      confirmPaidInference,
    });
  }

  async discoverProviderModels({ profile, apiKey }) {
    return this.#extension('x.agentmesh360/providers/discover-models', {
      profile,
      apiKey,
    });
  }

  async listProviderProbes(profileId = null) {
    return this.#extension('x.agentmesh360/providers/probes/list', { profileId });
  }

  async listModelAssignments() {
    return this.#extension('x.agentmesh360/model-assignments/list', {});
  }

  async upsertModelAssignment(assignment) {
    return this.#extension('x.agentmesh360/model-assignments/upsert', { assignment });
  }

  async deleteModelAssignment(assignmentId) {
    return this.#extension('x.agentmesh360/model-assignments/delete', { assignmentId });
  }

  async resolveSessionBinding({ sessionId, role, agentId = null }) {
    return this.#extension('x.agentmesh360/session-bindings/resolve', {
      sessionId,
      role,
      agentId,
    });
  }

  async getSessionBindingHistory({ sessionId, role, agentId = null }) {
    return this.#extension('x.agentmesh360/session-bindings/history', {
      sessionId,
      role,
      agentId,
    });
  }

  async switchSessionBinding({
    sessionId,
    role,
    agentId = null,
    kind,
    targetBindingRevision = null,
  }) {
    return this.#extension('x.agentmesh360/session-bindings/switch', {
      sessionId,
      role,
      agentId,
      kind,
      targetBindingRevision,
    });
  }

  async listTurnRoutes({ sessionId, role, agentId = null }) {
    return this.#extension('x.agentmesh360/turn-routes/list', {
      sessionId,
      role,
      agentId,
    });
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
    this.#cancelIncomingPermissions();
    this.child = null;
    this.startPromise = null;
    this.#rejectPending(new HostRequestError('host_stopped', 'Agent Host 已停止'));
    if (!child || child.killed) return;
    // In persistent_leader mode this terminates only the disposable stdio
    // bridge. The Grok Leader owns the Host and survives UI detach.
    child.kill('SIGTERM');
  }

  getRuntimeStatus() {
    return publicHostRuntime(this.runtime, Boolean(this.child));
  }

  respondPermission(requestId, optionId = null) {
    return this.#resolvePermission(
      requestId,
      optionId,
      optionId === null ? 'cancelled' : 'selected',
    );
  }

  #resolvePermission(requestId, optionId, resolution) {
    const pending = this.incomingPermissions.get(requestId);
    if (!pending) throw new Error('权限请求已失效');
    if (
      optionId !== null
      && !pending.options.some((option) => option.optionId === optionId)
    ) {
      throw new Error('权限选项无效');
    }
    this.incomingPermissions.delete(requestId);
    clearTimeout(pending.timeout);
    this.#write({
      jsonrpc: '2.0',
      id: requestId,
      result: {
        outcome: optionId === null
          ? { outcome: 'cancelled' }
          : { outcome: 'selected', optionId },
      },
    });
    this.emit('permission-resolved', {
      requestId,
      outcome: resolution,
    });
  }

  async #startWithBoundedRetry() {
    const attempts = this.runtime.mode === HOST_MODE_PERSISTENT
      ? PERSISTENT_START_ATTEMPTS
      : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.#spawnAndInitialize();
        return;
      } catch (error) {
        if (
          attempt >= attempts
          || !(error instanceof HostRequestError)
          || error.code !== 'host_exited'
        ) {
          throw error;
        }
      }
    }
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
    let initialized = false;
    const lines = readline.createInterface({ input: child.stdout });
    let linesClosed = false;
    const closeLines = () => {
      if (linesClosed) return;
      linesClosed = true;
      lines.close();
    };
    child.once('error', () => {
      closeLines();
      this.#handleExit(
        child,
        new HostRequestError('host_unavailable', '无法启动 AgentMesh360 Agent Host'),
        initialized,
      );
    });
    child.once('exit', () => {
      closeLines();
      this.#handleExit(
        child,
        new HostRequestError('host_exited', 'AgentMesh360 Agent Host 已退出'),
        initialized,
      );
    });
    lines.on('line', (line) => {
      if (this.child === child) this.#handleLine(line);
    });
    child.stderr?.resume();

    try {
      await this.#request('initialize', INITIALIZE_PARAMS, this.initializeTimeoutMs);
      if (this.child !== child) {
        throw new HostRequestError('host_exited', 'AgentMesh360 Agent Host 已退出');
      }
      initialized = true;
    } catch (error) {
      if (this.child === child) {
        this.child = null;
        closeLines();
        this.#clearIncomingPermissions();
        this.#rejectPending(error);
        try {
          if (!child.killed) child.kill('SIGTERM');
        } catch {
          // Startup already failed; transport cleanup must not replace its error.
        }
      }
      throw error;
    }
  }

  #handleExit(child, error, initialized = true) {
    if (this.child !== child) return;
    this.child = null;
    this.#clearIncomingPermissions();
    this.#rejectPending(error);
    if (initialized) this.emit('exit', error);
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
      if (message.method === 'session/request_permission') {
        this.#handlePermissionRequest(message);
        return;
      }
      this.#write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Desktop client method not implemented' },
      });
      return;
    }
    if (message.method) {
      if (message.method === 'x.ai/leader_reconnected') {
        // The session identifier in the upstream notification is deliberately
        // not forwarded. Identity recovery only needs the lifecycle edge.
        this.emit('reconnected');
      }
      this.emit('notification', message);
    }
  }

  #handlePermissionRequest(message) {
    const params = message.params;
    const options = Array.isArray(params?.options) ? params.options : [];
    if (
      (typeof message.id !== 'string' && typeof message.id !== 'number')
      || typeof params?.sessionId !== 'string'
      || !params.sessionId
      || !params.toolCall
      || typeof params.toolCall !== 'object'
      || !options.length
      || options.some((option) => (
        !option
        || typeof option !== 'object'
        || typeof option.optionId !== 'string'
        || !option.optionId
      ))
      || this.incomingPermissions.has(message.id)
    ) {
      this.#write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32602, message: 'Invalid permission request' },
      });
      return;
    }
    const timeout = setTimeout(() => {
      if (!this.incomingPermissions.has(message.id)) return;
      try {
        this.#resolvePermission(message.id, null, 'expired');
      } catch {
        this.#dropIncomingPermission(message.id);
      }
    }, this.permissionRequestTimeoutMs);
    this.incomingPermissions.set(message.id, {
      options: options.map((option) => ({ optionId: option.optionId })),
      timeout,
    });
    if (this.listenerCount('permission-request') === 0) {
      this.respondPermission(message.id, null);
      return;
    }
    try {
      this.emit('permission-request', {
        requestId: message.id,
        sessionId: params.sessionId,
        toolCall: params.toolCall,
        options,
        _meta: params._meta,
      });
    } catch {
      if (this.incomingPermissions.has(message.id)) {
        this.respondPermission(message.id, null);
      }
    }
  }

  async #extension(method, params) {
    const accessRefresh = this.accessRefreshPromise;
    if (accessRefresh) await accessRefresh;
    return this.#extensionRequest(method, params);
  }

  async #extensionRequest(method, params) {
    await this.start();
    // ACP reserves bare method names for the protocol itself. Custom methods
    // travel on the wire with a leading underscore; the decoder removes it
    // before dispatching the ExtRequest to the Grok Host.
    const envelope = await this.#request(`_${method}`, params);
    if (!envelope || typeof envelope !== 'object' || !Object.hasOwn(envelope, 'result')) {
      throw new HostRequestError('invalid_host_response', 'Agent Host 返回了无效响应');
    }
    if (envelope.error) {
      throw new HostRequestError(hostExtensionErrorCode(envelope.error), hostErrorMessage(envelope.error));
    }
    return envelope.result;
  }

  #request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new HostRequestError('host_unavailable', 'Agent Host 尚未运行'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostRequestError('host_timeout', 'Agent Host 响应超时'));
      }, timeoutMs);
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

  #cancelIncomingPermissions() {
    for (const requestId of [...this.incomingPermissions.keys()]) {
      try {
        this.respondPermission(requestId, null);
      } catch {
        this.#dropIncomingPermission(requestId);
      }
    }
  }

  #clearIncomingPermissions() {
    for (const requestId of [...this.incomingPermissions.keys()]) {
      this.#dropIncomingPermission(requestId);
    }
  }

  #dropIncomingPermission(requestId) {
    const pending = this.incomingPermissions.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.incomingPermissions.delete(requestId);
    this.emit('permission-resolved', {
      requestId,
      outcome: 'transport_closed',
    });
  }
}

function hostErrorMessage(error) {
  if (typeof error === 'string') return error;
  if (typeof error?.message === 'string') return error.message;
  if (typeof error?.data?.message === 'string') return error.data.message;
  return 'Agent Host 请求失败';
}

function hostExtensionErrorCode(error) {
  return typeof error?.code === 'string' && error.code
    ? error.code
    : 'host_extension_failed';
}

function validatePromptBlocks(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 11) {
    throw new HostRequestError('invalid_prompt', '消息内容无效');
  }
  let textBlocks = 0;
  for (const block of value) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw new HostRequestError('invalid_prompt', '消息内容无效');
    }
    if (block.type === 'text') {
      textBlocks += 1;
      if (typeof block.text !== 'string' || block.text.length < 1 || block.text.length > 20_000) {
        throw new HostRequestError('invalid_prompt', '消息文本无效');
      }
      continue;
    }
    if (block.type === 'image') {
      if (
        typeof block.data !== 'string'
        || block.data.length < 4
        || block.data.length > 28_000_000
        || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(block.mimeType)
      ) {
        throw new HostRequestError('invalid_prompt', '图片附件无效');
      }
      continue;
    }
    if (block.type === 'resource_link') {
      let parsed;
      try {
        parsed = new URL(block.uri);
      } catch {
        throw new HostRequestError('invalid_prompt', '链接附件无效');
      }
      if (
        !['http:', 'https:'].includes(parsed.protocol)
        || typeof block.name !== 'string'
        || block.name.length < 1
        || block.name.length > 180
      ) {
        throw new HostRequestError('invalid_prompt', '链接附件无效');
      }
      continue;
    }
    if (block.type === 'resource') {
      const resource = block.resource;
      const hasText = typeof resource?.text === 'string';
      const hasBlob = typeof resource?.blob === 'string';
      if (
        !resource
        || typeof resource.uri !== 'string'
        || !resource.uri.startsWith('file:///agentmesh360-attachment/')
        || hasText === hasBlob
        || (hasText && resource.text.length > 20 * 1024 * 1024)
        || (hasBlob && (resource.blob.length < 4 || resource.blob.length > 28_000_000))
        || typeof resource.mimeType !== 'string'
        || resource.mimeType.length > 160
      ) {
        throw new HostRequestError('invalid_prompt', '文件附件无效');
      }
      continue;
    }
    throw new HostRequestError('invalid_prompt', '暂不支持此消息内容');
  }
  if (textBlocks !== 1) throw new HostRequestError('invalid_prompt', '消息必须包含一段文本');
  return value;
}

function resolveHostCommand({
  env = process.env,
  resourcesPath = process.resourcesPath,
  args = ['agent', '--leader', 'stdio'],
} = {}) {
  if (env.AGENTMESH360_HOST_BIN) {
    return { command: env.AGENTMESH360_HOST_BIN, args };
  }
  const candidates = [];
  if (resourcesPath) candidates.push(path.join(resourcesPath, 'bin', 'agentmesh360-host'));
  const repositoryRoot = path.resolve(__dirname, '..', '..', '..');
  candidates.push(path.join(repositoryRoot, 'target', 'release', 'xai-grok-pager'));
  candidates.push(path.join(repositoryRoot, 'target', 'debug', 'xai-grok-pager'));
  const local = candidates.find((candidate) => fs.existsSync(candidate));
  return {
    command: local || 'grok',
    args,
  };
}

module.exports = {
  AcpHostClient,
  HostRequestError,
  INITIALIZE_PARAMS,
  resolveHostCommand,
  validatePromptBlocks,
};
