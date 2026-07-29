import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CLIENT_BOUNDARY,
  HARD_STOP,
  HOST_SCENARIOS,
  SCENARIOS,
  assertScenarioExecutorAncestry,
  buildDriverInput,
  buildScenarioResults,
  parseArguments,
  validateHostReceipt,
  validateProviderBudget,
  validatePublication,
} from './run-scenario-matrix.mjs';

const COMMIT = 'a'.repeat(40);
const AUTHORIZATION_ID = 'package_canary_e1_20260729_0002';

function hostReceipt() {
  return {
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    executorCommit: COMMIT,
    executionStatus: 'live_host_scenarios_passed',
    scenarioCount: HOST_SCENARIOS.size,
    results: [...HOST_SCENARIOS].map((scenario) => ({
      scenario,
      evidenceCode: `${scenario}_passed`,
      status: 'passed',
    })),
    packageMutationsPerformed: 5,
    providerInferenceOperationsAdded: 0,
    agentMeshCreditsUsed: 0,
    productionAuthorityGranted: false,
    accountIdentifierRecorded: false,
    credentialMaterialRecorded: false,
  };
}

function publication() {
  const plannedObjects = Array.from({ length: 20 }, (_, index) => ({
    bucketClass: index % 2 ? 'release' : 'metadata',
    objectKey: `objects/object-${index}.json`,
    sha256: `sha256:${index.toString(16).padStart(64, '0')}`,
  }));
  plannedObjects.at(-1).bucketClass = 'metadata';
  plannedObjects.at(-1).objectKey = 'metadata/registry.v2.json';
  return {
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    executionStatus: 'published',
    executorCommit: COMMIT,
    releaseExecutorCommit: COMMIT,
    registryPublishedLast: true,
    cleanupRequired: true,
    rootKeyIds: [
      'agentmesh360-root-e1-p5-20260729-a',
      'agentmesh360-root-e1-p5-20260729-b',
    ],
    rootPublicEvidence: {
      a: {
        publicKeyBase64: Buffer.alloc(32, 1).toString('base64'),
        publicKeySha256: `sha256:${'1'.repeat(64)}`,
      },
      b: {
        publicKeyBase64: Buffer.alloc(32, 2).toString('base64'),
        publicKeySha256: `sha256:${'2'.repeat(64)}`,
      },
    },
    plannedObjects,
    objectReceipts: structuredClone(plannedObjects),
  };
}

function origin() {
  return {
    authorizationId: AUTHORIZATION_ID,
    origin: {
      deployed: true,
      executorCommit: COMMIT,
      faultToken: 'x'.repeat(43),
    },
    dns: {
      hostname: 'packages-p5-e1-1234abcd.agentmesh360.com',
    },
  };
}

test('pins the approved 21 scenarios and 14 live Host scenarios', () => {
  assert.equal(SCENARIOS.length, 21);
  assert.equal(new Set(SCENARIOS).size, 21);
  assert.equal(HOST_SCENARIOS.size, 14);
  assert.deepEqual(SCENARIOS.slice(0, 8), [
    'active_subscription',
    'inactive_subscription',
    'account_switch',
    'byok_selected_route',
    'provider_auth_failure',
    'provider_transient_failure',
    'provider_capability_mismatch',
    'budget_limit_reached',
  ]);
});

test('rejects a Provider budget at or beyond expanded authority', () => {
  const budget = {
    budget: {
      providerInferenceOperationsUsed: 4,
      maximumProviderInferenceRequests: 12,
      agentMeshCreditsUsed: 0,
      maximumAgentMeshCredits: 0,
      maximumProviderCostUsd: 1,
      providerCostCapBreachObserved: false,
    },
  };
  assert.equal(validateProviderBudget(budget), 4);
  const exceeded = structuredClone(budget);
  exceeded.budget.providerInferenceOperationsUsed = 13;
  assert.throws(() => validateProviderBudget(exceeded));
  const credits = structuredClone(budget);
  credits.budget.agentMeshCreditsUsed = 1;
  assert.throws(() => validateProviderBudget(credits));
});

test('accepts only complete Registry-last publication and two public roots', () => {
  const roots = validatePublication(publication(), origin(), COMMIT);
  assert.equal(roots.length, 2);
  const notLast = publication();
  notLast.plannedObjects.at(-1).objectKey = 'objects/not-registry.json';
  notLast.objectReceipts.at(-1).objectKey = 'objects/not-registry.json';
  assert.throws(() => validatePublication(notLast, origin(), COMMIT));
  const badRoot = publication();
  badRoot.rootPublicEvidence.b.publicKeyBase64 = 'bad';
  assert.throws(() => validatePublication(badRoot, origin(), COMMIT));
});

test('requires ordered Origin to Release to Publisher to Scenario provenance', () => {
  const commits = ['a', 'b', 'c', 'd'].map(
    (value) => value.repeat(40),
  );
  const pairs = [];
  assertScenarioExecutorAncestry({
    originExecutorCommit: commits[0],
    releaseExecutorCommit: commits[1],
    publicationExecutorCommit: commits[2],
    scenarioExecutorCommit: commits[3],
  }, (ancestor, descendant) => {
    pairs.push([ancestor, descendant]);
  });
  assert.deepEqual(pairs, [
    [commits[0], commits[1]],
    [commits[1], commits[2]],
    [commits[2], commits[3]],
  ]);
  const value = publication();
  value.releaseExecutorCommit = commits[1];
  value.executorCommit = commits[2];
  const deployed = origin();
  deployed.origin.executorCommit = commits[0];
  assert.doesNotThrow(() =>
    validatePublication(value, deployed, commits[3]));
  value.releaseExecutorCommit = 'invalid';
  assert.throws(() =>
    validatePublication(value, deployed, commits[3]));
});

test('validates exact live Host coverage and restores final scenario order', () => {
  const host = validateHostReceipt(hostReceipt(), COMMIT);
  const results = buildScenarioResults(host);
  assert.equal(results.length, 21);
  assert.deepEqual(results.map((result) => result.scenario), SCENARIOS);
  const incomplete = hostReceipt();
  incomplete.results.pop();
  assert.throws(() => validateHostReceipt(incomplete, COMMIT));
});

test('builds only the fixed P5 driver authority', () => {
  const roots = validatePublication(publication(), origin(), COMMIT);
  const input = buildDriverInput({
    executorCommit: COMMIT,
    origin: origin(),
    roots,
  });
  assert.equal(input.authorizationId, AUTHORIZATION_ID);
  assert.equal(
    input.origin,
    'https://packages-p5-e1-1234abcd.agentmesh360.com',
  );
  assert.equal(input.stopsAt, HARD_STOP);
  assert.equal(input.productionAuthorityGranted, false);
  assert.equal(CLIENT_BOUNDARY, '/private/tmp/agentmesh360-p5-e1-client');
});

test('parses only the frozen executor CLI', () => {
  assert.deepEqual(
    parseArguments(['--executor-commit', COMMIT]),
    { executorCommit: COMMIT },
  );
  assert.throws(() => parseArguments([COMMIT]));
  assert.throws(() => parseArguments([
    '--executor-commit',
    COMMIT,
    '--output',
    '/tmp/other',
  ]));
});

test('keeps production Package constants empty and canary scope fixed', async () => {
  const [canary, trust, fetcher, driver] = await Promise.all([
    readFile(new URL(
      '../../crates/codegen/xai-grok-shell/src/agentmesh360/package_canary.rs',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../../crates/codegen/xai-grok-shell/src/agentmesh360/package_trust.rs',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../../crates/codegen/xai-grok-shell/src/agentmesh360/package_registry_fetcher.rs',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../../desktop/src/package-canary-e1-driver.js',
      import.meta.url,
    ), 'utf8'),
  ]);
  assert.match(
    trust,
    /const EMBEDDED_PUBLISHER_TRUST_BUNDLE: Option<&str> = None;/u,
  );
  assert.match(
    fetcher,
    /const PRODUCTION_TRUST_BUNDLE_URL: Option<&str> = None;/u,
  );
  assert.match(
    fetcher,
    /const PRODUCTION_REGISTRY_URL: Option<&str> = None;/u,
  );
  assert.match(canary, /AGENTMESH360_PACKAGE_CANARY_E1/u);
  assert.match(canary, /2026-07-31T17:48:33Z/u);
  assert.match(driver, /AGENTMESH360_PACKAGE_CANARY_E1/u);
  assert.doesNotMatch(
    `${canary}\n${driver}`,
    /GEMINI_API_KEY|api\.cloudflare\.com|digitalocean\.com\/v2/u,
  );
});
