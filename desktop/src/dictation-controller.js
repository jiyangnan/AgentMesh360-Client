'use strict';

const DICTATION_CHANGED_METHODS = new Set([
  'x.agentmesh360/dictation/changed',
  '_x.agentmesh360/dictation/changed',
]);
const DICTATION_DISCLOSURE = '语音只在这台 Mac 上转换为文字，不会上传到 AgentMesh360；听写结果只会放入输入框，不会自动发送。';
const ACTIVE_PHASES = new Set(['starting', 'listening', 'transcribing']);
const PHASES = new Set(['idle', ...ACTIVE_PHASES, 'complete', 'error']);
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,198}[a-z0-9]$/u;
const DICTATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/u;
const MAX_TRANSCRIPT_CHARS = 20_000;
const MAX_SERVICE_NAME_CHARS = 100;
const MAX_SERVICE_ID_CHARS = 200;
const MAX_DURATION_SECONDS = 60;
const MAX_AUDIO_BYTES = 1_920_000;

const PUBLIC_ERRORS = new Map([
  ['invalid_dictation_request', '无法开始听写，请重新打开当前 Agent 后再试。'],
  ['dictation_disclosure_required', '请先确认使用 macOS 本机听写。'],
  ['dictation_busy', '已有一段听写正在进行，请先停止或取消。'],
  ['dictation_provider_required', '当前版本的云端听写服务尚未启用。'],
  ['dictation_unavailable', '听写服务暂时不可用，请稍后重试。'],
  ['dictation_helper_unavailable', '本机听写组件暂时不可用，请重启 AgentMesh360 后再试。'],
  ['dictation_helper_protocol_error', '本机听写组件返回了无效结果，请重启 AgentMesh360 后再试。'],
  ['dictation_language_unavailable', '当前系统语言不支持听写，请在系统设置中选择可用的听写语言。'],
  ['dictation_on_device_unavailable', '这台 Mac 尚未准备好本机听写，请在“系统设置 → 键盘 → 听写”中启用并下载当前语言。'],
  ['dictation_not_found', '这段听写已经结束，请重新开始。'],
  ['dictation_no_speech', '没有识别到语音，请检查麦克风权限后重试。'],
  ['microphone_permission_denied', '没有麦克风权限，请在系统设置中允许 AgentMesh360 使用麦克风。'],
  ['microphone_unavailable', '没有找到可用麦克风，请连接麦克风后重试。'],
  ['speech_recognition_permission_denied', '没有语音识别权限，请在系统设置中允许 AgentMesh360 使用语音识别。'],
  ['speech_recognition_restricted', '这台 Mac 当前限制了语音识别，请检查系统隐私与家长控制设置。'],
  ['dictation_failed', '听写没有完成，请稍后重试。'],
]);

class DictationController {
  constructor({ identity, host }) {
    if (!identity || !host) throw new Error('听写服务依赖无效');
    this.identity = identity;
    this.host = host;
    this.listeners = new Set();
    this.accountId = null;
    this.agentId = null;
    this.operation = null;
    this.lifecycleRevision = 0;
    this.hostRevision = -1;
    this.acceptEqualHostRevision = false;
    this.snapshot = idleSnapshot(null, 0);
    this.handleIdentity = (state) => this.#handleIdentity(state);
    this.handleNotification = (message) => this.#handleNotification(message);
    this.handleHostExit = () => this.#handleHostExit();
    this.handleReconnect = () => this.#handleReconnect();
    this.unsubscribeIdentity = this.identity.subscribe(this.handleIdentity);
    this.host.on?.('notification', this.handleNotification);
    this.host.on?.('exit', this.handleHostExit);
    this.host.on?.('reconnected', this.handleReconnect);
  }

  getSnapshot() {
    return this.snapshot;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new Error('听写订阅无效');
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  async open(agentId) {
    this.#ensureNoOperation();
    const normalizedAgentId = this.#requireReadyAgent(agentId);
    if (
      this.agentId
      && this.agentId !== normalizedAgentId
      && ACTIVE_PHASES.has(this.snapshot.phase)
    ) {
      throw new Error('请先停止或取消当前听写，再切换 Agent。');
    }
    this.#selectAgent(normalizedAgentId);
    return this.#run(async ({ isCurrent }) => {
      const response = await this.host.getDictationStatus(normalizedAgentId);
      if (!isCurrent()) return this.snapshot;
      if (!this.#applySnapshot(response, { expectedAgentId: normalizedAgentId })) {
        throw new Error('本机听写组件返回了无效状态');
      }
      return this.snapshot;
    });
  }

  async start(agentId, { disclosureAccepted = false } = {}) {
    this.#ensureNoOperation();
    const normalizedAgentId = this.#requireReadyAgent(agentId);
    if (disclosureAccepted !== true) {
      throw new Error('请先确认使用 macOS 本机听写。');
    }
    if (this.agentId && this.agentId !== normalizedAgentId && ACTIVE_PHASES.has(this.snapshot.phase)) {
      throw new Error('已有一段听写正在进行，请先停止或取消。');
    }
    this.#selectAgent(normalizedAgentId);
    return this.#run(async ({ isCurrent }) => {
      if (!isCurrent()) return this.snapshot;
      this.acceptEqualHostRevision = true;
      this.#publish({
        ...idleSnapshot(normalizedAgentId, this.snapshot.revision),
        phase: 'starting',
      });
      const response = await this.host.startDictation({
        agentId: normalizedAgentId,
        disclosureAccepted: true,
      });
      if (!isCurrent()) return this.snapshot;
      if (!this.#applySnapshot(response, { expectedAgentId: normalizedAgentId })) {
        throw new Error('本机听写组件返回了无效状态');
      }
      return this.snapshot;
    });
  }

  async stop() {
    const dictationId = this.#requireActiveDictation();
    return this.#run(async ({ isCurrent }) => {
      const response = await this.host.stopDictation(dictationId);
      if (!isCurrent()) return this.snapshot;
      if (!this.#applySnapshot(response, { expectedAgentId: this.agentId })) {
        throw new Error('本机听写组件返回了无效状态');
      }
      return this.snapshot;
    });
  }

  async cancel() {
    const dictationId = this.#requireActiveDictation();
    return this.#run(async ({ isCurrent }) => {
      const response = await this.host.cancelDictation(dictationId);
      if (!isCurrent()) return this.snapshot;
      if (!this.#applySnapshot(response, { expectedAgentId: this.agentId })) {
        throw new Error('本机听写组件返回了无效状态');
      }
      return this.snapshot;
    });
  }

  close() {
    if (ACTIVE_PHASES.has(this.snapshot.phase)) {
      throw new Error('请先停止或取消当前听写。');
    }
    if (this.agentId) this.host.clearDictation?.(this.agentId);
    this.lifecycleRevision += 1;
    this.operation = null;
    this.agentId = null;
    this.hostRevision = -1;
    this.acceptEqualHostRevision = false;
    this.#publish(idleSnapshot(null, this.snapshot.revision));
    return this.snapshot;
  }

  dispose() {
    this.#cancelHostDictation();
    this.lifecycleRevision += 1;
    this.unsubscribeIdentity?.();
    this.host.off?.('notification', this.handleNotification);
    this.host.off?.('exit', this.handleHostExit);
    this.host.off?.('reconnected', this.handleReconnect);
    this.listeners.clear();
    this.operation = null;
    this.agentId = null;
    this.accountId = null;
    this.hostRevision = -1;
    this.acceptEqualHostRevision = false;
    this.snapshot = deepFreeze(idleSnapshot(null, 0));
  }

  #requireReadyAgent(agentId) {
    const state = this.identity.getState?.();
    if (state?.phase !== 'ready' || state.access?.canEnterClient !== true) {
      throw new Error('当前账号尚未通过订阅验证，无法使用听写。');
    }
    const normalized = validateAgentId(agentId);
    if (!state.agents?.some((agent) => agent?.agentId === normalized)) {
      throw new Error('当前账号没有此 Agent。');
    }
    return normalized;
  }

  #requireActiveDictation() {
    this.#requireReadyAgent(this.agentId);
    if (!ACTIVE_PHASES.has(this.snapshot.phase) || !DICTATION_ID_PATTERN.test(this.snapshot.dictationId || '')) {
      throw new Error('当前没有正在进行的听写。');
    }
    return this.snapshot.dictationId;
  }

  #run(operation) {
    this.#ensureNoOperation();
    const accountId = this.accountId;
    const agentId = this.agentId;
    const lifecycleRevision = this.lifecycleRevision;
    const isCurrent = () => (
      this.lifecycleRevision === lifecycleRevision
      && this.accountId === accountId
      && this.agentId === agentId
    );
    const promise = Promise.resolve()
      .then(() => operation({ isCurrent }))
      .catch((error) => {
        if (isCurrent()) {
          this.acceptEqualHostRevision = false;
          this.#publish({
            ...idleSnapshot(agentId, this.snapshot.revision),
            phase: 'error',
            error: publicControllerError(error),
          });
        }
        throw error;
      })
      .finally(() => {
        if (this.operation === promise) this.operation = null;
      });
    this.operation = promise;
    return promise;
  }

  #ensureNoOperation() {
    if (this.operation) throw new Error('听写操作正在进行，请稍后再试。');
  }

  #handleIdentity(state) {
    if (state?.phase === 'ready' && state.access?.canEnterClient === true) {
      const nextAccountId = state.account?.id ?? null;
      if (this.accountId !== null && this.accountId !== nextAccountId) this.#reset();
      this.accountId = nextAccountId;
      return;
    }
    if (['signed_out', 'blocked', 'unavailable'].includes(state?.phase)) {
      this.accountId = null;
      this.#reset();
    }
  }

  #handleNotification(message) {
    if (!DICTATION_CHANGED_METHODS.has(message?.method) || !this.agentId) return;
    this.#applySnapshot(message.params, { expectedAgentId: this.agentId });
  }

  #handleHostExit() {
    if (!this.agentId || !ACTIVE_PHASES.has(this.snapshot.phase)) return;
    this.#publish({
      ...idleSnapshot(this.agentId, this.snapshot.revision),
      phase: 'error',
      error: publicError('dictation_unavailable'),
    });
  }

  #handleReconnect() {
    if (!this.agentId || this.identity.getState?.()?.phase !== 'ready') return;
    this.open(this.agentId).catch(() => {});
  }

  #applySnapshot(value, { expectedAgentId } = {}) {
    const projected = projectSnapshot(value, expectedAgentId);
    if (!projected) return false;
    if (projected.revision < this.hostRevision) return true;
    if (projected.revision === this.hostRevision && !this.acceptEqualHostRevision) return true;
    this.hostRevision = projected.revision;
    this.acceptEqualHostRevision = false;
    this.#publish(projected);
    return true;
  }

  #reset() {
    this.#cancelHostDictation();
    this.lifecycleRevision += 1;
    this.operation = null;
    this.agentId = null;
    this.hostRevision = -1;
    this.acceptEqualHostRevision = false;
    this.#publish(idleSnapshot(null, 0));
  }

  #cancelHostDictation() {
    if (!ACTIVE_PHASES.has(this.snapshot.phase)) return;
    try {
      if (typeof this.host.cancelActiveDictation === 'function') {
        Promise.resolve(this.host.cancelActiveDictation()).catch(() => {});
        return;
      }
      if (this.snapshot.dictationId && typeof this.host.cancelDictation === 'function') {
        Promise.resolve(this.host.cancelDictation(this.snapshot.dictationId)).catch(() => {});
      }
    } catch {
      // Lifecycle cleanup is best-effort and must never block account teardown.
    }
  }

  #selectAgent(agentId) {
    if (this.agentId === agentId) return;
    this.lifecycleRevision += 1;
    this.agentId = agentId;
    this.hostRevision = -1;
    this.acceptEqualHostRevision = false;
    this.#publish(idleSnapshot(agentId, 0));
  }

  #publish(snapshot) {
    this.snapshot = deepFreeze(snapshot);
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

function projectSnapshot(value, expectedAgentId) {
  if (!isPlainObject(value)) return null;
  const phase = PHASES.has(value.phase) ? value.phase : null;
  const revision = Number.isSafeInteger(value.revision) && value.revision >= 0
    ? value.revision
    : null;
  const agentId = safeAgentId(value.agentId);
  if (!phase || revision === null || !agentId || agentId !== expectedAgentId) return null;
  const dictationId = value.dictationId == null
    ? null
    : DICTATION_ID_PATTERN.test(value.dictationId) ? value.dictationId : null;
  if (ACTIVE_PHASES.has(phase) && !dictationId) return null;
  const error = phase === 'error' ? projectError(value.error) : null;
  if (phase === 'error' && !error) return null;
  return {
    revision,
    phase,
    dictationId,
    agentId,
    interimText: safeText(value.interimText),
    transcript: safeText(value.transcript),
    error,
    service: projectService(value.service),
    limits: projectLimits(value.limits),
    disclosure: DICTATION_DISCLOSURE,
  };
}

function projectError(value) {
  const code = typeof value?.code === 'string' && PUBLIC_ERRORS.has(value.code)
    ? value.code
    : 'dictation_failed';
  return publicError(code);
}

function publicControllerError(error) {
  const code = typeof error?.code === 'string' && PUBLIC_ERRORS.has(error.code)
    ? error.code
    : 'dictation_unavailable';
  return publicError(code);
}

function publicError(code) {
  const normalized = PUBLIC_ERRORS.has(code) ? code : 'dictation_failed';
  return {
    code: normalized,
    message: PUBLIC_ERRORS.get(normalized),
  };
}

function projectService(value) {
  if (!isPlainObject(value)) return null;
  const serviceId = safeText(
    value.serviceId ?? value.providerProfileId,
    MAX_SERVICE_ID_CHARS,
  );
  const displayName = safeText(value.displayName, MAX_SERVICE_NAME_CHARS);
  const processing = value.processing === 'on_device' ? 'on_device' : 'provider';
  if (!serviceId || !displayName) return null;
  return { serviceId, displayName, processing };
}

function projectLimits(value) {
  const maxDurationSeconds = Number.isSafeInteger(value?.maxDurationSeconds)
    ? Math.min(Math.max(value.maxDurationSeconds, 1), MAX_DURATION_SECONDS)
    : MAX_DURATION_SECONDS;
  const maxAudioBytes = Number.isSafeInteger(value?.maxAudioBytes)
    ? Math.min(Math.max(value.maxAudioBytes, 1), MAX_AUDIO_BYTES)
    : MAX_AUDIO_BYTES;
  return { maxDurationSeconds, maxAudioBytes };
}

function idleSnapshot(agentId, revision) {
  return {
    revision,
    phase: 'idle',
    dictationId: null,
    agentId,
    interimText: '',
    transcript: '',
    error: null,
    service: null,
    limits: {
      maxDurationSeconds: MAX_DURATION_SECONDS,
      maxAudioBytes: MAX_AUDIO_BYTES,
    },
    disclosure: DICTATION_DISCLOSURE,
  };
}

function validateAgentId(value) {
  const normalized = String(value || '').trim();
  if (!AGENT_ID_PATTERN.test(normalized)) throw new Error('Agent ID 无效。');
  return normalized;
}

function safeAgentId(value) {
  return typeof value === 'string' && AGENT_ID_PATTERN.test(value) ? value : null;
}

function safeText(value, maxChars = MAX_TRANSCRIPT_CHARS) {
  if (typeof value !== 'string') return '';
  return [...value].slice(0, maxChars).join('');
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

module.exports = {
  ACTIVE_PHASES,
  DICTATION_DISCLOSURE,
  DictationController,
  projectSnapshot,
};
