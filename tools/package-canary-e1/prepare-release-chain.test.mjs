import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AUTHORIZATION_ID,
  SCENARIOS,
  buildPlan,
  validateEvidence,
} from './prepare-release-chain.mjs';

function fixtures() {
  return {
    authorization: {
      authorizationId: AUTHORIZATION_ID,
      approvalStatus: 'approved',
      executionStatus: 'authorized_not_started',
      approvalReceipt: { productionAuthorityGranted: false },
      authorizationWindow: {
        startsAt: '2026-07-28T17:48:33Z',
        stopsAt: '2026-07-31T17:48:33Z',
      },
      releaseChain: {
        mode: 'rebuild_frozen_p4_release_set_with_canary_variants',
        freshEphemeralRootKeyCount: 2,
        freshEphemeralPublisherKeyCount: 2,
        productionConstantsMutable: false,
      },
      scenarioPlan: {
        scenarioCount: 21,
        allScenariosRequired: true,
      },
      infrastructurePlan: {
        stagingDropletCount: 1,
        spacesBucketCount: 2,
        cloudflareDnsRecordCount: 1,
        hardCapUsd: 3,
      },
    },
    oauth: {
      authorizationId: AUTHORIZATION_ID,
      gate: {
        desktopOAuthProductionPassed: true,
        liveSubscriptionPassed: true,
        restartRecoveryPassed: true,
      },
      execution: {
        providerInferenceRequestsUsed: 0,
        packageMutationsPerformed: 0,
      },
    },
    byok: {
      authorizationId: AUTHORIZATION_ID,
      gate: {
        realByokHappyPathPassed: true,
        providerFailureBoundaryPassed: true,
        restartRecoveryPassed: true,
        packageCanaryCompleted: false,
      },
      budget: {
        providerInferenceOperationsUsed: 4,
        maximumProviderInferenceRequests: 12,
        agentMeshCreditsUsed: 0,
        maximumAgentMeshCredits: 0,
        maximumProviderCostUsd: 1,
        providerCostCapBreachObserved: false,
        infrastructureCostUsd: 0,
      },
      state: {
        packageMutationCount: 0,
        cloudResourceCount: 0,
        repositoryRootTargetPresent: false,
      },
      cleanup: {
        preserveSavedSourceCredential: true,
        cleanupRequiredBeforeP5Completion: true,
      },
    },
    executorCommit: 'a'.repeat(40),
    repository: {
      head: 'a'.repeat(40),
      originMain: 'a'.repeat(40),
      clean: true,
    },
    now: new Date('2026-07-29T06:00:00Z'),
  };
}

test('accepts exact pushed P5 release-chain evidence', () => {
  assert.doesNotThrow(() => validateEvidence(fixtures()));
});

test('rejects repository, window, authority, budget, and cleanup drift', () => {
  const mutations = [
    (value) => { value.repository.clean = false; },
    (value) => { value.now = new Date('2026-07-28T17:48:32Z'); },
    (value) => { value.now = new Date('2026-08-01T00:00:00Z'); },
    (value) => { value.authorization.approvalReceipt.productionAuthorityGranted = true; },
    (value) => { value.authorization.releaseChain.freshEphemeralRootKeyCount = 1; },
    (value) => { value.authorization.infrastructurePlan.stagingDropletCount = 2; },
    (value) => { value.byok.budget.providerInferenceOperationsUsed = 13; },
    (value) => { delete value.byok.budget.providerInferenceOperationsUsed; },
    (value) => { value.byok.budget.maximumProviderCostUsd = 2; },
    (value) => { value.byok.budget.providerCostCapBreachObserved = true; },
    (value) => { value.byok.budget.agentMeshCreditsUsed = 1; },
    (value) => { value.byok.budget.infrastructureCostUsd = 0.01; },
    (value) => { value.byok.state.packageMutationCount = 1; },
    (value) => { value.byok.state.repositoryRootTargetPresent = true; },
    (value) => { value.byok.cleanup.preserveSavedSourceCredential = false; },
    (value) => { value.byok.cleanup.cleanupRequiredBeforeP5Completion = false; },
    (value) => { value.oauth.gate.liveSubscriptionPassed = false; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(fixtures());
    value.now = fixtures().now;
    mutate(value);
    assert.throws(() => validateEvidence(value));
  }
});

test('emits two signing generations, exact variants, and 21 pending scenarios', () => {
  const plan = buildPlan({
    authorizationSha256: `sha256:${'1'.repeat(64)}`,
    oauthEvidenceSha256: `sha256:${'2'.repeat(64)}`,
    byokEvidenceSha256: `sha256:${'3'.repeat(64)}`,
    executorCommit: 'a'.repeat(40),
    now: new Date('2026-07-29T06:00:00Z'),
  });
  assert.equal(plan.releaseChain.generations.length, 2);
  assert.deepEqual(
    plan.releaseChain.generations[1].releases,
    ['job-agent@0.4.8-e1.1', 'job-agent@0.4.9-e1.1'],
  );
  assert.deepEqual(
    plan.scenarios.map((scenario) => scenario.scenario),
    SCENARIOS,
  );
  assert.ok(plan.scenarios.every((scenario) => scenario.executionStatus === 'pending'));
  assert.equal(plan.gates.cloudCreationAllowed, true);
  assert.equal(plan.gates.p6Allowed, false);
});

test('source has no network, Provider, Keychain, or cloud mutation capability', async () => {
  const source = await readFile(
    new URL('./prepare-release-chain.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /from ['"]node:https|from ['"]node:http|fetch\s*\(|spawnSync\(['"]doctl|api\.cloudflare\.com|spawnSync\(['"]security/u,
  );
  assert.doesNotMatch(source, /GEMINI_API_KEY|apiKey|credentialValue/u);
});
