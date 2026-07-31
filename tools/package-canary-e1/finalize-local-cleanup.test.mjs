import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  EXPECTED_TEMP_NAMES,
  parseArguments,
  strictTempInventory,
  validateCleanupEvidence,
  validateCloudEvidence,
} from './finalize-local-cleanup.mjs';

const AUTHORIZATION_ID = 'package_canary_e1_20260729_0002';
const COMMITS = ['a', 'b', 'c'].map((value) => value.repeat(40));

function cloudEvidence() {
  return {
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    executionStatus: 'cloud_resources_withdrawn',
    dnsRecordAbsent: true,
    exactDropletCount: 0,
    operatorPrivateKeyAbsent: true,
    limitedAccessKeyCount: 0,
    bucketDeletionScheduledCount: 2,
    bucketObjectCount: 0,
    billableBucketCount: 0,
    productionMutationCount: 0,
    providerInferenceOperationsAdded: 0,
    agentMeshCreditsUsed: 0,
    approvedInfrastructureBudgetHardCapUsd: 3,
    estimatedInfrastructureCostUsdUpperBound: 0.1,
    invoiceFinal: false,
  };
}

function cleanupEvidence() {
  return {
    matrix: {
      authorizationId: AUTHORIZATION_ID,
      executorCommit: COMMITS[0],
      hostExecutorCommit: 'd'.repeat(40),
      executionStatus: 'scenario_matrix_passed',
      scenarioCount: 21,
      results: Array.from({ length: 21 }, (_, index) => ({
        scenario: `scenario_${index}`,
        status: 'passed',
      })),
      budget: {
        providerInferenceOperationsUsed: 4,
        providerInferenceOperationsAdded: 0,
        agentMeshCreditsUsed: 0,
      },
      mutationSummary: {
        packageMutationsPerformed: 5,
      },
    },
    cleanup: {
      authorizationId: AUTHORIZATION_ID,
      executorCommit: COMMITS[1],
      executionStatus: 'release_chain_withdrawn',
      registryWithdrawnFirst: true,
      plannedObjectCount: 61,
      deletedObjectCount: 61,
      verifiedAbsentObjectCount: 61,
      rootPrivateMaterialDestroyedCount: 2,
      publisherPrivateMaterialDestroyedCount: 2,
      releaseBoundaryRemovedCount: 2,
    },
    publication: {
      authorizationId: AUTHORIZATION_ID,
      executionStatus: 'published',
      plannedObjects: Array.from({ length: 61 }, () => ({})),
    },
    release: {
      authorizationId: AUTHORIZATION_ID,
      executionStatus: 'release_chain_built',
      generations: [{}, {}],
    },
  };
}

test('pins the exact isolated P5 temporary inventory', () => {
  const exact = [...EXPECTED_TEMP_NAMES].sort();
  assert.equal(exact.length, 11);
  assert.deepEqual(strictTempInventory(exact), exact);
  assert.throws(() => strictTempInventory(exact.slice(1)));
  assert.throws(() => strictTempInventory([
    ...exact,
    'agentmesh360-p5-e1-unapproved',
  ]));
  assert.throws(() => strictTempInventory([
    ...exact.slice(1),
    'agentmesh360-release-provenance-e1-unapproved',
  ]));
});

test('accepts only the frozen finalizer CLI', () => {
  assert.deepEqual(
    parseArguments(['--executor-commit', COMMITS[2]]),
    { executorCommit: COMMITS[2] },
  );
  assert.throws(() => parseArguments([COMMITS[2]]));
  assert.throws(() => parseArguments([
    '--executor-commit',
    COMMITS[2],
    '--path',
    '/tmp/other',
  ]));
});

test('requires complete cloud withdrawal within the approved cap', () => {
  assert.doesNotThrow(() => validateCloudEvidence(cloudEvidence()));
  for (const mutation of [
    { dnsRecordAbsent: false },
    { exactDropletCount: 1 },
    { limitedAccessKeyCount: 1 },
    { bucketObjectCount: 1 },
    { billableBucketCount: 1 },
    { estimatedInfrastructureCostUsdUpperBound: 3.01 },
    { estimatedInfrastructureCostUsdUpperBound: null },
    { invoiceFinal: true },
  ]) {
    assert.throws(() => validateCloudEvidence({
      ...cloudEvidence(),
      ...mutation,
    }));
  }
});

test('requires the full matrix, cleanup counts, and ordered executors', () => {
  const value = cleanupEvidence();
  const pairs = [];
  assert.equal(
    validateCleanupEvidence(
      value.matrix,
      value.cleanup,
      value.publication,
      value.release,
      COMMITS[2],
      (ancestor, descendant) => pairs.push([ancestor, descendant]),
    ),
    'd'.repeat(40),
  );
  assert.deepEqual(pairs, [
    [COMMITS[0], COMMITS[1]],
    [COMMITS[1], COMMITS[2]],
  ]);
  const incomplete = cleanupEvidence();
  incomplete.matrix.results.pop();
  assert.throws(() => validateCleanupEvidence(
    incomplete.matrix,
    incomplete.cleanup,
    incomplete.publication,
    incomplete.release,
    COMMITS[2],
    () => {},
  ));
});

test('source confines destructive work and deletes Provider via product API', async () => {
  const [finalizer, driver] = await Promise.all([
    readFile(new URL('./finalize-local-cleanup.mjs', import.meta.url), 'utf8'),
    readFile(new URL(
      '../../desktop/src/package-canary-e1-cleanup-driver.js',
      import.meta.url,
    ), 'utf8'),
  ]);
  assert.match(finalizer, /const APPROVED_TEMP_ROOT = '\/private\/tmp';/u);
  assert.match(finalizer, /constants\.O_NOFOLLOW/u);
  assert.match(finalizer, /EMBEDDED_PUBLISHER_TRUST_BUNDLE/u);
  assert.match(finalizer, /PRODUCTION_TRUST_BUNDLE_URL/u);
  assert.match(finalizer, /PRODUCTION_REGISTRY_URL/u);
  assert.match(finalizer, /com\.agentmesh360\.client\.provider/u);
  assert.match(
    finalizer,
    /GROK_HOME:\s*path\.join\(CLIENT_BOUNDARY,\s*'grok-home'\)/u,
  );
  assert.match(finalizer, /await rm\(CLIENT_BUILD/u);
  assert.match(finalizer, /await securelyRemovePrivateTree\(CLIENT_STATE\)/u);
  assert.match(driver, /providers\.deleteProfile\(profile\.profileId\)/u);
  assert.doesNotMatch(driver, /runProbe|createProfile|GEMINI_API_KEY/u);
  assert.doesNotMatch(
    finalizer,
    /api\.cloudflare\.com|api\.digitalocean\.com|doctl/u,
  );
});
