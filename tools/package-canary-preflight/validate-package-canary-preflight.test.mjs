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
  validatePackageCanaryPreflight,
  validatePackageCanaryPreflightFile,
} from './validate-package-canary-preflight.mjs';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const VALIDATOR = path.join(
  TEST_DIRECTORY,
  'validate-package-canary-preflight.mjs',
);
const TEMPLATE = path.resolve(
  TEST_DIRECTORY,
  '../../docs/templates/package-canary-preflight-v1.json',
);
const TEMPLATE_VALUE = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
const P4_ACCEPTANCE = path.resolve(
  TEST_DIRECTORY,
  '../../docs/operations/tabletops/2026-07-28-p4-distribution-e1-acceptance.json',
);
const PACKAGE_SOURCE_ROOT = path.resolve(
  TEST_DIRECTORY,
  '../../crates/codegen/xai-grok-shell/src/agentmesh360',
);

function validPreflight() {
  return structuredClone(TEMPLATE_VALUE);
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'agentmesh360-p5-preflight-test-'),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('accepts the blocked no-authority P5 preflight template', async () => {
  assert.deepEqual(validatePackageCanaryPreflight(validPreflight()), []);
  assert.deepEqual(await validatePackageCanaryPreflightFile(TEMPLATE), []);
});

test('validator has no network, Keychain, Provider, or subprocess capability', () => {
  const source = readFileSync(VALIDATOR, 'utf8');
  assert.doesNotMatch(
    source,
    /node:(?:child_process|http|https|net|tls)|\bfetch\s*\(|\bcurl\b|\bdoctl\b|\bsecurity\b/u,
  );
});

test('binds the actual P4 acceptance bytes and cleanup boundary', () => {
  const preflight = validPreflight();
  const receiptBytes = readFileSync(P4_ACCEPTANCE);
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  const receiptSha256 = `sha256:${createHash('sha256')
    .update(receiptBytes)
    .digest('hex')}`;

  assert.equal(
    preflight.evidenceInput.p4AuthorizationId,
    receipt.authorizationId,
  );
  assert.equal(preflight.evidenceInput.p4AcceptanceSha256, receiptSha256);
  assert.equal(
    preflight.evidenceInput.p4ExecutionStatus,
    receipt.executionStatus,
  );
  assert.equal(
    preflight.evidenceInput.p4ProductionR3Closed,
    receipt.productionR3Closed,
  );
  assert.equal(preflight.evidenceInput.p4ResourcesRetained, false);
  assert.equal(preflight.evidenceInput.p4PrivateMaterialRetained, false);
  assert.equal(receipt.cleanup.localTempEntryCount, 0);
  assert.equal(receipt.cleanup.bucketCount, 0);
  assert.equal(receipt.cleanup.limitedAccessKeyCount, 0);
});

test('keeps production gates open and P5 unauthorized', () => {
  const preflight = validPreflight();
  assert.deepEqual(preflight.prerequisiteGates, {
    r1AuthorityEvidence: 'e0_rehearsal_only',
    r2ProvenanceEvidence: 'e0_rehearsal_only',
    r3DistributionEvidence: 'e1_rehearsal_only',
    r6OperationalReadiness: 'local_baseline_only',
    requiredBeforeCanary: true,
    applicableReleaseChainReady: false,
    productionGatesClosed: false,
  });
  assert.equal(preflight.evidenceInput.p5Authorized, false);
  assert.equal(preflight.executionStatus, 'blocked');
});

test('pins the Package delivery and production-disable source contract', () => {
  const delivery = readFileSync(
    path.join(PACKAGE_SOURCE_ROOT, 'package_delivery.rs'),
    'utf8',
  );
  const installer = readFileSync(
    path.join(PACKAGE_SOURCE_ROOT, 'package_installer.rs'),
    'utf8',
  );
  const fetcher = readFileSync(
    path.join(PACKAGE_SOURCE_ROOT, 'package_registry_fetcher.rs'),
    'utf8',
  );
  const trust = readFileSync(
    path.join(PACKAGE_SOURCE_ROOT, 'package_trust.rs'),
    'utf8',
  );
  const trustCache = readFileSync(
    path.join(PACKAGE_SOURCE_ROOT, 'package_trust_cache.rs'),
    'utf8',
  );
  const registry = readFileSync(
    path.join(PACKAGE_SOURCE_ROOT, 'registry.rs'),
    'utf8',
  );

  assert.match(
    delivery,
    /const APPROVAL_TTL: Duration = Duration::from_secs\(10 \* 60\)/u,
  );
  assert.match(delivery, /const MAX_PENDING_APPROVALS: usize = 32/u);
  assert.match(delivery, /requires active subscription/u);
  assert.match(delivery, /access changed before commit/u);
  assert.match(delivery, /approval no longer matches install state/u);
  assert.match(installer, /downgrade requires explicit rollback/u);
  assert.match(installer, /if !plan\.added_permissions\.is_empty\(\) && !permissions_approved/u);
  assert.match(fetcher, /PRODUCTION_TRUST_BUNDLE_URL: Option<&str> = None/u);
  assert.match(fetcher, /PRODUCTION_REGISTRY_URL: Option<&str> = None/u);
  assert.match(
    trust,
    /EMBEDDED_PUBLISHER_TRUST_BUNDLE: Option<&str> = None/u,
  );
  assert.match(trustCache, /reject_equivocation/u);
  assert.match(
    registry,
    /stable_main_session_id\(owner_account_id, agent_id\)/u,
  );
});

test('pins the complete P5 scenario matrix in order', () => {
  const scenarios = validPreflight().scenarioMatrix;
  assert.equal(scenarios.length, 21);
  assert.deepEqual(
    scenarios.map(({ scenario }) => scenario),
    [
      'active_subscription',
      'inactive_subscription',
      'account_switch',
      'byok_selected_route',
      'provider_auth_failure',
      'provider_transient_failure',
      'provider_capability_mismatch',
      'budget_limit_reached',
      'new_agent_install',
      'same_permission_update',
      'permission_expansion_rejected',
      'permission_expansion_approved',
      'artifact_or_metadata_tamper',
      'registry_rollback_or_equivocation',
      'trust_expiry_or_publisher_revocation',
      'interrupted_install',
      'package_rollback',
      'host_skill_projection',
      'root_rotation',
      'publisher_rotation_or_revocation',
      'registry_withdrawal',
    ],
  );
  assert.ok(scenarios.every((entry) => entry.executionStatus === 'blocked'));
});

test('rejects authority, approval, execution, or P5 escalation', () => {
  for (const mutate of [
    (value) => {
      value.authority = 'release_owner';
    },
    (value) => {
      value.approvalStatus = 'approved';
    },
    (value) => {
      value.executionStatus = 'canary_running';
    },
    (value) => {
      value.evidenceInput.p5Authorized = true;
    },
  ]) {
    const preflight = validPreflight();
    mutate(preflight);
    assert.ok(validatePackageCanaryPreflight(preflight).length > 0);
  }
});

test('rejects fabricated production gates or retained P4 material', () => {
  for (const mutate of [
    (value) => {
      value.prerequisiteGates.r1AuthorityEvidence = 'passed';
    },
    (value) => {
      value.prerequisiteGates.r2ProvenanceEvidence = 'passed';
    },
    (value) => {
      value.prerequisiteGates.r3DistributionEvidence = 'passed';
    },
    (value) => {
      value.prerequisiteGates.applicableReleaseChainReady = true;
    },
    (value) => {
      value.prerequisiteGates.productionGatesClosed = true;
    },
    (value) => {
      value.evidenceInput.p4ProductionR3Closed = true;
    },
    (value) => {
      value.evidenceInput.p4ResourcesRetained = true;
    },
    (value) => {
      value.evidenceInput.p4PrivateMaterialRetained = true;
    },
  ]) {
    const preflight = validPreflight();
    mutate(preflight);
    assert.ok(validatePackageCanaryPreflight(preflight).length > 0);
  }
});

test('rejects network, Keychain, Provider, or production mutation', () => {
  for (const field of [
    'externalNetworkAllowed',
    'subscriptionRequestsAllowed',
    'providerRequestsAllowed',
    'packageOriginRequestsAllowed',
    'keychainReadsAllowed',
    'externalResourcesMayBeCreated',
    'productionConstantsMutable',
  ]) {
    const preflight = validPreflight();
    preflight.networkBoundary[field] = true;
    assert.ok(validatePackageCanaryPreflight(preflight).length > 0);
  }
});

test('rejects approval-card account, credential, budget, or cohort claims', () => {
  for (const mutate of [
    (value) => {
      value.approvalCard.dedicatedAccount = 'account_ready';
    },
    (value) => {
      value.approvalCard.subscription = 'active';
    },
    (value) => {
      value.approvalCard.byokCredential = 'credential_ref';
    },
    (value) => {
      value.approvalCard.providerAndModel = 'provider_model';
    },
    (value) => {
      value.approvalCard.maximumProviderRequests = 1;
    },
    (value) => {
      value.approvalCard.maximumCredits = 1;
    },
    (value) => {
      value.approvalCard.maximumCurrencyCost = 1;
    },
    (value) => {
      value.approvalCard.cohort = 'one_internal_user';
    },
    (value) => {
      value.approvalCard.approvalReceipt = 'self_approved';
    },
  ]) {
    const preflight = validPreflight();
    mutate(preflight);
    assert.ok(validatePackageCanaryPreflight(preflight).length > 0);
  }
});

test('rejects consumer safety contract drift', () => {
  for (const mutate of [
    (value) => {
      value.consumerContract.activeSubscriptionRequired = false;
    },
    (value) => {
      value.consumerContract.accountRevalidatedBeforeMutation = false;
    },
    (value) => {
      value.consumerContract.approvalOneTime = false;
    },
    (value) => {
      value.consumerContract.approvalTtlSeconds = 3600;
    },
    (value) => {
      value.consumerContract.permissionExpansionRequiresApproval = false;
    },
    (value) => {
      value.consumerContract.stableMainSessionRequired = false;
    },
    (value) => {
      value.consumerContract.silentProviderFallbackAllowed = true;
    },
  ]) {
    const preflight = validPreflight();
    mutate(preflight);
    assert.ok(validatePackageCanaryPreflight(preflight).length > 0);
  }
});

test('rejects missing, reordered, duplicated, or falsely executed scenarios', () => {
  for (const mutate of [
    (value) => {
      value.scenarioMatrix.pop();
    },
    (value) => {
      value.scenarioMatrix.reverse();
    },
    (value) => {
      value.scenarioMatrix[1] = structuredClone(value.scenarioMatrix[0]);
    },
    (value) => {
      value.scenarioMatrix[0].executionStatus = 'passed';
    },
    (value) => {
      value.scenarioMatrix[0].expectedOutcome = 'allow';
    },
  ]) {
    const preflight = validPreflight();
    mutate(preflight);
    assert.ok(validatePackageCanaryPreflight(preflight).length > 0);
  }
});

test('rejects evidence retention that exposes sensitive state', () => {
  for (const field of [
    'recordAccountIds',
    'recordEmail',
    'recordCredentials',
    'recordAuthorizationHeaders',
    'recordByok',
    'recordPrompts',
    'recordResponses',
    'recordToolContent',
    'recordEndpointUrls',
    'recordAbsolutePaths',
    'recordRawTrustDocuments',
    'recordRawRegistryDocuments',
  ]) {
    const preflight = validPreflight();
    preflight.evidencePolicy[field] = true;
    assert.ok(validatePackageCanaryPreflight(preflight).length > 0);
  }
});

test('rejects reordered stop conditions and unknown fields', () => {
  const reordered = validPreflight();
  reordered.stopConditions.reverse();
  assert.ok(validatePackageCanaryPreflight(reordered).length > 0);

  const unknown = validPreflight();
  unknown.realAccount = 'synthetic-sentinel';
  assert.ok(
    validatePackageCanaryPreflight(unknown).some((error) =>
      error.includes('unknown field')),
  );
});

test('rejects duplicate JSON object keys', async () => {
  await withTempDirectory(async (directory) => {
    const duplicate = JSON.stringify(validPreflight()).replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    );
    const filePath = path.join(directory, 'duplicate.json');
    await writeFile(filePath, duplicate);
    await assert.rejects(
      validatePackageCanaryPreflightFile(filePath),
      /duplicate JSON object keys/,
    );
  });
});

test('rejects malformed JSON with a bounded generic error', async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, 'malformed.json');
    await writeFile(filePath, '{"schemaVersion":"\\uZZZZ"}');
    await assert.rejects(
      validatePackageCanaryPreflightFile(filePath),
      /^Error: package canary preflight is not valid JSON$/u,
    );
  });
});

test('rejects symlinks, invalid UTF-8, and oversized input', async () => {
  await withTempDirectory(async (directory) => {
    const validPath = path.join(directory, 'valid.json');
    const linkPath = path.join(directory, 'link.json');
    await writeFile(validPath, JSON.stringify(validPreflight()));
    await symlink(validPath, linkPath);
    await assert.rejects(
      validatePackageCanaryPreflightFile(linkPath),
      /regular file/,
    );

    const invalidUtf8 = path.join(directory, 'invalid.json');
    await writeFile(invalidUtf8, Buffer.from([0xff]));
    await assert.rejects(
      validatePackageCanaryPreflightFile(invalidUtf8),
      /valid UTF-8/,
    );

    const oversized = path.join(directory, 'oversized.json');
    await writeFile(oversized, Buffer.alloc(128 * 1024 + 1, 0x20));
    await assert.rejects(
      validatePackageCanaryPreflightFile(oversized),
      /size is invalid/,
    );
  });
});

test('CLI passes the template and keeps failures bounded and path-free', async () => {
  const valid = spawnSync(process.execPath, [VALIDATOR, TEMPLATE], {
    encoding: 'utf8',
  });
  assert.equal(valid.status, 0);
  assert.match(valid.stdout, /validation passed/u);

  await withTempDirectory(async (directory) => {
    const invalidPath = path.join(directory, 'invalid.json');
    await writeFile(invalidPath, '{}');
    const result = spawnSync(process.execPath, [VALIDATOR, invalidPath], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, new RegExp(directory, 'u'));
    assert.ok(result.stderr.length < 16 * 1024);
  });
});
