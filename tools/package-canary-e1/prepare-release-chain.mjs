#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  open,
  readFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  validatePackageCanaryAuthorizationFile,
} from './validate-package-canary-authorization.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const AUTHORIZATION_PATH = path.join(
  REPOSITORY_ROOT,
  'docs/operations/tabletops/2026-07-29-p5-owner-account-e1-authorization.json',
);
const OAUTH_EVIDENCE_PATH = path.join(
  REPOSITORY_ROOT,
  'docs/operations/tabletops/2026-07-29-p5-owner-account-oauth-active.json',
);
const BYOK_EVIDENCE_PATH = path.join(
  REPOSITORY_ROOT,
  'docs/operations/tabletops/2026-07-29-p5-owner-account-byok-active.json',
);
const OUTPUT_PATH =
  '/private/tmp/agentmesh360-p5-e1-release-chain-preflight.json';
const AUTHORIZATION_ID = 'package_canary_e1_20260729_0002';
const SCENARIOS = Object.freeze([
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
]);

function typedSha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error('release-chain repository inspection failed');
  }
  return result.stdout.trim();
}

function localRepositoryState() {
  return Object.freeze({
    head: runGit(['rev-parse', 'HEAD']),
    originMain: runGit(['rev-parse', 'origin/main']),
    clean: runGit([
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]) === '',
  });
}

async function readBoundedJson(filePath, label) {
  const info = await lstat(filePath);
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || info.size <= 0
    || info.size > 256 * 1024
  ) {
    throw new Error(`${label} is not a bounded regular JSON file`);
  }
  const bytes = await readFile(filePath);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
  return Object.freeze({ bytes, value });
}

async function assertProductionConstantsEmpty() {
  const [trustSource, fetcherSource] = await Promise.all([
    readFile(path.join(
      REPOSITORY_ROOT,
      'crates/codegen/xai-grok-shell/src/agentmesh360/package_trust.rs',
    ), 'utf8'),
    readFile(path.join(
      REPOSITORY_ROOT,
      'crates/codegen/xai-grok-shell/src/agentmesh360/package_registry_fetcher.rs',
    ), 'utf8'),
  ]);
  if (
    !trustSource.includes(
      'const EMBEDDED_PUBLISHER_TRUST_BUNDLE: Option<&str> = None;',
    )
    || !fetcherSource.includes(
      'const PRODUCTION_TRUST_BUNDLE_URL: Option<&str> = None;',
    )
    || !fetcherSource.includes(
      'const PRODUCTION_REGISTRY_URL: Option<&str> = None;',
    )
  ) {
    throw new Error('production Package constants are not empty');
  }
}

function validateEvidence({
  authorization,
  oauth,
  byok,
  executorCommit,
  repository,
  now,
}) {
  if (
    !/^[0-9a-f]{40}$/u.test(executorCommit)
    || repository.head !== executorCommit
    || repository.originMain !== executorCommit
    || repository.clean !== true
  ) {
    throw new Error('release-chain executor is not the clean pushed commit');
  }
  const startsAt = Date.parse(authorization.authorizationWindow?.startsAt);
  const stopsAt = Date.parse(authorization.authorizationWindow?.stopsAt);
  if (
    !Number.isFinite(startsAt)
    || !Number.isFinite(stopsAt)
    || now.getTime() < startsAt
    || now.getTime() >= stopsAt
  ) {
    throw new Error('P5 authorization window has closed');
  }
  if (
    authorization.authorizationId !== AUTHORIZATION_ID
    || authorization.approvalStatus !== 'approved'
    || authorization.executionStatus !== 'authorized_not_started'
    || authorization.approvalReceipt?.productionAuthorityGranted !== false
    || authorization.releaseChain?.mode
      !== 'rebuild_frozen_p4_release_set_with_canary_variants'
    || authorization.releaseChain?.freshEphemeralRootKeyCount !== 2
    || authorization.releaseChain?.freshEphemeralPublisherKeyCount !== 2
    || authorization.releaseChain?.productionConstantsMutable !== false
    || authorization.scenarioPlan?.scenarioCount !== SCENARIOS.length
    || authorization.scenarioPlan?.allScenariosRequired !== true
    || authorization.infrastructurePlan?.stagingDropletCount !== 1
    || authorization.infrastructurePlan?.spacesBucketCount !== 2
    || authorization.infrastructurePlan?.cloudflareDnsRecordCount !== 1
    || authorization.infrastructurePlan?.hardCapUsd !== 3
  ) {
    throw new Error('P5 authorization does not permit this release chain');
  }
  if (
    oauth.authorizationId !== AUTHORIZATION_ID
    || oauth.gate?.desktopOAuthProductionPassed !== true
    || oauth.gate?.liveSubscriptionPassed !== true
    || oauth.gate?.restartRecoveryPassed !== true
    || oauth.execution?.providerInferenceRequestsUsed !== 0
    || oauth.execution?.packageMutationsPerformed !== 0
  ) {
    throw new Error('OAuth/subscription evidence is incomplete');
  }
  if (
    byok.authorizationId !== AUTHORIZATION_ID
    || byok.gate?.realByokHappyPathPassed !== true
    || byok.gate?.providerFailureBoundaryPassed !== true
    || byok.gate?.restartRecoveryPassed !== true
    || byok.gate?.packageCanaryCompleted !== false
    || !Number.isSafeInteger(byok.budget?.providerInferenceOperationsUsed)
    || byok.budget.providerInferenceOperationsUsed < 0
    || byok.budget.providerInferenceOperationsUsed > 12
    || byok.budget?.maximumProviderInferenceRequests !== 12
    || byok.budget?.agentMeshCreditsUsed !== 0
    || byok.budget?.maximumAgentMeshCredits !== 0
    || byok.budget?.maximumProviderCostUsd !== 1
    || byok.budget?.providerCostCapBreachObserved !== false
    || byok.budget?.infrastructureCostUsd !== 0
    || byok.state?.packageMutationCount !== 0
    || byok.state?.cloudResourceCount !== 0
    || byok.state?.repositoryRootTargetPresent !== false
    || byok.cleanup?.preserveSavedSourceCredential !== true
    || byok.cleanup?.cleanupRequiredBeforeP5Completion !== true
  ) {
    throw new Error('BYOK evidence is incomplete or exceeds authorization');
  }
}

function buildPlan({
  authorizationSha256,
  oauthEvidenceSha256,
  byokEvidenceSha256,
  executorCommit,
  now,
}) {
  return Object.freeze({
    schemaVersion: 1,
    preflightId: 'package_canary_e1_release_chain_preflight_20260729_0002',
    authorizationId: AUTHORIZATION_ID,
    environment: 'e1',
    workPackage: 'p5_package_canary',
    executionStatus: 'release_chain_preflight_passed',
    executorCommit,
    recordedAt: now.toISOString(),
    inputDigests: {
      authorizationSha256,
      oauthEvidenceSha256,
      byokEvidenceSha256,
    },
    authority: {
      productionAuthorityGranted: false,
      productionConstantsMutable: false,
      productionDropletReusable: false,
      p4PrivateMaterialReusable: false,
    },
    releaseChain: {
      candidateCommit: 'e1ef8db19dc58a2c9cec19ac34f7e1966d741b7c',
      sourceSet: 'frozen_p4_four_agent_set',
      dualBuildRequired: true,
      buildRootLocation: 'isolated_private_tmp_boundary',
      repositoryRootTargetAllowed: false,
      generations: [
        {
          generation: 'a',
          rootKeyAlias: 'p5-e1-root-a',
          publisherKeyAlias: 'p5-e1-publisher-a',
          releases: [
            'deploy-agent@0.1.1',
            'future-agent@1.0.0',
            'job-agent@0.4.7',
            'lecturecast-agent@0.4.0',
          ],
        },
        {
          generation: 'b',
          rootKeyAlias: 'p5-e1-root-b',
          publisherKeyAlias: 'p5-e1-publisher-b',
          releases: [
            'job-agent@0.4.8-e1.1',
            'job-agent@0.4.9-e1.1',
          ],
        },
      ],
      variantPlan: {
        baselineVersion: '0.4.7',
        samePermissionVersion: '0.4.8-e1.1',
        permissionExpansionVersion: '0.4.9-e1.1',
        addedPermission: 'process_execution',
        sourceMutationAllowed: false,
        variantDefinitionsOnlyInEphemeralBoundary: true,
      },
    },
    infrastructure: {
      provider: 'digitalocean',
      region: 'sgp1',
      stagingDropletCount: 1,
      stagingDropletSize: 's-1vcpu-1gb',
      spacesBucketCount: 2,
      cloudflareDnsRecordCount: 1,
      productionRecordMutable: false,
      expectedCostUsd: 1.15,
      hardCapUsd: 3,
      destroyAtEnd: true,
    },
    scenarios: SCENARIOS.map((scenario) => ({
      scenario,
      executionStatus: 'pending',
    })),
    cleanup: {
      registryFirst: true,
      destroyDroplet: true,
      destroyBuckets: true,
      removeDnsRecord: true,
      revokeSpacesKeys: true,
      destroyEphemeralSigningKeys: true,
      removeTemporaryProviderBindings: true,
      deleteTemporaryKeychainCredential: true,
      destroyIsolatedCanaryState: true,
      preserveSavedSourceCredential: true,
    },
    gates: {
      releaseBuildAllowed: true,
      cloudCreationAllowed: true,
      packageMutationAllowedOnlyInIsolatedState: true,
      p6Allowed: false,
    },
    retention: {
      credentialsRetained: false,
      resourceIdsRetained: false,
      endpointUrlsRetained: false,
      accountIdentifiersRetained: false,
      absolutePathsRetained: false,
      promptOrResponseRetained: false,
    },
  });
}

async function writeMode0600Json(filePath, value) {
  let handle;
  try {
    handle = await open(filePath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close();
  }
  await chmod(filePath, 0o600);
}

export async function prepareReleaseChain({
  executorCommit,
  now = new Date(),
  repositoryProbe = localRepositoryState,
  outputPath = OUTPUT_PATH,
} = {}) {
  if (outputPath !== OUTPUT_PATH) {
    throw new Error('release-chain output path is outside the approved boundary');
  }
  await validatePackageCanaryAuthorizationFile(AUTHORIZATION_PATH);
  const [authorization, oauth, byok] = await Promise.all([
    readBoundedJson(AUTHORIZATION_PATH, 'P5 authorization'),
    readBoundedJson(OAUTH_EVIDENCE_PATH, 'OAuth evidence'),
    readBoundedJson(BYOK_EVIDENCE_PATH, 'BYOK evidence'),
  ]);
  validateEvidence({
    authorization: authorization.value,
    oauth: oauth.value,
    byok: byok.value,
    executorCommit,
    repository: repositoryProbe(),
    now,
  });
  try {
    await lstat(path.join(REPOSITORY_ROOT, 'target'));
    throw new Error('repository root target exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await assertProductionConstantsEmpty();
  const plan = buildPlan({
    authorizationSha256: typedSha256(authorization.bytes),
    oauthEvidenceSha256: typedSha256(oauth.bytes),
    byokEvidenceSha256: typedSha256(byok.bytes),
    executorCommit,
    now,
  });
  await writeMode0600Json(outputPath, plan);
  return plan;
}

function usage() {
  process.stderr.write(
    'usage: node prepare-release-chain.mjs <executor-commit>\n',
  );
}

async function main() {
  const [executorCommit, extra] = process.argv.slice(2);
  if (!executorCommit || extra) {
    usage();
    process.exitCode = 2;
    return;
  }
  try {
    await prepareReleaseChain({ executorCommit });
    process.stdout.write(
      'P5 E1 release-chain preflight passed; cloud creation is now bounded\n',
    );
  } catch (error) {
    process.stderr.write(
      `P5 E1 release-chain preflight blocked: ${error.message}\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}

export {
  AUTHORIZATION_ID,
  OUTPUT_PATH,
  SCENARIOS,
  buildPlan,
  validateEvidence,
};
