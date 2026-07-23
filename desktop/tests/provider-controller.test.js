'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ProviderController,
  normalizeModelAssignment,
  normalizeProviderProfile,
  publicProviderPayload,
} = require('../src/provider-controller');

const profile = {
  presetId: 'openai',
  displayName: 'Personal OpenAI',
  protocol: 'openai_responses',
  baseUrl: 'https://api.openai.com/v1/',
  authKind: 'bearer_api_key',
  enabledModels: ['gpt-5', 'gpt-5'],
};

test('snapshot is ready-gated and strips every secret-bearing field', async () => {
  const host = {
    async listProviderProfiles() {
      return {
        profiles: [{
          profileId: 'pp_1234',
          displayName: 'OpenAI',
          credentialConfigured: true,
          credentialLastFour: '1234',
          credentialRef: 'keychain://private',
          apiKey: 'sk-private',
        }],
      };
    },
    async getProviderCatalog() {
      return { catalog: { schemaVersion: 1, providers: [] } };
    },
    async listModelAssignments() {
      return { assignments: [{ assignmentId: 'ma_1234', role: 'main' }] };
    },
  };
  const identity = { getState: () => ({ phase: 'ready' }) };
  const controller = new ProviderController({ identity, host });

  const snapshot = await controller.getSnapshot();
  assert.equal(snapshot.profiles[0].credentialConfigured, true);
  assert.equal(snapshot.profiles[0].credentialLastFour, '1234');
  assert.equal(Object.hasOwn(snapshot.profiles[0], 'credentialRef'), false);
  assert.equal(Object.hasOwn(snapshot.profiles[0], 'apiKey'), false);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.profiles[0]), true);

  identity.getState = () => ({ phase: 'blocked' });
  await assert.rejects(() => controller.getSnapshot(), /订阅验证/);
});

test('profile writes pass the secret once and never return it to Renderer', async () => {
  const calls = [];
  const host = {
    async createProviderProfile(input, apiKey) {
      calls.push({ input, apiKey });
      return {
        profile: {
          profileId: 'pp_1234',
          ...input,
          credentialConfigured: true,
          credentialLastFour: '5678',
          credentialRef: 'private-ref',
        },
        apiKey,
      };
    },
  };
  const controller = new ProviderController({
    identity: { getState: () => ({ phase: 'ready' }) },
    host,
  });

  const result = await controller.createProfile(profile, 'sk-write-only-5678');
  assert.equal(calls[0].apiKey, 'sk-write-only-5678');
  assert.equal(calls[0].input.baseUrl, 'https://api.openai.com/v1');
  assert.deepEqual(calls[0].input.enabledModels, ['gpt-5']);
  assert.equal(result.profile.credentialLastFour, '5678');
  assert.equal(Object.hasOwn(result.profile, 'credentialRef'), false);
  assert.equal(Object.hasOwn(result, 'apiKey'), false);
});

test('profile validation rejects unknown fields and credential-bearing URLs', () => {
  assert.throws(
    () => normalizeProviderProfile({ ...profile, apiKey: 'must-not-live-in-profile' }),
    /不支持的字段/,
  );
  assert.throws(
    () => normalizeProviderProfile({
      ...profile,
      baseUrl: 'https://user:password@example.com/v1',
    }),
    /Base URL/,
  );
  assert.throws(
    () => normalizeProviderProfile({ ...profile, protocol: 'invented_protocol' }),
    /协议无效/,
  );
});

test('assignment validation mirrors Host scope and identifier rules', () => {
  assert.deepEqual(normalizeModelAssignment({
    scopeKind: 'agent',
    scopeId: 'job-agent',
    role: 'subagent',
    providerProfileId: 'pp_1234',
    modelId: 'openai/gpt-5:latest',
  }), {
    scopeKind: 'agent',
    scopeId: 'job-agent',
    role: 'subagent',
    providerProfileId: 'pp_1234',
    modelId: 'openai/gpt-5:latest',
  });
  assert.throws(
    () => normalizeModelAssignment({
      scopeKind: 'global',
      scopeId: 'job-agent',
      role: 'main',
      providerProfileId: 'pp_1234',
      modelId: 'gpt-5',
    }),
    /不能包含 scopeId/,
  );
  assert.throws(
    () => normalizeModelAssignment({
      scopeKind: 'session',
      scopeId: null,
      role: 'main',
      providerProfileId: 'pp_1234',
      modelId: 'gpt-5',
    }),
    /必须包含 scopeId/,
  );
});

test('public payload recursively removes authorization material', () => {
  const publicValue = publicProviderPayload({
    nested: {
      authorization: 'Bearer secret',
      extraHeaders: { 'x-api-key': 'secret' },
      safe: 'visible',
    },
  });
  assert.deepEqual(publicValue, { nested: { safe: 'visible' } });
});
