'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AgentManagementController,
  normalizeOverlayContent,
} = require('../src/agent-management-controller');

function fixture() {
  const calls = [];
  const host = {
    async listProviderProfiles() {
      return {
        profiles: [
          {
            profileId: 'pp_glm',
            displayName: 'GLM Coding Plan',
            enabledModels: ['glm-5.2'],
            credentialRef: 'private://must-not-project',
          },
        ],
      };
    },
    async listModelAssignments() {
      return {
        assignments: [
          {
            assignmentId: 'ma_global',
            scopeKind: 'global',
            scopeId: null,
            role: 'main',
            providerProfileId: 'pp_glm',
            modelId: 'glm-5.2',
          },
        ],
      };
    },
    async getAgentCustomization(agentId) {
      calls.push(['get', agentId]);
      return {
        agentId,
        packageName: 'Job Agent',
        packageVersion: '1.0.0',
        packageDescription: 'Career copilot',
        agentMd: { kind: 'agent_md', content: '', revision: 0, customized: false },
        userMd: { kind: 'user_md', content: '', revision: 0, customized: false },
      };
    },
    async getAgentPackageCatalog() {
      return {
        catalog: {
          packages: [{
            requestedPermissions: ['network_access', 'process_execution', 'unknown_future_value'],
            agent: { agentId: 'job-agent' },
          }],
        },
      };
    },
    async upsertModelAssignment(assignment) {
      calls.push(['model', assignment]);
      return { assignment: { assignmentId: 'ma_agent_written', ...assignment } };
    },
    async deleteModelAssignment(assignmentId) {
      calls.push(['delete-model', assignmentId]);
      return { deleted: true };
    },
    async listAgents() {
      return {
        agents: [{
          agentId: 'job-agent',
          mainSessionId: 'private-session-job-agent',
        }],
      };
    },
    async getSessionBindingHistory(request) {
      calls.push(['history', request]);
      return { bindings: [{ bindingRevision: 1 }] };
    },
    async resolveSessionBinding(request) {
      calls.push(['resolve', request]);
      return { binding: { bindingRevision: 1 } };
    },
    async switchSessionBinding(request) {
      calls.push(['switch', request]);
      return { binding: { bindingRevision: 2 } };
    },
    async upsertAgentCustomization(request) {
      calls.push(['overlay', request]);
      return {
        kind: request.kind,
        content: request.content,
        revision: request.expectedRevision + 1,
        customized: true,
        authorization: 'Bearer secret',
      };
    },
    async clearAgentCustomization(request) {
      calls.push(['clear', request]);
      return {
        kind: request.kind,
        content: '',
        revision: request.expectedRevision + 1,
        customized: false,
      };
    },
  };
  const controller = new AgentManagementController({
    identity: {
      getState: () => ({
        phase: 'ready',
        agents: [{ agentId: 'job-agent' }],
      }),
    },
    host,
  });
  return { controller, calls };
}

test('snapshot exposes profile-scoped models and maps legacy global main without secrets', async () => {
  const { controller } = fixture();
  const snapshot = await controller.getSnapshot('job-agent');

  assert.equal(snapshot.modelBinding.assignmentId, 'ma_global');
  assert.equal(snapshot.inheritedFromLegacyGlobal, true);
  assert.equal(snapshot.bindingIssue, null);
  assert.deepEqual(snapshot.profiles[0].enabledModels, ['glm-5.2']);
  assert.deepEqual(
    snapshot.customization.requestedPermissions,
    ['network_access', 'process_execution'],
  );
  assert.equal(Object.hasOwn(snapshot.profiles[0], 'credentialRef'), false);
  assert.equal(Object.isFrozen(snapshot), true);
});

test('overview projects one effective model summary per Agent for list and deletion impact UI', async () => {
  const { controller } = fixture();
  const overview = await controller.getOverview();

  assert.deepEqual(overview.agents, [{
    agentId: 'job-agent',
    providerProfileId: 'pp_glm',
    providerDisplayName: 'GLM Coding Plan',
    modelId: 'glm-5.2',
    bindingIssue: null,
    inheritedFromLegacyGlobal: true,
  }]);
  assert.equal(Object.isFrozen(overview), true);
});

test('Agent model save is always an agent/main assignment', async () => {
  const { controller, calls } = fixture();
  await controller.saveModel('job-agent', 'pp_glm', 'glm-5.2');

  assert.deepEqual(calls.find(([kind]) => kind === 'model')[1], {
    scopeKind: 'agent',
    scopeId: 'job-agent',
    role: 'main',
    providerProfileId: 'pp_glm',
    modelId: 'glm-5.2',
  });
  assert.deepEqual(calls.find(([kind]) => kind === 'switch')[1], {
    sessionId: 'private-session-job-agent',
    role: 'main',
    agentId: 'job-agent',
    kind: 'explicit_switch',
  });
});

test('first model save initializes an empty resident Main Session binding', async () => {
  const { controller, calls } = fixture();
  controller.host.getSessionBindingHistory = async (request) => {
    calls.push(['history', request]);
    return { bindings: [] };
  };

  await controller.saveModel('job-agent', 'pp_glm', 'glm-5.2');

  assert.deepEqual(calls.find(([kind]) => kind === 'resolve')[1], {
    sessionId: 'private-session-job-agent',
    role: 'main',
    agentId: 'job-agent',
  });
  assert.equal(calls.some(([kind]) => kind === 'switch'), false);
});

test('a committed binding survives a lost Host response without assignment rollback', async () => {
  const { controller, calls } = fixture();
  let historyReads = 0;
  controller.host.getSessionBindingHistory = async (request) => {
    calls.push(['history', request]);
    historyReads += 1;
    return historyReads === 1
      ? { bindings: [] }
      : {
        bindings: [{
          bindingRevision: 1,
          route: {
            providerProfileId: 'pp_glm',
            modelId: 'glm-5.2',
          },
        }],
      };
  };
  controller.host.resolveSessionBinding = async (request) => {
    calls.push(['resolve', request]);
    throw new Error('Host response lost after commit');
  };

  const snapshot = await controller.saveModel('job-agent', 'pp_glm', 'glm-5.2');

  assert.equal(snapshot.bindingIssue, null);
  assert.equal(calls.some(([kind]) => kind === 'delete-model'), false);
});

test('a failed binding with a divergent durable route rolls back the assignment', async () => {
  const { controller, calls } = fixture();
  controller.host.switchSessionBinding = async () => {
    throw new Error('turn still running');
  };
  controller.host.getSessionBindingHistory = async (request) => {
    calls.push(['history', request]);
    return {
      bindings: [{
        bindingRevision: 1,
        route: {
          providerProfileId: 'pp_prior',
          modelId: 'prior-model',
        },
      }],
    };
  };

  await assert.rejects(
    () => controller.saveModel('job-agent', 'pp_glm', 'glm-5.2'),
    /turn still running/,
  );
  assert.equal(calls.some(([kind]) => kind === 'delete-model'), true);
});

test('an unknown binding commit outcome never performs a destructive assignment rollback', async () => {
  const { controller, calls } = fixture();
  let historyReads = 0;
  controller.host.getSessionBindingHistory = async (request) => {
    calls.push(['history', request]);
    historyReads += 1;
    if (historyReads === 1) {
      return { bindings: [{ bindingRevision: 1 }] };
    }
    throw new Error('Host unavailable during reconciliation');
  };
  controller.host.switchSessionBinding = async () => {
    throw new Error('Host response lost after possible commit');
  };

  await assert.rejects(
    () => controller.saveModel('job-agent', 'pp_glm', 'glm-5.2'),
    /模型切换结果未知，请重新加载确认/,
  );
  assert.equal(calls.some(([kind]) => kind === 'delete-model'), false);
});

test('failed resident switch rolls back a newly written Agent assignment', async () => {
  const { controller, calls } = fixture();
  controller.host.switchSessionBinding = async () => {
    throw new Error('turn still running');
  };

  await assert.rejects(
    () => controller.saveModel('job-agent', 'pp_glm', 'glm-5.2'),
    /turn still running/,
  );
  assert.deepEqual(
    calls.find(([kind]) => kind === 'delete-model'),
    ['delete-model', 'ma_agent_written'],
  );
});

test('failed resident switch restores the exact prior Agent assignment', async () => {
  const { controller, calls } = fixture();
  controller.host.listModelAssignments = async () => ({
    assignments: [{
      assignmentId: 'ma_prior',
      scopeKind: 'agent',
      scopeId: 'job-agent',
      role: 'main',
      providerProfileId: 'pp_prior',
      modelId: 'prior-model',
    }],
  });
  controller.host.switchSessionBinding = async () => {
    throw new Error('turn still running');
  };

  await assert.rejects(
    () => controller.saveModel('job-agent', 'pp_glm', 'glm-5.2'),
    /turn still running/,
  );
  const modelWrites = calls.filter(([kind]) => kind === 'model');
  assert.deepEqual(modelWrites[1][1], {
    scopeKind: 'agent',
    scopeId: 'job-agent',
    role: 'main',
    providerProfileId: 'pp_prior',
    modelId: 'prior-model',
  });
  assert.equal(calls.some(([kind]) => kind === 'delete-model'), false);
});

test('snapshot marks deleted providers and unavailable models as blocking issues', async () => {
  const { controller } = fixture();
  controller.host.listProviderProfiles = async () => ({ profiles: [] });
  const missingProvider = await controller.getSnapshot('job-agent');
  assert.equal(missingProvider.bindingIssue.code, 'provider_unavailable');

  controller.host.listProviderProfiles = async () => ({
    profiles: [{
      profileId: 'pp_glm',
      displayName: 'GLM Coding Plan',
      enabledModels: ['glm-4.7'],
    }],
  });
  const missingModel = await controller.getSnapshot('job-agent');
  assert.equal(missingModel.bindingIssue.code, 'model_unavailable');
});

test('customization writes carry optimistic revision and strip secret-bearing response fields', async () => {
  const { controller, calls } = fixture();
  const result = await controller.saveCustomization({
    agentId: 'job-agent',
    kind: 'agent_md',
    content: '先规划，再执行。',
    expectedRevision: 3,
  });

  assert.equal(calls.find(([kind]) => kind === 'overlay')[1].expectedRevision, 3);
  assert.equal(result.revision, 4);
  assert.equal(Object.hasOwn(result, 'authorization'), false);
});

test('Renderer validation rejects invalid identity, kind, revision and oversized Unicode', async () => {
  const { controller } = fixture();
  await assert.rejects(() => controller.getSnapshot('../job-agent'), /Agent ID/);
  await assert.rejects(() => controller.saveCustomization({
    agentId: 'job-agent',
    kind: 'global_user_md',
    content: '',
    expectedRevision: 0,
  }), /类型无效/);
  await assert.rejects(() => controller.clearCustomization({
    agentId: 'job-agent',
    kind: 'user_md',
    expectedRevision: -1,
  }), /版本无效/);
  assert.doesNotThrow(() => normalizeOverlayContent('🙂'.repeat(8_000)));
  assert.throws(() => normalizeOverlayContent('好'.repeat(8_001)), /8000/);
});
