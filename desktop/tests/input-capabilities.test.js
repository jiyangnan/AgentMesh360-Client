'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  AgentConversationController,
  projectInputCapabilities,
  validatePrompt,
  validatePromptRequest,
} = require('../src/conversation-controller');

test('all prompt entry validators reject non-product Slash commands', () => {
  for (const dangerous of ['/yolo', '/hooks install attacker', '/always-approve true', '//shell']) {
    assert.throws(() => validatePrompt(dangerous), /命令未获客户端允许/u);
    assert.throws(
      () => validatePromptRequest({ text: dangerous, attachmentIds: [] }),
      /命令未获客户端允许/u,
    );
  }
  assert.equal(validatePrompt('/compact 保留当前目标'), '/compact 保留当前目标');
  assert.equal(validatePrompt('/context'), '/context');
  assert.deepEqual(
    validatePromptRequest({ text: '/session-info', attachmentIds: [] }),
    { text: '/session-info', attachmentIds: [] },
  );
  assert.equal(validatePrompt('请解释 /yolo 为什么危险'), '请解释 /yolo 为什么危险');
});

test('input capability projection never exposes dangerous Host commands or private fields', () => {
  assert.throws(
    () => projectInputCapabilities({
      schemaVersion: 1,
      revision: 1,
      agentId: 'job-agent',
      commands: [{
        id: 'always-approve',
        trigger: '/yolo',
        displayName: 'danger',
        description: 'danger',
      }],
      skills: [],
    }, 'job-agent'),
    /输入能力暂时不可用/u,
  );

  const projected = projectInputCapabilities({
    schemaVersion: 1,
    revision: 2,
    agentId: 'job-agent',
    sessionId: 'private-main-session',
    cwd: '/private/account/job-agent',
    commands: [{
      id: 'compact',
      trigger: '/compact',
      displayName: 'attacker controlled',
      description: 'sk-private',
      privatePath: '/private/commands/compact',
    }],
    skills: [{
      id: 'career-profile',
      trigger: '$career-profile',
      displayName: '建立求职档案',
      description: '梳理背景和目标。',
      promptText: '请帮我建立求职档案。',
      path: '/private/SKILL.md',
      packageId: 'private-package-id',
      signatureKeyId: 'private-key-id',
    }],
  }, 'job-agent');

  assert.deepEqual(projected.commands, [{
    id: 'compact',
    trigger: '/compact',
    displayName: '压缩当前对话',
    description: '压缩较早的对话内容，同时保留当前任务需要的上下文。',
    argumentHint: '可选：说明必须保留的内容',
  }]);
  assert.deepEqual(projected.skills, [{
    id: 'career-profile',
    trigger: '$career-profile',
    displayName: '建立求职档案',
    description: '梳理背景和目标。',
    promptText: '请帮我建立求职档案。',
  }]);
  const serialized = JSON.stringify(projected);
  for (const forbidden of [
    'private-main-session',
    '/private/',
    'sk-private',
    'private-package-id',
    'private-key-id',
    'always-approve',
    'yolo',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('input capability projection rejects duplicate Skills and a mismatched Agent', () => {
  const skill = {
    id: 'career-profile',
    trigger: '$career-profile',
    displayName: '建立求职档案',
    description: '梳理背景和目标。',
    promptText: '请帮我建立求职档案。',
  };
  assert.throws(
    () => projectInputCapabilities({
      schemaVersion: 1,
      revision: 3,
      agentId: 'job-agent',
      commands: [],
      skills: [skill, skill],
    }, 'job-agent'),
    /输入能力暂时不可用/u,
  );
  assert.throws(
    () => projectInputCapabilities({
      schemaVersion: 1,
      revision: 4,
      agentId: 'deploy-agent',
      commands: [],
      skills: [],
    }, 'job-agent'),
    /输入能力暂时不可用/u,
  );
});

test('Controller injects private authority and rejects a capability response after Agent switch', async () => {
  const fixture = makeFixture();
  await fixture.controller.open('job-agent');
  let resolveJob;
  fixture.host.inputCapabilitiesImpl = () => new Promise((resolve) => { resolveJob = resolve; });
  const stale = fixture.controller.getInputCapabilities();
  await new Promise((resolve) => setImmediate(resolve));
  await fixture.controller.open('deploy-agent');
  resolveJob(capabilityResponse('job-agent', 'career-profile'));
  await assert.rejects(stale, /Agent 已切换/u);

  fixture.host.inputCapabilitiesImpl = async ({ agentId }) => (
    capabilityResponse(agentId, 'deployment-verification')
  );
  const current = await fixture.controller.getInputCapabilities();
  assert.equal(current.agentId, 'deploy-agent');
  assert.equal(current.skills[0].id, 'deployment-verification');
  assert.deepEqual(fixture.host.inputCapabilityCalls, [
    { agentId: 'job-agent', sessionId: 'private-job-session' },
    { agentId: 'deploy-agent', sessionId: 'private-deploy-session' },
  ]);
  assert.equal(JSON.stringify(current).includes('private-deploy-session'), false);
});

function capabilityResponse(agentId, skillId) {
  return {
    schemaVersion: 1,
    revision: agentId === 'job-agent' ? 11 : 12,
    agentId,
    commands: [{ id: 'context', trigger: '/context' }],
    skills: [{
      id: skillId,
      trigger: `$${skillId}`,
      displayName: '安全技能',
      description: '当前 Agent 的安全技能。',
      promptText: '请执行当前 Agent 的安全技能。',
    }],
  };
}

function makeFixture() {
  const identity = Object.assign(new EventEmitter(), {
    state: {
      phase: 'ready',
      account: { id: 7 },
      access: { canEnterClient: true },
      agents: [
        { agentId: 'job-agent', displayName: 'Job Agent' },
        { agentId: 'deploy-agent', displayName: 'Deploy Agent' },
      ],
    },
    getState() { return this.state; },
    subscribe(listener) {
      this.on('state', listener);
      listener(this.state);
      return () => this.off('state', listener);
    },
  });
  const host = Object.assign(new EventEmitter(), {
    inputCapabilityCalls: [],
    inputCapabilitiesImpl: async ({ agentId }) => capabilityResponse(agentId, 'safe-skill'),
    async listAgents() {
      return {
        agents: [
          {
            agentId: 'job-agent',
            displayName: 'Job Agent',
            mainSessionId: 'private-job-session',
            workspaceDir: '/private/account-7/job-agent',
          },
          {
            agentId: 'deploy-agent',
            displayName: 'Deploy Agent',
            mainSessionId: 'private-deploy-session',
            workspaceDir: '/private/account-7/deploy-agent',
          },
        ],
      };
    },
    async loadSession() {},
    async syncQueueSession() {},
    async listAgentBackgroundActivities() { return { activities: [] }; },
    async getAgentSessionPlan() { return { entries: [] }; },
    async listWorkspaceArtifacts() {
      return { schemaVersion: 1, revision: 0, artifacts: [] };
    },
    async getWorkspaceProjectState() {
      return { schemaVersion: 1, revision: 0, project: null };
    },
    async getAgentInputCapabilities(request) {
      this.inputCapabilityCalls.push(request);
      return this.inputCapabilitiesImpl(request);
    },
  });
  const controller = new AgentConversationController({
    identity,
    host,
    activateAgent: async () => identity.state,
  });
  return { controller, host };
}
