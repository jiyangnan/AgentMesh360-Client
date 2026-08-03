'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  DICTATION_DISCLOSURE,
  DictationController,
  projectSnapshot,
} = require('../src/dictation-controller');

test('dictation produces editable text only and never submits a conversation prompt', async () => {
  const identity = new FakeIdentity(readyState(41));
  const host = new FakeHost();
  const controller = new DictationController({ identity, host });
  const phases = [];
  controller.subscribe((snapshot) => phases.push(snapshot.phase));

  await assert.rejects(
    controller.start('job-agent'),
    /请先确认使用 macOS 本机听写/,
  );
  await controller.open('job-agent');
  const listening = await controller.start('job-agent', { disclosureAccepted: true });

  assert.equal(listening.phase, 'listening');
  assert.equal(
    DICTATION_DISCLOSURE,
    '语音只在这台 Mac 上转换为文字，不会上传到 AgentMesh360；听写结果只会放入输入框，不会自动发送。',
  );
  assert.equal(listening.disclosure, DICTATION_DISCLOSURE);
  assert.deepEqual(listening.service, {
    serviceId: 'macos-on-device-speech',
    displayName: 'macOS 本机听写',
    processing: 'on_device',
  });
  assert.deepEqual(host.calls.start[0], {
    agentId: 'job-agent',
    disclosureAccepted: true,
  });
  assert.equal(host.calls.prompt.length, 0);

  const transcribing = await controller.stop();
  assert.equal(transcribing.phase, 'transcribing');
  host.emit('notification', {
    method: 'x.agentmesh360/dictation/changed',
    params: snapshot({
      revision: 4,
      phase: 'complete',
      transcript: '这是可编辑的听写文本',
    }),
  });

  assert.equal(controller.getSnapshot().phase, 'complete');
  assert.equal(controller.getSnapshot().transcript, '这是可编辑的听写文本');
  assert.equal(host.calls.prompt.length, 0);
  assert.ok(phases.includes('starting'));
  assert.ok(phases.includes('transcribing'));
  const closed = controller.close();
  assert.equal(closed.phase, 'idle');
  assert.equal(closed.agentId, null);
  assert.deepEqual(host.calls.clear, ['job-agent']);
  controller.dispose();
});

test('dictation is account and Agent scoped and resets on account switch', async () => {
  const identity = new FakeIdentity(readyState(41));
  const host = new FakeHost();
  const controller = new DictationController({ identity, host });

  await controller.open('job-agent');
  await controller.start('job-agent', { disclosureAccepted: true });
  host.emit('notification', {
    method: '_x.agentmesh360/dictation/changed',
    params: snapshot({ revision: 3, agentId: 'deploy-agent', transcript: 'wrong Agent' }),
  });
  assert.equal(controller.getSnapshot().agentId, 'job-agent');
  assert.equal(controller.getSnapshot().transcript, '');

  identity.setState(readyState(42));
  assert.equal(controller.getSnapshot().phase, 'idle');
  assert.equal(controller.getSnapshot().agentId, null);
  assert.equal(controller.getSnapshot().transcript, '');
  assert.equal(host.calls.cancelActive, 1);
  controller.dispose();
});

test('on-device dictation projection redacts unknown Host data and bounds public data', () => {
  const projected = projectSnapshot({
    ...snapshot({ revision: 7, phase: 'error' }),
    error: {
      code: 'upstream_secret_error',
      message: 'Authorization: Bearer secret-provider-key',
    },
    interimText: '字'.repeat(20_050),
    service: {
      serviceId: 'macos-on-device-speech',
      displayName: 'macOS 本机听写',
      processing: 'on_device',
      apiKey: 'must-not-project',
      modelPath: '/private/on-device/model',
    },
    limits: {
      maxDurationSeconds: 99_999,
      maxAudioBytes: 99_999_999,
    },
  }, 'job-agent');

  assert.equal(projected.error.code, 'dictation_failed');
  assert.equal(projected.error.message, '听写没有完成，请稍后重试。');
  assert.equal(projected.interimText.length, 20_000);
  assert.deepEqual(projected.service, {
    serviceId: 'macos-on-device-speech',
    displayName: 'macOS 本机听写',
    processing: 'on_device',
  });
  assert.deepEqual(projected.limits, {
    maxDurationSeconds: 60,
    maxAudioBytes: 1_920_000,
  });
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /secret-provider-key|apiKey|authorization|modelPath|\/private\//i);
});

test('on-device model and permission failures use stable local-only guidance', () => {
  const expectations = new Map([
    [
      'dictation_on_device_unavailable',
      '这台 Mac 尚未准备好本机听写，请在“系统设置 → 键盘 → 听写”中启用并下载当前语言。',
    ],
    [
      'dictation_language_unavailable',
      '当前系统语言不支持听写，请在系统设置中选择可用的听写语言。',
    ],
    [
      'microphone_permission_denied',
      '没有麦克风权限，请在系统设置中允许 AgentMesh360 使用麦克风。',
    ],
    [
      'speech_recognition_permission_denied',
      '没有语音识别权限，请在系统设置中允许 AgentMesh360 使用语音识别。',
    ],
    [
      'speech_recognition_restricted',
      '这台 Mac 当前限制了语音识别，请检查系统隐私与家长控制设置。',
    ],
  ]);

  for (const [code, message] of expectations) {
    const projected = projectSnapshot(snapshot({
      revision: 7,
      phase: 'error',
      dictationId: null,
      service: null,
      error: { code, message: 'untrusted helper detail' },
    }), 'job-agent');
    assert.deepEqual(projected.error, { code, message });
  }
});

test('a second start is rejected without corrupting the in-flight dictation state', async () => {
  const identity = new FakeIdentity(readyState(41));
  const host = new FakeHost();
  let resolveStart;
  host.startImpl = () => new Promise((resolve) => { resolveStart = resolve; });
  const controller = new DictationController({ identity, host });
  await controller.open('job-agent');

  const first = controller.start('job-agent', { disclosureAccepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getSnapshot().phase, 'starting');
  await assert.rejects(
    controller.start('job-agent', { disclosureAccepted: true }),
    /听写操作正在进行/u,
  );
  assert.equal(controller.getSnapshot().phase, 'starting');
  assert.equal(host.calls.start.length, 1);

  resolveStart(snapshot({ revision: 2, phase: 'listening' }));
  assert.equal((await first).phase, 'listening');
  controller.dispose();
});

test('an old start response cannot publish after account switch or dispose', async () => {
  const identity = new FakeIdentity(readyState(41));
  const host = new FakeHost();
  let resolveFirstStart;
  host.startImpl = () => new Promise((resolve) => { resolveFirstStart = resolve; });
  const controller = new DictationController({ identity, host });
  const published = [];
  controller.subscribe((value) => published.push({ phase: value.phase, agentId: value.agentId }));
  await controller.open('job-agent');

  const staleAfterSwitch = controller.start('job-agent', { disclosureAccepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  identity.setState(readyState(42));
  const switchBoundary = published.length;
  resolveFirstStart(snapshot({ revision: 9, phase: 'complete', transcript: '旧账号文字' }));
  await staleAfterSwitch;

  assert.deepEqual(controller.getSnapshot(), {
    revision: 0,
    phase: 'idle',
    dictationId: null,
    agentId: null,
    interimText: '',
    transcript: '',
    error: null,
    service: null,
    limits: { maxDurationSeconds: 60, maxAudioBytes: 1_920_000 },
    disclosure: DICTATION_DISCLOSURE,
  });
  assert.deepEqual(published.slice(switchBoundary), []);

  let resolveSecondStart;
  host.startImpl = () => new Promise((resolve) => { resolveSecondStart = resolve; });
  await controller.open('job-agent');
  const staleAfterDispose = controller.start('job-agent', { disclosureAccepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  controller.dispose();
  resolveSecondStart(snapshot({ revision: 10, phase: 'complete', transcript: '销毁后的文字' }));
  await staleAfterDispose;
  assert.equal(controller.getSnapshot().phase, 'idle');
  assert.equal(controller.getSnapshot().agentId, null);
  assert.equal(controller.getSnapshot().transcript, '');
});

test('an older direct response cannot overwrite a newer same-Agent notification', async () => {
  const identity = new FakeIdentity(readyState(41));
  const host = new FakeHost();
  const controller = new DictationController({ identity, host });
  await controller.open('job-agent');
  await controller.start('job-agent', { disclosureAccepted: true });
  let resolveStop;
  host.stopImpl = () => new Promise((resolve) => { resolveStop = resolve; });

  const stopping = controller.stop();
  await new Promise((resolve) => setImmediate(resolve));
  host.emit('notification', {
    method: 'x.agentmesh360/dictation/changed',
    params: snapshot({
      revision: 4,
      phase: 'complete',
      transcript: '较新的最终文字',
    }),
  });
  resolveStop(snapshot({ revision: 3, phase: 'transcribing', transcript: '' }));
  const result = await stopping;

  assert.equal(result.phase, 'complete');
  assert.equal(result.revision, 4);
  assert.equal(result.transcript, '较新的最终文字');
  assert.equal(controller.getSnapshot(), result);
  controller.dispose();
});

test('a same-revision on-device model failure replaces only the local optimistic start state', async () => {
  const identity = new FakeIdentity(readyState(41));
  const host = new FakeHost();
  host.startImpl = async () => snapshot({
    revision: 0,
    phase: 'error',
    dictationId: null,
    error: {
      code: 'dictation_on_device_unavailable',
      message: 'untrusted raw detail',
    },
    service: null,
  });
  const controller = new DictationController({ identity, host });
  await controller.open('job-agent');

  const result = await controller.start('job-agent', { disclosureAccepted: true });

  assert.equal(result.phase, 'error');
  assert.deepEqual(result.error, {
    code: 'dictation_on_device_unavailable',
    message: '这台 Mac 尚未准备好本机听写，请在“系统设置 → 键盘 → 听写”中启用并下载当前语言。',
  });
  controller.dispose();
});

test('clearDictation runs only after a terminal result is closed', async () => {
  const identity = new FakeIdentity(readyState(41));
  const host = new FakeHost();
  const controller = new DictationController({ identity, host });
  await controller.open('job-agent');
  await controller.start('job-agent', { disclosureAccepted: true });

  assert.throws(() => controller.close(), /请先停止或取消当前听写/u);
  assert.deepEqual(host.calls.clear, []);
  host.emit('notification', {
    method: 'x.agentmesh360/dictation/changed',
    params: snapshot({ revision: 4, phase: 'complete', transcript: '本机听写结果' }),
  });
  controller.close();

  assert.deepEqual(host.calls.clear, ['job-agent']);
  controller.dispose();
});

class FakeIdentity {
  constructor(state) {
    this.state = state;
    this.listeners = new Set();
  }

  getState() {
    return this.state;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  setState(state) {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

class FakeHost extends EventEmitter {
  constructor() {
    super();
    this.calls = {
      status: [],
      start: [],
      stop: [],
      cancel: [],
      cancelActive: 0,
      clear: [],
      prompt: [],
    };
  }

  async getDictationStatus(agentId) {
    this.calls.status.push(agentId);
    return snapshot({ revision: 0, phase: 'idle', dictationId: null, agentId });
  }

  async startDictation(request) {
    this.calls.start.push(request);
    if (this.startImpl) return this.startImpl(request);
    return snapshot({ revision: 2, phase: 'listening' });
  }

  async stopDictation(dictationId) {
    this.calls.stop.push(dictationId);
    if (this.stopImpl) return this.stopImpl(dictationId);
    return snapshot({ revision: 3, phase: 'transcribing' });
  }

  async cancelDictation(dictationId) {
    this.calls.cancel.push(dictationId);
    return snapshot({ revision: 4, phase: 'idle', dictationId: null });
  }

  async cancelActiveDictation() {
    this.calls.cancelActive += 1;
  }

  clearDictation(agentId) {
    this.calls.clear.push(agentId);
  }

  async promptSession(value) {
    this.calls.prompt.push(value);
  }
}

function readyState(accountId) {
  return {
    phase: 'ready',
    account: { id: accountId },
    access: { canEnterClient: true },
    agents: [
      { agentId: 'job-agent' },
      { agentId: 'deploy-agent' },
    ],
  };
}

function snapshot(overrides = {}) {
  return {
    revision: 1,
    phase: 'listening',
    dictationId: 'dict_test',
    agentId: 'job-agent',
    interimText: '',
    transcript: '',
    error: null,
    service: {
      serviceId: 'macos-on-device-speech',
      displayName: 'macOS 本机听写',
      processing: 'on_device',
    },
    limits: {
      maxDurationSeconds: 60,
      maxAudioBytes: 1_920_000,
    },
    disclosure: DICTATION_DISCLOSURE,
    ...overrides,
  };
}
