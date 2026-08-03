'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CHANGED_METHOD,
  DISCLOSURE,
  MacOSLocalDictationService,
  SERVICE,
  createHelperEnvironment,
  verifyLocalDictationHelper,
} = require('../src/local-dictation-service');

const AGENT_ID = 'job-agent';
const HELPER_PATH = '/Applications/AgentMesh360.app/Contents/Helpers/AgentMesh360SpeechHelper.app/Contents/MacOS/agentmesh360-speech-helper';

class FakeStream extends EventEmitter {}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.stdin = {
      writable: true,
      writes: [],
      write: (value) => {
        this.stdin.writes.push(String(value));
        return true;
      },
    };
    this.exitCode = null;
    this.killed = false;
    this.signals = [];
  }

  helperEvent(event) {
    this.stdout.emit('data', Buffer.from(`${JSON.stringify({ schemaVersion: 1, ...event })}\n`));
  }

  rawStdout(value) {
    this.stdout.emit('data', Buffer.isBuffer(value) ? value : Buffer.from(value));
  }

  kill(signal) {
    this.killed = true;
    this.signals.push(signal);
    return true;
  }
}

function createHarness({ environment, serviceOptions = {} } = {}) {
  const children = [];
  const spawnCalls = [];
  const service = new MacOSLocalDictationService({
    platform: 'darwin',
    helperPath: HELPER_PATH,
    verifyHelperImpl: () => true,
    environment: environment || {
      HOME: '/Users/tester',
      LANG: 'zh_CN.UTF-8',
      TMPDIR: '/private/tmp/tester/',
      PATH: '/secret/bin',
      OPENAI_API_KEY: 'openai-secret',
      XAI_API_KEY: 'xai-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      AGENTMESH_TOKEN: 'core-secret',
    },
    spawnImpl: (command, args, options) => {
      const child = new FakeChild();
      children.push(child);
      spawnCalls.push({ command, args, options });
      return child;
    },
    ...serviceOptions,
  });
  return { service, children, spawnCalls };
}

function ready(child, overrides = {}) {
  child.helperEvent({
    type: 'ready',
    engine: 'macos_on_device_speech',
    onDevice: true,
    ...overrides,
  });
}

function permissionPending(child, permission) {
  child.helperEvent({ type: 'permission_pending', permission });
}

async function snapshot(service) {
  await Promise.resolve();
  return service.getDictationStatus(AGENT_ID);
}

test('local dictation follows ready/listening/partial/stop/final without a Provider or automatic send', async () => {
  const { service, children, spawnCalls } = createHarness();
  const notifications = [];
  service.on('notification', (value) => notifications.push(value));

  const starting = await service.startDictation({
    agentId: AGENT_ID,
    disclosureAccepted: true,
  });
  assert.equal(starting.phase, 'starting');
  assert.equal(starting.disclosure, DISCLOSURE);
  assert.deepEqual(starting.service, SERVICE);
  assert.equal(children.length, 1);

  const child = children[0];
  ready(child);
  assert.equal((await snapshot(service)).phase, 'listening');

  child.helperEvent({ type: 'partial', text: '这是尚未完成的文字' });
  assert.deepEqual(await snapshot(service), {
    revision: 3,
    phase: 'listening',
    dictationId: starting.dictationId,
    agentId: AGENT_ID,
    interimText: '这是尚未完成的文字',
    transcript: '',
    error: null,
    service: { ...SERVICE },
    limits: { maxDurationSeconds: 60, maxAudioBytes: 1_920_000 },
    disclosure: DISCLOSURE,
  });

  const transcribing = await service.stopDictation(starting.dictationId);
  assert.equal(transcribing.phase, 'transcribing');
  assert.deepEqual(JSON.parse(child.stdin.writes.at(-1)), {
    schemaVersion: 1,
    command: 'stop',
  });

  child.helperEvent({ type: 'final', text: '这是可以编辑的最终文字' });
  const complete = await snapshot(service);
  assert.equal(complete.phase, 'complete');
  assert.equal(complete.dictationId, null);
  assert.equal(complete.interimText, '');
  assert.equal(complete.transcript, '这是可以编辑的最终文字');
  assert.equal(child.killed, false);

  assert.deepEqual(spawnCalls, [{
    command: HELPER_PATH,
    args: [],
    options: {
      detached: false,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        HOME: '/Users/tester',
        LANG: 'zh_CN.UTF-8',
        TMPDIR: '/private/tmp/tester/',
      },
    },
  }]);
  assert.ok(notifications.length >= 5);
  assert.ok(notifications.every((item) => item.method === CHANGED_METHOD));
  assert.doesNotMatch(JSON.stringify({ spawnCalls, notifications }), /api[_-]?key|bearer|openai-secret|xai-secret|anthropic-secret|core-secret/i);

  service.dispose();
});

test('on-device capability is fail-closed and never falls back to a cloud service', async () => {
  const { service, children } = createHarness();
  const starting = await service.startDictation({ agentId: AGENT_ID, disclosureAccepted: true });

  ready(children[0], { onDevice: false });
  const failed = await snapshot(service);
  assert.equal(failed.phase, 'error');
  assert.deepEqual(failed.error, { code: 'dictation_on_device_unavailable' });
  assert.equal(failed.service.processing, 'on_device');
  assert.equal(children[0].killed, true);
  assert.equal(starting.dictationId !== null, true);

  service.dispose();
});

test('the 60-second local limit stops transcription without sending or selecting a Provider', async () => {
  const timers = [];
  const { service, children } = createHarness({
    serviceOptions: {
      setTimeoutImpl: (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeoutImpl: (timer) => {
        timer.cleared = true;
      },
    },
  });
  await service.startDictation({ agentId: AGENT_ID, disclosureAccepted: true });
  const child = children[0];
  ready(child);

  const durationTimer = timers.find((timer) => timer.delay === 60_000 && !timer.cleared);
  assert.ok(durationTimer);
  durationTimer.callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal((await snapshot(service)).phase, 'transcribing');
  assert.deepEqual(JSON.parse(child.stdin.writes.at(-1)), {
    schemaVersion: 1,
    command: 'stop',
  });
  assert.equal(timers.some((timer) => timer.delay === 12_000 && !timer.cleared), true);
  service.dispose();
});

test('first-run system permission prompts extend a bounded startup watchdog', async () => {
  const timers = [];
  const { service, children } = createHarness({
    serviceOptions: {
      setTimeoutImpl: (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeoutImpl: (timer) => {
        timer.cleared = true;
      },
    },
  });
  await service.startDictation({ agentId: AGENT_ID, disclosureAccepted: true });
  const child = children[0];
  const initialTimer = timers.at(-1);
  assert.equal(initialTimer.delay, 12_000);

  permissionPending(child, 'microphone');
  const microphoneTimer = timers.at(-1);
  assert.equal(initialTimer.cleared, true);
  assert.equal(microphoneTimer.delay, 5 * 60_000);

  permissionPending(child, 'speech_recognition');
  const speechTimer = timers.at(-1);
  assert.equal(microphoneTimer.cleared, true);
  assert.equal(speechTimer.delay, 5 * 60_000);
  assert.equal(child.killed, false);
  assert.equal((await snapshot(service)).phase, 'starting');

  ready(child);
  assert.equal(speechTimer.cleared, true);
  assert.equal((await snapshot(service)).phase, 'listening');
  service.dispose();
});

test('a permission prompt that never resolves still fails closed after five minutes', async () => {
  const timers = [];
  const { service, children } = createHarness({
    serviceOptions: {
      setTimeoutImpl: (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeoutImpl: (timer) => {
        timer.cleared = true;
      },
    },
  });
  await service.startDictation({ agentId: AGENT_ID, disclosureAccepted: true });
  permissionPending(children[0], 'microphone');
  const permissionTimer = timers.at(-1);
  assert.equal(permissionTimer.delay, 5 * 60_000);

  permissionTimer.callback();
  const failed = await snapshot(service);
  assert.equal(failed.phase, 'error');
  assert.deepEqual(failed.error, { code: 'dictation_helper_unavailable' });
  assert.equal(children[0].killed, true);
  service.dispose();
});

test('a helper cannot publish a final transcript before proving on-device readiness', async () => {
  const { service, children } = createHarness();
  await service.startDictation({ agentId: AGENT_ID, disclosureAccepted: true });

  children[0].helperEvent({ type: 'final', text: '未经本机能力确认的文字' });
  const failed = await snapshot(service);

  assert.equal(failed.phase, 'error');
  assert.deepEqual(failed.error, { code: 'dictation_helper_protocol_error' });
  assert.equal(failed.transcript, '');
  assert.equal(children[0].killed, true);
  service.dispose();
});

test('permission and local-model helper errors remain stable local error codes', async (t) => {
  const cases = [
    'microphone_permission_denied',
    'speech_recognition_permission_denied',
    'speech_recognition_restricted',
    'dictation_language_unavailable',
    'dictation_on_device_unavailable',
  ];

  for (const code of cases) {
    await t.test(code, async () => {
      const { service, children } = createHarness();
      await service.startDictation({ agentId: AGENT_ID, disclosureAccepted: true });
      ready(children[0]);
      children[0].helperEvent({ type: 'error', code, message: 'must not be projected' });

      const failed = await snapshot(service);
      assert.equal(failed.phase, 'error');
      assert.deepEqual(failed.error, { code });
      assert.doesNotMatch(JSON.stringify(failed), /must not be projected/);
      assert.equal(children[0].killed, true);
      service.dispose();
    });
  }
});

test('malformed and overlong helper output fails closed as a protocol error', async (t) => {
  await t.test('malformed JSON', async () => {
    const { service, children } = createHarness();
    await service.startDictation({ agentId: AGENT_ID, disclosureAccepted: true });
    children[0].rawStdout('{not-json}\n');

    const failed = await snapshot(service);
    assert.equal(failed.phase, 'error');
    assert.deepEqual(failed.error, { code: 'dictation_helper_protocol_error' });
    assert.equal(children[0].killed, true);
    service.dispose();
  });

  await t.test('overlong JSONL record', async () => {
    const { service, children } = createHarness();
    await service.startDictation({ agentId: AGENT_ID, disclosureAccepted: true });
    children[0].rawStdout(Buffer.alloc((256 * 1024) + 1, 0x61));

    const failed = await snapshot(service);
    assert.equal(failed.phase, 'error');
    assert.deepEqual(failed.error, { code: 'dictation_helper_protocol_error' });
    assert.equal(children[0].killed, true);
    service.dispose();
  });

  await t.test('multiple valid records may share one chunk larger than 64 KiB', async () => {
    const { service, children } = createHarness();
    await service.startDictation({ agentId: AGENT_ID, disclosureAccepted: true });
    const child = children[0];
    ready(child);
    const first = JSON.stringify({
      schemaVersion: 1,
      type: 'partial',
      text: `甲${'a'.repeat(40_000)}`,
    });
    const second = JSON.stringify({
      schemaVersion: 1,
      type: 'partial',
      text: `乙${'b'.repeat(40_000)}`,
    });
    child.rawStdout(`${first}\n${second}\n`);

    const listening = await snapshot(service);
    assert.equal(listening.phase, 'listening');
    assert.equal(listening.error, null);
    assert.equal(Array.from(listening.interimText).length, 20_000);
    assert.equal(listening.interimText.startsWith('乙'), true);
    service.dispose();
  });
});

test('helper crashes become availability or transcription failures without leaking stderr', async (t) => {
  await t.test('crash before ready', async () => {
    const { service, children } = createHarness();
    await service.startDictation({ agentId: AGENT_ID, disclosureAccepted: true });
    children[0].stderr.emit('data', Buffer.from('Authorization: Bearer helper-secret'));
    children[0].emit('exit', 1, null);

    const failed = await snapshot(service);
    assert.deepEqual(failed.error, { code: 'dictation_helper_unavailable' });
    assert.doesNotMatch(JSON.stringify(failed), /helper-secret|authorization|bearer/i);
    service.dispose();
  });

  await t.test('crash while listening', async () => {
    const { service, children } = createHarness();
    await service.startDictation({ agentId: AGENT_ID, disclosureAccepted: true });
    ready(children[0]);
    children[0].emit('exit', 1, null);

    const failed = await snapshot(service);
    assert.deepEqual(failed.error, { code: 'dictation_failed' });
    service.dispose();
  });
});

test('cancel terminates the helper and ignores all stale events from that process', async () => {
  const { service, children } = createHarness();
  const phases = [];
  service.on('notification', ({ params }) => phases.push(params.phase));
  await service.startDictation({ agentId: AGENT_ID, disclosureAccepted: true });
  const child = children[0];
  ready(child);

  const cancelled = await service.cancelActiveDictation();
  assert.equal(cancelled.phase, 'idle');
  assert.equal(child.killed, true);
  assert.deepEqual(JSON.parse(child.stdin.writes.at(-1)), {
    schemaVersion: 1,
    command: 'cancel',
  });

  child.helperEvent({ type: 'final', text: '取消后不应出现的旧文字' });
  child.emit('error', new Error('stale child'));
  child.emit('exit', 1, null);
  const afterStaleEvents = await snapshot(service);
  assert.equal(afterStaleEvents.phase, 'idle');
  assert.equal(afterStaleEvents.transcript, '');
  assert.ok(!phases.includes('complete'));
  assert.ok(!phases.includes('error'));

  service.dispose();
});

test('helper environment is a strict allowlist and excludes Provider credentials', () => {
  const environment = createHelperEnvironment({
    HOME: '/Users/tester',
    LANG: 'zh_CN.UTF-8',
    LC_ALL: '',
    LC_CTYPE: 'zh_CN.UTF-8',
    TMPDIR: '/private/tmp/tester/',
    __CF_USER_TEXT_ENCODING: '0x1F5:0x19:0x34',
    PATH: '/usr/local/bin',
    OPENAI_API_KEY: 'secret-a',
    XAI_API_KEY: 'secret-b',
    ANTHROPIC_API_KEY: 'secret-c',
    AGENTMESH_TOKEN: 'secret-d',
  });

  assert.deepEqual(environment, {
    HOME: '/Users/tester',
    LANG: 'zh_CN.UTF-8',
    LC_CTYPE: 'zh_CN.UTF-8',
    TMPDIR: '/private/tmp/tester/',
    __CF_USER_TEXT_ENCODING: '0x1F5:0x19:0x34',
  });
  assert.doesNotMatch(JSON.stringify(environment), /key|token|secret|path/i);
});

test('helper verification accepts only an executable regular file at a canonical non-symlink path', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agentmesh360-dictation-helper-'));
  const helper = path.join(root, 'helper');
  const nonExecutable = path.join(root, 'non-executable');
  const symlink = path.join(root, 'helper-link');
  try {
    writeFileSync(helper, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    chmodSync(helper, 0o700);
    writeFileSync(nonExecutable, 'not executable', { mode: 0o600 });
    chmodSync(nonExecutable, 0o600);
    symlinkSync(helper, symlink);

    const canonicalHelper = realpathSync(helper);
    assert.equal(verifyLocalDictationHelper(canonicalHelper), true);
    assert.throws(() => verifyLocalDictationHelper(nonExecutable), /helper is invalid/);
    assert.throws(() => verifyLocalDictationHelper(symlink), /helper is invalid/);
    assert.throws(() => verifyLocalDictationHelper('relative/helper'), /path is invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
