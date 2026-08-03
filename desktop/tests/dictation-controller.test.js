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
    /请先确认录音会交给所选听写服务进行转写/,
  );
  await controller.open('job-agent');
  const listening = await controller.start('job-agent', { disclosureAccepted: true });

  assert.equal(listening.phase, 'listening');
  assert.equal(listening.disclosure, DICTATION_DISCLOSURE);
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
  controller.dispose();
});

test('dictation public projection redacts unknown Host errors and bounds public data', () => {
  const projected = projectSnapshot({
    ...snapshot({ revision: 7, phase: 'error' }),
    error: {
      code: 'upstream_secret_error',
      message: 'Authorization: Bearer secret-provider-key',
    },
    interimText: '字'.repeat(20_050),
    service: {
      providerProfileId: 'profile-xai',
      displayName: 'xAI',
      apiKey: 'must-not-project',
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
    providerProfileId: 'profile-xai',
    displayName: 'xAI',
  });
  assert.deepEqual(projected.limits, {
    maxDurationSeconds: 60,
    maxAudioBytes: 1_920_000,
  });
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /secret-provider-key|apiKey|authorization/i);
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

test('a same-revision provider failure replaces only the local optimistic start state', async () => {
  const identity = new FakeIdentity(readyState(41));
  const host = new FakeHost();
  host.startImpl = async () => snapshot({
    revision: 0,
    phase: 'error',
    dictationId: null,
    error: {
      code: 'dictation_provider_required',
      message: 'untrusted raw detail',
    },
    service: null,
  });
  const controller = new DictationController({ identity, host });
  await controller.open('job-agent');

  const result = await controller.start('job-agent', { disclosureAccepted: true });

  assert.equal(result.phase, 'error');
  assert.deepEqual(result.error, {
    code: 'dictation_provider_required',
    message: '需要配置支持听写的模型供应商。',
  });
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
    this.calls = { status: [], start: [], stop: [], cancel: [], prompt: [] };
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
      providerProfileId: 'profile-xai',
      displayName: 'xAI',
    },
    limits: {
      maxDurationSeconds: 60,
      maxAudioBytes: 1_920_000,
    },
    disclosure: DICTATION_DISCLOSURE,
    ...overrides,
  };
}
