'use strict';

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const {
  lstatSync,
  realpathSync,
} = require('node:fs');
const path = require('node:path');

const CHANGED_METHOD = 'x.agentmesh360/dictation/changed';
const DISCLOSURE = '语音只在这台 Mac 上转换为文字，不会上传到 AgentMesh360；听写结果只会放入输入框，不会自动发送。';
const MAX_DURATION_SECONDS = 60;
const MAX_AUDIO_BYTES = 1_920_000;
const MAX_TRANSCRIPT_CHARS = 20_000;
const MAX_HELPER_LINE_BYTES = 256 * 1024;
const HELPER_START_TIMEOUT_MS = 12_000;
const HELPER_PERMISSION_TIMEOUT_MS = 5 * 60_000;
const HELPER_FINAL_TIMEOUT_MS = 12_000;
const ACTIVE_PHASES = new Set(['starting', 'listening', 'transcribing']);
const SERVICE = Object.freeze({
  serviceId: 'macos-on-device-speech',
  displayName: 'macOS 本机听写',
  processing: 'on_device',
});
const HELPER_ERRORS = new Set([
  'invalid_dictation_request',
  'microphone_permission_denied',
  'microphone_unavailable',
  'speech_recognition_permission_denied',
  'speech_recognition_restricted',
  'dictation_language_unavailable',
  'dictation_on_device_unavailable',
  'dictation_no_speech',
  'dictation_failed',
]);

class MacOSLocalDictationService extends EventEmitter {
  constructor({
    app,
    platform = process.platform,
    helperPath = resolveLocalDictationHelperPath({ app }),
    spawnImpl = spawn,
    verifyHelperImpl = verifyLocalDictationHelper,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    environment = process.env,
  } = {}) {
    super();
    this.platform = platform;
    this.helperPath = helperPath;
    this.spawnImpl = spawnImpl;
    this.verifyHelperImpl = verifyHelperImpl;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.environment = createHelperEnvironment(environment);
    this.revision = 0;
    this.generation = 0;
    this.active = null;
    this.disposed = false;
  }

  async getDictationStatus(agentId) {
    const normalizedAgentId = validateAgentId(agentId);
    if (this.active?.agentId === normalizedAgentId) return this.#snapshot(this.active);
    return idleSnapshot(this.revision, normalizedAgentId);
  }

  async startDictation({ agentId, disclosureAccepted = false } = {}) {
    const normalizedAgentId = validateAgentId(agentId);
    if (disclosureAccepted !== true) {
      return this.#errorSnapshot(normalizedAgentId, 'dictation_disclosure_required');
    }
    if (this.disposed || this.platform !== 'darwin') {
      return this.#errorSnapshot(normalizedAgentId, 'dictation_unavailable');
    }
    if (this.active && ACTIVE_PHASES.has(this.active.phase)) {
      if (this.active.agentId === normalizedAgentId) return this.#snapshot(this.active);
      return this.#errorSnapshot(normalizedAgentId, 'dictation_busy');
    }

    try {
      this.verifyHelperImpl(this.helperPath);
    } catch {
      return this.#errorSnapshot(normalizedAgentId, 'dictation_helper_unavailable');
    }

    this.#discardTerminal();
    const generation = ++this.generation;
    const dictationId = `dict_${randomUUID().replaceAll('-', '')}`;
    let child;
    try {
      child = this.spawnImpl(this.helperPath, [], {
        detached: false,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: this.environment,
      });
    } catch {
      return this.#errorSnapshot(normalizedAgentId, 'dictation_helper_unavailable');
    }
    if (!child?.stdin || !child?.stdout || typeof child.on !== 'function') {
      child?.kill?.();
      return this.#errorSnapshot(normalizedAgentId, 'dictation_helper_unavailable');
    }

    this.revision += 1;
    const active = {
      generation,
      agentId: normalizedAgentId,
      dictationId,
      phase: 'starting',
      interimText: '',
      transcript: '',
      error: null,
      child,
      stdoutBuffer: Buffer.alloc(0),
      startTimer: null,
      durationTimer: null,
      finalTimer: null,
    };
    this.active = active;
    this.#armStartTimer(active, HELPER_START_TIMEOUT_MS);
    this.#bindChild(active);
    const snapshot = this.#snapshot(active);
    this.#emit(snapshot);
    return snapshot;
  }

  async stopDictation(dictationId) {
    const active = this.#requireActive(dictationId);
    if (active.phase === 'transcribing') return this.#snapshot(active);
    active.phase = 'transcribing';
    this.revision += 1;
    this.#clearTimer(active.durationTimer);
    active.durationTimer = null;
    const snapshot = this.#snapshot(active);
    this.#emit(snapshot);
    if (!this.#writeCommand(active, 'stop')) {
      return this.#fail(active, 'dictation_helper_unavailable');
    }
    active.finalTimer = this.setTimeoutImpl(() => {
      if (this.#isCurrent(active) && active.phase === 'transcribing') {
        this.#fail(active, active.interimText ? 'dictation_failed' : 'dictation_no_speech');
      }
    }, HELPER_FINAL_TIMEOUT_MS);
    return snapshot;
  }

  async cancelDictation(dictationId) {
    const active = this.#requireActive(dictationId);
    this.active = null;
    this.revision += 1;
    this.#clearActiveTimers(active);
    this.#writeCommand(active, 'cancel');
    this.#terminateChild(active);
    const snapshot = idleSnapshot(this.revision, active.agentId);
    this.#emit(snapshot);
    return snapshot;
  }

  cancelActiveDictation() {
    const active = this.active;
    if (!active || !ACTIVE_PHASES.has(active.phase)) return Promise.resolve(null);
    return this.cancelDictation(active.dictationId);
  }

  clearDictation(agentId) {
    const normalizedAgentId = validateAgentId(agentId);
    if (
      this.active?.agentId === normalizedAgentId
      && !ACTIVE_PHASES.has(this.active.phase)
    ) {
      const active = this.active;
      this.active = null;
      this.revision += 1;
      this.#clearActiveTimers(active);
      this.#terminateChild(active);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    const active = this.active;
    this.active = null;
    if (active) {
      this.#clearActiveTimers(active);
      this.#writeCommand(active, 'cancel');
      this.#terminateChild(active);
    }
    this.removeAllListeners();
  }

  #bindChild(active) {
    active.child.stdout.on('data', (chunk) => {
      if (!this.#isCurrent(active) || !Buffer.isBuffer(chunk)) return;
      active.stdoutBuffer = Buffer.concat([active.stdoutBuffer, chunk]);
      let newline;
      while ((newline = active.stdoutBuffer.indexOf(0x0A)) !== -1) {
        const line = active.stdoutBuffer.subarray(0, newline);
        active.stdoutBuffer = active.stdoutBuffer.subarray(newline + 1);
        if (line.length === 0 || line.length > MAX_HELPER_LINE_BYTES) {
          this.#fail(active, 'dictation_helper_protocol_error');
          return;
        }
        this.#handleHelperLine(active, line);
        if (!this.#isCurrent(active)) return;
      }
      if (active.stdoutBuffer.length > MAX_HELPER_LINE_BYTES) {
        this.#fail(active, 'dictation_helper_protocol_error');
      }
    });
    active.child.stderr?.on?.('data', () => {});
    active.child.on('error', () => {
      if (this.#isCurrent(active) && ACTIVE_PHASES.has(active.phase)) {
        this.#fail(active, 'dictation_helper_unavailable');
      }
    });
    active.child.on('exit', () => {
      if (this.#isCurrent(active) && ACTIVE_PHASES.has(active.phase)) {
        this.#fail(
          active,
          active.phase === 'starting' ? 'dictation_helper_unavailable' : 'dictation_failed',
          { terminate: false },
        );
      }
    });
  }

  #handleHelperLine(active, line) {
    let event;
    try {
      event = JSON.parse(line.toString('utf8'));
    } catch {
      this.#fail(active, 'dictation_helper_protocol_error');
      return;
    }
    if (!isPlainObject(event) || event.schemaVersion !== 1 || typeof event.type !== 'string') {
      this.#fail(active, 'dictation_helper_protocol_error');
      return;
    }
    if (event.type === 'permission_pending') {
      if (
        active.phase !== 'starting'
        || !['microphone', 'speech_recognition'].includes(event.permission)
      ) {
        this.#fail(active, 'dictation_helper_protocol_error');
        return;
      }
      this.#armStartTimer(active, HELPER_PERMISSION_TIMEOUT_MS);
      return;
    }
    if (event.type === 'ready') {
      if (
        active.phase !== 'starting'
        || event.engine !== 'macos_on_device_speech'
        || event.onDevice !== true
      ) {
        this.#fail(active, 'dictation_on_device_unavailable');
        return;
      }
      this.#clearTimer(active.startTimer);
      active.startTimer = null;
      active.phase = 'listening';
      this.revision += 1;
      active.durationTimer = this.setTimeoutImpl(() => {
        if (this.#isCurrent(active) && active.phase === 'listening') {
          this.stopDictation(active.dictationId).catch(() => {});
        }
      }, MAX_DURATION_SECONDS * 1_000);
      this.#emit(this.#snapshot(active));
      return;
    }
    if (event.type === 'partial') {
      if (active.phase !== 'listening' || typeof event.text !== 'string') {
        this.#fail(active, 'dictation_helper_protocol_error');
        return;
      }
      const text = safeText(event.text);
      if (!text || text === active.interimText) return;
      active.interimText = text;
      this.revision += 1;
      this.#emit(this.#snapshot(active));
      return;
    }
    if (event.type === 'final') {
      if (
        !['listening', 'transcribing'].includes(active.phase)
        || typeof event.text !== 'string'
      ) {
        this.#fail(active, 'dictation_helper_protocol_error');
        return;
      }
      const transcript = safeText(event.text).trim();
      if (!transcript) {
        this.#fail(active, 'dictation_no_speech');
        return;
      }
      active.phase = 'complete';
      active.interimText = '';
      active.transcript = transcript;
      active.error = null;
      this.revision += 1;
      this.#clearActiveTimers(active);
      this.#emit(this.#snapshot(active));
      return;
    }
    if (event.type === 'error') {
      const code = HELPER_ERRORS.has(event.code) ? event.code : 'dictation_failed';
      this.#fail(active, code);
      return;
    }
    if (event.type === 'cancelled' && !this.#isCurrent(active)) return;
    this.#fail(active, 'dictation_helper_protocol_error');
  }

  #fail(active, code, { terminate = true } = {}) {
    if (!this.#isCurrent(active)) return this.#snapshot(active);
    active.phase = 'error';
    active.interimText = '';
    active.transcript = '';
    active.error = { code };
    this.revision += 1;
    this.#clearActiveTimers(active);
    if (terminate) this.#terminateChild(active);
    const snapshot = this.#snapshot(active);
    this.#emit(snapshot);
    return snapshot;
  }

  #errorSnapshot(agentId, code) {
    this.revision += 1;
    const snapshot = {
      ...idleSnapshot(this.revision, agentId),
      phase: 'error',
      error: { code },
    };
    this.#emit(snapshot);
    return snapshot;
  }

  #snapshot(active) {
    return {
      revision: this.revision,
      phase: active.phase,
      dictationId: ACTIVE_PHASES.has(active.phase) ? active.dictationId : null,
      agentId: active.agentId,
      interimText: safeText(active.interimText),
      transcript: safeText(active.transcript),
      error: active.error ? { ...active.error } : null,
      service: { ...SERVICE },
      limits: limits(),
      disclosure: DISCLOSURE,
    };
  }

  #emit(snapshot) {
    queueMicrotask(() => {
      if (!this.disposed) {
        this.emit('notification', { method: CHANGED_METHOD, params: snapshot });
      }
    });
  }

  #requireActive(dictationId) {
    if (
      !this.active
      || !ACTIVE_PHASES.has(this.active.phase)
      || this.active.dictationId !== dictationId
    ) {
      const error = new Error('当前没有正在进行的听写。');
      error.code = 'dictation_not_found';
      throw error;
    }
    return this.active;
  }

  #writeCommand(active, command) {
    if (!active.child?.stdin?.writable || typeof active.child.stdin.write !== 'function') return false;
    try {
      return active.child.stdin.write(`${JSON.stringify({ schemaVersion: 1, command })}\n`) !== false;
    } catch {
      return false;
    }
  }

  #terminateChild(active) {
    const child = active.child;
    active.child = null;
    if (child && child.exitCode == null && child.killed !== true) child.kill?.('SIGTERM');
  }

  #clearActiveTimers(active) {
    for (const key of ['startTimer', 'durationTimer', 'finalTimer']) {
      this.#clearTimer(active[key]);
      active[key] = null;
    }
  }

  #clearTimer(timer) {
    if (timer != null) this.clearTimeoutImpl(timer);
  }

  #armStartTimer(active, timeoutMs) {
    this.#clearTimer(active.startTimer);
    active.startTimer = this.setTimeoutImpl(() => {
      if (this.#isCurrent(active) && active.phase === 'starting') {
        this.#fail(active, 'dictation_helper_unavailable');
      }
    }, timeoutMs);
  }

  #discardTerminal() {
    if (!this.active || ACTIVE_PHASES.has(this.active.phase)) return;
    const active = this.active;
    this.active = null;
    this.#clearActiveTimers(active);
    this.#terminateChild(active);
  }

  #isCurrent(active) {
    return !this.disposed
      && this.active === active
      && active.generation === this.generation;
  }
}

function resolveLocalDictationHelperPath({ app } = {}) {
  if (app?.isPackaged === true) {
    return path.resolve(
      process.resourcesPath,
      '../Helpers/AgentMesh360SpeechHelper.app/Contents/MacOS/agentmesh360-speech-helper',
    );
  }
  return path.resolve(
    __dirname,
    '../.native-build/AgentMesh360SpeechHelper.app/Contents/MacOS/agentmesh360-speech-helper',
  );
}

function verifyLocalDictationHelper(helperPath) {
  if (typeof helperPath !== 'string' || !path.isAbsolute(helperPath)) {
    throw new Error('local dictation helper path is invalid');
  }
  const direct = lstatSync(helperPath);
  if (!direct.isFile() || direct.isSymbolicLink() || (direct.mode & 0o111) === 0) {
    throw new Error('local dictation helper is invalid');
  }
  if (realpathSync(helperPath) !== helperPath) {
    throw new Error('local dictation helper path is not canonical');
  }
  return true;
}

function createHelperEnvironment(environment = {}) {
  const projected = {};
  for (const key of ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', '__CF_USER_TEXT_ENCODING']) {
    if (typeof environment[key] === 'string' && environment[key] !== '') {
      projected[key] = environment[key];
    }
  }
  return projected;
}

function validateAgentId(value) {
  const normalized = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,198}[a-z0-9]$/u.test(normalized)) {
    const error = new Error('Agent ID 无效。');
    error.code = 'invalid_dictation_request';
    throw error;
  }
  return normalized;
}

function safeText(value) {
  if (typeof value !== 'string') return '';
  const text = Array.from(value).slice(0, MAX_TRANSCRIPT_CHARS).join('');
  if (/\u0000|[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(text)) {
    return '';
  }
  return text;
}

function limits() {
  return {
    maxDurationSeconds: MAX_DURATION_SECONDS,
    maxAudioBytes: MAX_AUDIO_BYTES,
  };
}

function idleSnapshot(revision, agentId) {
  return {
    revision,
    phase: 'idle',
    dictationId: null,
    agentId,
    interimText: '',
    transcript: '',
    error: null,
    service: { ...SERVICE },
    limits: limits(),
    disclosure: DISCLOSURE,
  };
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

module.exports = {
  CHANGED_METHOD,
  DISCLOSURE,
  MacOSLocalDictationService,
  SERVICE,
  createHelperEnvironment,
  resolveLocalDictationHelperPath,
  verifyLocalDictationHelper,
};
