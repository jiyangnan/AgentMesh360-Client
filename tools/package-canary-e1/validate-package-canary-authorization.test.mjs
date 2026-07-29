import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  validatePackageCanaryAuthorization,
  validatePackageCanaryAuthorizationFile,
} from './validate-package-canary-authorization.mjs';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const VALIDATOR = path.join(
  TEST_DIRECTORY,
  'validate-package-canary-authorization.mjs',
);
const AUTHORIZATION = path.resolve(
  TEST_DIRECTORY,
  '../../docs/operations/tabletops/2026-07-29-p5-owner-account-e1-authorization.json',
);
const PRIOR_AUTHORIZATION = path.resolve(
  TEST_DIRECTORY,
  '../../docs/operations/tabletops/2026-07-29-p5-package-canary-e1-authorization.json',
);
const PRIOR_ABORT = path.resolve(
  TEST_DIRECTORY,
  '../../docs/operations/tabletops/2026-07-29-p5-e1-abort.json',
);
const PREFLIGHT = path.resolve(
  TEST_DIRECTORY,
  '../../docs/templates/package-canary-preflight-v1.json',
);
const P4_AUTHORIZATION = path.resolve(
  TEST_DIRECTORY,
  '../../docs/operations/tabletops/2026-07-28-p4-distribution-e1-authorization.json',
);
const P4_ACCEPTANCE = path.resolve(
  TEST_DIRECTORY,
  '../../docs/operations/tabletops/2026-07-28-p4-distribution-e1-acceptance.json',
);
const AUTHORIZATION_VALUE = JSON.parse(readFileSync(AUTHORIZATION, 'utf8'));

function validAuthorization() {
  return structuredClone(AUTHORIZATION_VALUE);
}

function typedSha256(filePath) {
  return `sha256:${createHash('sha256')
    .update(readFileSync(filePath))
    .digest('hex')}`;
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'agentmesh360-p5-authorization-test-'),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('accepts the exact retention-safe P5 E1 authorization', async () => {
  assert.deepEqual(validatePackageCanaryAuthorization(validAuthorization()), []);
  assert.deepEqual(
    await validatePackageCanaryAuthorizationFile(AUTHORIZATION),
    [],
  );
});

test('validator has no network, Keychain, Provider, or subprocess capability', () => {
  const source = readFileSync(VALIDATOR, 'utf8');
  assert.doesNotMatch(
    source,
    /node:(?:child_process|http|https|net|tls)|\bfetch\s*\(|\bcurl\b|\bdoctl\b|\bsecurity\b/u,
  );
});

test('binds the preflight, P4 authorization, and P4 acceptance bytes', () => {
  const authorization = validAuthorization();
  assert.equal(
    authorization.executionFreeze.preflightSha256,
    typedSha256(PREFLIGHT),
  );
  assert.equal(
    authorization.executionFreeze.p4AcceptanceSha256,
    typedSha256(P4_ACCEPTANCE),
  );
  assert.equal(
    authorization.releaseChain.p4AuthorizationSha256,
    typedSha256(P4_AUTHORIZATION),
  );
  assert.equal(
    authorization.authorizationHistory.supersedesAuthorizationSha256,
    typedSha256(PRIOR_AUTHORIZATION),
  );
  assert.equal(
    authorization.authorizationHistory.supersedesAbortSha256,
    typedSha256(PRIOR_ABORT),
  );
});

test('pins one account, one Mac, 72 hours, and no production authority', () => {
  const authorization = validAuthorization();
  assert.equal(authorization.cohort.accountCount, 1);
  assert.equal(authorization.cohort.deviceCount, 1);
  assert.equal(
    authorization.subscriptionPlan.source,
    'existing_owner_online_account',
  );
  assert.equal(
    authorization.authorizationHistory.supersedesAbortId,
    'package_canary_e1_abort_20260729_0001',
  );
  assert.equal(
    authorization.authorizationHistory.priorAuthorizationReusable,
    false,
  );
  assert.equal(authorization.authorizationWindow.maximumHours, 72);
  assert.equal(
    Date.parse(authorization.authorizationWindow.stopsAt)
      - Date.parse(authorization.authorizationWindow.startsAt),
    72 * 60 * 60 * 1000,
  );
  assert.equal(
    authorization.approvalReceipt.productionAuthorityGranted,
    false,
  );
  assert.equal(authorization.cohort.externalCohortAllowed, false);
});

test('pins the saved Gemini secret, temporary Keychain copy, and approved limits', () => {
  const authorization = validAuthorization();
  assert.deepEqual(authorization.providerPlan, {
    presetId: 'google-gemini',
    modelId: 'gemini-3.5-flash-lite',
    credentialSource: 'existing_process_environment_gemini_test_key',
    sourceEnvironmentVariable: 'GEMINI_API_KEY',
    environmentSecretReadAllowed: true,
    keychainReadAllowed: true,
    temporaryKeychainWriteAllowed: true,
    temporaryKeychainCredentialRequired: true,
    secretExportAllowed: false,
    maximumInferenceRequests: 12,
    maximumAgentMeshCredits: 0,
    maximumProviderCostUsd: 1,
    silentFallbackAllowed: false,
    temporaryCanaryBindingsRequired: true,
    removeTemporaryBindingsAtEnd: true,
    deleteTemporaryKeychainCredentialAtEnd: true,
    preserveSavedSourceCredential: true,
  });
  assert.equal(authorization.requestLimits.maximumAgentMeshCredits, 0);
  assert.equal(authorization.requestLimits.maximumInfrastructureCostUsd, 3);
  assert.equal(authorization.requestLimits.maximumCombinedCostUsd, 4);
});

test('pins fresh E1 keys, Package variants, and isolated rollback', () => {
  const authorization = validAuthorization();
  assert.equal(authorization.releaseChain.freshEphemeralRootKeyCount, 2);
  assert.equal(authorization.releaseChain.freshEphemeralPublisherKeyCount, 2);
  assert.equal(authorization.releaseChain.p4PrivateMaterialReusable, false);
  assert.equal(authorization.releaseChain.productionKeyAllowed, false);
  assert.equal(authorization.releaseChain.productionConstantsMutable, false);
  assert.equal(authorization.releaseChain.jobBaselineVersion, '0.4.7');
  assert.equal(
    authorization.releaseChain.jobSamePermissionVersion,
    '0.4.8-e1.1',
  );
  assert.equal(
    authorization.releaseChain.jobPermissionExpansionVersion,
    '0.4.9-e1.1',
  );
  assert.equal(
    authorization.releaseChain.addedCanaryPermission,
    'process_execution',
  );
  assert.equal(authorization.rollbackPlan.isolatedCanaryStateHomeRequired, true);
  assert.equal(authorization.rollbackPlan.restoreExactPreCanaryPackageState, true);
});

test('rejects authority, execution, production, or cohort escalation', () => {
  for (const mutate of [
    (value) => {
      value.authority = 'production_release_owner';
    },
    (value) => {
      value.executionStatus = 'canary_passed';
    },
    (value) => {
      value.approvalReceipt.productionAuthorityGranted = true;
    },
    (value) => {
      value.cohort.accountCount = 2;
    },
    (value) => {
      value.cohort.deviceCount = 2;
    },
    (value) => {
      value.cohort.externalCohortAllowed = true;
    },
    (value) => {
      value.subscriptionPlan.source = 'existing_dedicated_internal_account';
    },
    (value) => {
      value.authorizationHistory.priorAuthorizationReusable = true;
    },
  ]) {
    const authorization = validAuthorization();
    mutate(authorization);
    assert.ok(validatePackageCanaryAuthorization(authorization).length > 0);
  }
});

test('rejects Provider, credits, cost, or fallback escalation', () => {
  for (const mutate of [
    (value) => {
      value.providerPlan.modelId = 'different-model';
    },
    (value) => {
      value.providerPlan.maximumInferenceRequests = 13;
    },
    (value) => {
      value.providerPlan.maximumAgentMeshCredits = 1;
    },
    (value) => {
      value.providerPlan.maximumProviderCostUsd = 2;
    },
    (value) => {
      value.providerPlan.silentFallbackAllowed = true;
    },
    (value) => {
      value.providerPlan.secretExportAllowed = true;
    },
    (value) => {
      value.providerPlan.temporaryKeychainWriteAllowed = false;
    },
    (value) => {
      value.providerPlan.deleteTemporaryKeychainCredentialAtEnd = false;
    },
  ]) {
    const authorization = validAuthorization();
    mutate(authorization);
    assert.ok(validatePackageCanaryAuthorization(authorization).length > 0);
  }
});

test('rejects infrastructure, trust, or production mutation escalation', () => {
  for (const mutate of [
    (value) => {
      value.infrastructurePlan.existingProductionDropletReusable = true;
    },
    (value) => {
      value.infrastructurePlan.stagingDropletCount = 2;
    },
    (value) => {
      value.infrastructurePlan.hardCapUsd = 4;
    },
    (value) => {
      value.infrastructurePlan.productionRecordMutable = true;
    },
    (value) => {
      value.releaseChain.p4PrivateMaterialReusable = true;
    },
    (value) => {
      value.releaseChain.productionKeyAllowed = true;
    },
    (value) => {
      value.releaseChain.productionConstantsMutable = true;
    },
  ]) {
    const authorization = validAuthorization();
    mutate(authorization);
    assert.ok(validatePackageCanaryAuthorization(authorization).length > 0);
  }
});

test('rejects rollback, cleanup, or evidence weakening', () => {
  for (const mutate of [
    (value) => {
      value.rollbackPlan.capturePreCanaryPackageState = false;
    },
    (value) => {
      value.rollbackPlan.automaticMutationRetryAllowed = true;
    },
    (value) => {
      value.cleanupPlan.withdrawRegistryFirst = false;
    },
    (value) => {
      value.cleanupPlan.preserveSavedSourceCredential = false;
    },
    (value) => {
      value.cleanupPlan.deleteTemporaryKeychainCredential = false;
    },
    (value) => {
      value.cleanupPlan.destroyIsolatedCanaryState = false;
    },
    (value) => {
      value.evidencePolicy.recordPersonalIdentity = true;
    },
    (value) => {
      value.evidencePolicy.recordUserOrProviderContent = true;
    },
  ]) {
    const authorization = validAuthorization();
    mutate(authorization);
    assert.ok(validatePackageCanaryAuthorization(authorization).length > 0);
  }
});

test('rejects stale input digests, unknown fields, and unsafe values', () => {
  for (const mutate of [
    (value) => {
      value.executionFreeze.preflightSha256 = `sha256:${'a'.repeat(64)}`;
    },
    (value) => {
      value.releaseChain.p4AuthorizationSha256 = `sha256:${'b'.repeat(64)}`;
    },
    (value) => {
      value.rawAccountId = 'synthetic';
    },
    (value) => {
      value.cohort.accountAlias = 'https://unsafe.example';
    },
  ]) {
    const authorization = validAuthorization();
    mutate(authorization);
    assert.ok(validatePackageCanaryAuthorization(authorization).length > 0);
  }
});

test('rejects duplicate JSON keys, symlinks, invalid UTF-8, and oversized input', async () => {
  await withTempDirectory(async (directory) => {
    const duplicatePath = path.join(directory, 'duplicate.json');
    await writeFile(
      duplicatePath,
      JSON.stringify(validAuthorization()).replace(
        '"schemaVersion":2',
        '"schemaVersion":2,"schemaVersion":2',
      ),
    );
    await assert.rejects(
      validatePackageCanaryAuthorizationFile(duplicatePath),
      /duplicate JSON object keys/u,
    );

    const validPath = path.join(directory, 'valid.json');
    const linkPath = path.join(directory, 'link.json');
    await writeFile(validPath, JSON.stringify(validAuthorization()));
    await symlink(validPath, linkPath);
    await assert.rejects(
      validatePackageCanaryAuthorizationFile(linkPath),
      /regular file/u,
    );

    const invalidUtf8 = path.join(directory, 'invalid.json');
    await writeFile(invalidUtf8, Buffer.from([0xff]));
    await assert.rejects(
      validatePackageCanaryAuthorizationFile(invalidUtf8),
      /valid UTF-8/u,
    );

    const oversized = path.join(directory, 'oversized.json');
    await writeFile(oversized, Buffer.alloc(256 * 1024 + 1, 0x20));
    await assert.rejects(
      validatePackageCanaryAuthorizationFile(oversized),
      /size is invalid/u,
    );
  });
});

test('CLI validates without printing sensitive authorization values', () => {
  const result = spawnSync(process.execPath, [VALIDATOR, AUTHORIZATION], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /validation passed/u);
  assert.doesNotMatch(result.stdout, /gemini|account|Keychain|sha256/iu);
  assert.equal(result.stderr, '');
});
