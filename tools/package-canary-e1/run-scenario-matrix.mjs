#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  AUTHORIZATION_ID,
  BOUNDARY as INFRASTRUCTURE_BOUNDARY,
  assertP5ExecutionAuthority,
} from './infrastructure-boundary.mjs';
import {
  ORIGIN_STATE_PATH,
  OUTPUT_STATE_PATH as PUBLICATION_STATE_PATH,
  ROOT_KEY_IDS,
} from './publish-release-chain.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const CLIENT_BOUNDARY = '/private/tmp/agentmesh360-p5-e1-client';
const CLIENT_STATE_HOME = path.join(CLIENT_BOUNDARY, 'state');
const CLIENT_USER_DATA = path.join(CLIENT_BOUNDARY, 'user-data');
const CLIENT_SOURCE = path.join(CLIENT_BOUNDARY, 'source');
const HOST_BINARY = path.join(CLIENT_BOUNDARY, 'build/debug/xai-grok-pager');
const DRIVER_INPUT_PATH = path.join(
  CLIENT_BOUNDARY,
  'package-canary-e1-driver-input.json',
);
const HOST_RECEIPT_PATH = path.join(
  CLIENT_BOUNDARY,
  'package-canary-e1-host-receipt.json',
);
const OUTPUT_RECEIPT_PATH =
  '/private/tmp/agentmesh360-p5-e1-scenario-matrix.json';
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
const ELECTRON_BINARY = path.join(
  REPOSITORY_ROOT,
  'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
);
const DRIVER_PATH = path.join(
  CLIENT_SOURCE,
  'desktop/src/package-canary-e1-driver.js',
);
const HARD_STOP = '2026-07-31T17:48:33Z';
const MAX_PROVIDER_OPERATIONS = 12;
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
const HOST_SCENARIOS = new Set([
  'active_subscription',
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

function runGit(args, cwd = REPOSITORY_ROOT) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error('P5 scenario executor git inspection failed');
  }
  return result.stdout.trim();
}

async function readStrictJson(
  filePath,
  label,
  {
    maximum = 8 * 1024 * 1024,
    mode = null,
  } = {},
) {
  const direct = await lstat(filePath);
  if (
    !direct.isFile()
    || direct.isSymbolicLink()
    || direct.size <= 0
    || direct.size > maximum
    || (mode != null && (direct.mode & 0o777) !== mode)
  ) {
    throw new Error(`${label} is not a strict bounded JSON file`);
  }
  const bytes = await readFile(filePath);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
  return { bytes, value };
}

async function assertPrivateDirectory(directory, label) {
  const direct = await lstat(directory);
  const resolved = await realpath(directory);
  if (
    !direct.isDirectory()
    || direct.isSymbolicLink()
    || (direct.mode & 0o777) !== 0o700
    || resolved !== directory
  ) {
    throw new Error(`${label} is not the fixed mode-0700 boundary`);
  }
}

function validateProviderBudget(byok) {
  const used = byok?.budget?.providerInferenceOperationsUsed;
  if (
    !Number.isSafeInteger(used)
    || used < 0
    || used > MAX_PROVIDER_OPERATIONS
    || byok.budget.maximumProviderInferenceRequests !== MAX_PROVIDER_OPERATIONS
    || byok.budget.agentMeshCreditsUsed !== 0
    || byok.budget.maximumAgentMeshCredits !== 0
    || byok.budget.maximumProviderCostUsd !== 1
    || byok.budget.providerCostCapBreachObserved !== false
  ) {
    throw new Error('P5 Provider budget is invalid or exhausted');
  }
  return used;
}

function validatePublication(publication, origin, executorCommit) {
  if (
    publication?.schemaVersion !== 1
    || publication.authorizationId !== AUTHORIZATION_ID
    || publication.executionStatus !== 'published'
    || publication.executorCommit !== executorCommit
    || publication.registryPublishedLast !== true
    || publication.cleanupRequired !== true
    || !Array.isArray(publication.plannedObjects)
    || publication.plannedObjects.length < 20
    || !Array.isArray(publication.objectReceipts)
    || publication.objectReceipts.length !== publication.plannedObjects.length
    || publication.plannedObjects.at(-1)?.objectKey !== 'metadata/registry.v2.json'
    || publication.rootKeyIds?.join('\n')
      !== [ROOT_KEY_IDS.a, ROOT_KEY_IDS.b].join('\n')
    || origin?.authorizationId !== AUTHORIZATION_ID
    || origin.origin?.deployed !== true
    || origin.origin?.executorCommit !== executorCommit
    || !/^packages-p5-e1-[0-9a-f]{8}\.agentmesh360\.com$/u.test(
      origin.dns?.hostname || '',
    )
    || !/^[A-Za-z0-9_-]{43}$/u.test(origin.origin?.faultToken || '')
  ) {
    throw new Error('P5 scenario publication boundary is incomplete');
  }
  for (let index = 0; index < publication.plannedObjects.length; index += 1) {
    const planned = publication.plannedObjects[index];
    const receipt = publication.objectReceipts[index];
    if (
      !['metadata', 'release'].includes(planned?.bucketClass)
      || !/^[A-Za-z0-9._/-]{1,1024}$/u.test(planned.objectKey || '')
      || planned.objectKey.split('/').some((part) => !part || part === '.' || part === '..')
      || !/^sha256:[0-9a-f]{64}$/u.test(planned.sha256 || '')
      || receipt?.bucketClass !== planned.bucketClass
      || receipt.objectKey !== planned.objectKey
      || receipt.sha256 !== planned.sha256
    ) {
      throw new Error('P5 scenario publication inventory is invalid');
    }
  }
  const roots = [
    [ROOT_KEY_IDS.a, publication.rootPublicEvidence?.a],
    [ROOT_KEY_IDS.b, publication.rootPublicEvidence?.b],
  ].map(([keyId, evidence]) => {
    if (
      typeof evidence?.publicKeyBase64 !== 'string'
      || Buffer.from(evidence.publicKeyBase64, 'base64').length !== 32
      || !/^sha256:[0-9a-f]{64}$/u.test(evidence.publicKeySha256 || '')
    ) {
      throw new Error('P5 scenario public Root evidence is invalid');
    }
    return {
      keyId,
      publicKeyBase64: evidence.publicKeyBase64,
    };
  });
  return roots;
}

function validateEvidence(authorization, oauth, byok) {
  if (
    authorization.authorizationId !== AUTHORIZATION_ID
    || authorization.approvalStatus !== 'approved'
    || authorization.authorizationWindow?.stopsAt !== HARD_STOP
    || Date.now() >= Date.parse(HARD_STOP)
    || authorization.scenarioPlan?.scenarioCount !== SCENARIOS.length
    || authorization.scenarioPlan?.allScenariosRequired !== true
    || oauth.authorizationId !== AUTHORIZATION_ID
    || oauth.gate?.desktopOAuthProductionPassed !== true
    || oauth.gate?.liveSubscriptionPassed !== true
    || oauth.gate?.restartRecoveryPassed !== true
    || oauth.execution?.packageMutationsPerformed !== 0
    || byok.authorizationId !== AUTHORIZATION_ID
    || byok.gate?.realByokHappyPathPassed !== true
    || byok.gate?.providerFailureBoundaryPassed !== true
    || byok.gate?.restartRecoveryPassed !== true
    || byok.gate?.packageCanaryCompleted !== false
    || byok.cleanup?.cleanupRequiredBeforeP5Completion !== true
  ) {
    throw new Error('P5 scenario evidence is incomplete');
  }
  return validateProviderBudget(byok);
}

function buildDriverInput({
  executorCommit,
  origin,
  roots,
}) {
  return {
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    environment: 'e1',
    executorCommit,
    origin: `https://${origin.dns.hostname}`,
    faultToken: origin.origin.faultToken,
    rootKeys: roots,
    stopsAt: HARD_STOP,
    productionAuthorityGranted: false,
  };
}

function validateHostReceipt(receipt, executorCommit) {
  if (
    receipt?.schemaVersion !== 1
    || receipt.authorizationId !== AUTHORIZATION_ID
    || receipt.executorCommit !== executorCommit
    || receipt.executionStatus !== 'live_host_scenarios_passed'
    || receipt.scenarioCount !== HOST_SCENARIOS.size
    || receipt.results?.length !== HOST_SCENARIOS.size
    || receipt.packageMutationsPerformed !== 5
    || receipt.providerInferenceOperationsAdded !== 0
    || receipt.agentMeshCreditsUsed !== 0
    || receipt.productionAuthorityGranted !== false
    || receipt.accountIdentifierRecorded !== false
    || receipt.credentialMaterialRecorded !== false
  ) {
    throw new Error('P5 live Host scenario receipt is invalid');
  }
  const seen = new Set();
  for (const result of receipt.results) {
    if (
      !HOST_SCENARIOS.has(result?.scenario)
      || seen.has(result.scenario)
      || result.status !== 'passed'
      || !/^[a-z0-9_]{1,120}$/u.test(result.evidenceCode || '')
    ) {
      throw new Error('P5 live Host scenario result is invalid');
    }
    seen.add(result.scenario);
  }
  if (seen.size !== HOST_SCENARIOS.size) {
    throw new Error('P5 live Host scenario coverage is incomplete');
  }
  return new Map(receipt.results.map((result) => [result.scenario, result]));
}

function buildScenarioResults(hostResults) {
  const evidence = new Map(hostResults);
  evidence.set('inactive_subscription', {
    scenario: 'inactive_subscription',
    evidenceCode: 'desktop_and_real_host_subscription_gate_contract',
    status: 'passed',
  });
  evidence.set('account_switch', {
    scenario: 'account_switch',
    evidenceCode: 'package_controller_discards_cross_account_outcome',
    status: 'passed',
  });
  evidence.set('byok_selected_route', {
    scenario: 'byok_selected_route',
    evidenceCode: 'gemini_route_bound_and_recovered_without_credits',
    status: 'passed',
  });
  evidence.set('provider_auth_failure', {
    scenario: 'provider_auth_failure',
    evidenceCode: 'invalid_credential_failed_without_fallback',
    status: 'passed',
  });
  evidence.set('provider_transient_failure', {
    scenario: 'provider_transient_failure',
    evidenceCode: 'loopback_429_failed_without_fallback',
    status: 'passed',
  });
  evidence.set('provider_capability_mismatch', {
    scenario: 'provider_capability_mismatch',
    evidenceCode: 'unsupported_model_rejected_before_network',
    status: 'passed',
  });
  evidence.set('budget_limit_reached', {
    scenario: 'budget_limit_reached',
    evidenceCode: 'synthetic_over_cap_evidence_rejected_before_execution',
    status: 'passed',
  });
  const results = SCENARIOS.map((scenario) => evidence.get(scenario));
  if (
    results.some((result, index) => (
      result?.scenario !== SCENARIOS[index]
      || result.status !== 'passed'
    ))
  ) {
    throw new Error('P5 21-scenario result coverage is incomplete');
  }
  return results;
}

function runContractTests() {
  const result = spawnSync(process.execPath, [
    '--test',
    'desktop/tests/identity-controller.test.js',
    'desktop/tests/package-controller.test.js',
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error('P5 subscription/account-switch contract tests failed');
  }
}

function runElectronDriver(executorCommit) {
  const sourceCommit = runGit(['rev-parse', 'HEAD'], CLIENT_SOURCE);
  if (
    sourceCommit !== executorCommit
    || runGit([
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ], CLIENT_SOURCE) !== ''
  ) {
    throw new Error('P5 retained client source is not the executor commit');
  }
  const result = spawnSync(ELECTRON_BINARY, [DRIVER_PATH], {
    cwd: CLIENT_SOURCE,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
    env: {
      ...process.env,
      AGENTMESH360_HOME: CLIENT_STATE_HOME,
      AGENTMESH360_HOST_BIN: HOST_BINARY,
      AGENTMESH360_HOST_MODE: 'embedded',
      AGENTMESH360_P5_AUTHORIZATION_ID: AUTHORIZATION_ID,
      AGENTMESH360_P5_BOUNDARY: CLIENT_BOUNDARY,
      AGENTMESH360_P5_E1_CANARY: '1',
      AGENTMESH360_P5_EXECUTOR_COMMIT: executorCommit,
      AGENTMESH360_P5_USER_DATA: CLIENT_USER_DATA,
      AGENTMESH360_PACKAGE_CANARY_E1: '1',
    },
  });
  if (
    result.error
    || result.status !== 0
    || !result.stdout.includes('"executionStatus":"live_host_scenarios_passed"')
    || !result.stdout.includes('"accountIdentifierPrinted":false')
    || !result.stdout.includes('"credentialMaterialPrinted":false')
  ) {
    throw new Error('P5 live Host scenario driver failed');
  }
}

async function assertExecutable(filePath, label) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) {
    throw new Error(`${label} is not an executable regular file`);
  }
}

async function assertAbsent(filePath, label) {
  try {
    await lstat(filePath);
    throw new Error(`${label} already exists`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function runScenarioMatrix(executorCommit) {
  await assertP5ExecutionAuthority(executorCommit);
  await Promise.all([
    assertPrivateDirectory(CLIENT_BOUNDARY, 'P5 retained client boundary'),
    assertPrivateDirectory(CLIENT_STATE_HOME, 'P5 retained client state'),
    assertPrivateDirectory(CLIENT_USER_DATA, 'P5 retained client userData'),
    assertExecutable(HOST_BINARY, 'P5 retained Host'),
    assertExecutable(ELECTRON_BINARY, 'Electron runtime'),
    assertAbsent(DRIVER_INPUT_PATH, 'P5 scenario driver input'),
    assertAbsent(HOST_RECEIPT_PATH, 'P5 live Host receipt'),
    assertAbsent(OUTPUT_RECEIPT_PATH, 'P5 scenario matrix receipt'),
  ]);
  const [
    authorization,
    oauth,
    byok,
    origin,
    publication,
  ] = await Promise.all([
    readStrictJson(AUTHORIZATION_PATH, 'P5 authorization'),
    readStrictJson(OAUTH_EVIDENCE_PATH, 'P5 OAuth evidence'),
    readStrictJson(BYOK_EVIDENCE_PATH, 'P5 BYOK evidence'),
    readStrictJson(ORIGIN_STATE_PATH, 'P5 origin state', { mode: 0o600 }),
    readStrictJson(PUBLICATION_STATE_PATH, 'P5 publication state', {
      mode: 0o600,
    }),
  ]);
  const providerOperationsUsed = validateEvidence(
    authorization.value,
    oauth.value,
    byok.value,
  );
  const syntheticOverCap = structuredClone(byok.value);
  syntheticOverCap.budget.providerInferenceOperationsUsed =
    MAX_PROVIDER_OPERATIONS + 1;
  let budgetGatePassed = false;
  try {
    validateProviderBudget(syntheticOverCap);
  } catch {
    budgetGatePassed = true;
  }
  if (!budgetGatePassed) {
    throw new Error('P5 synthetic Provider budget gate did not fail closed');
  }
  const roots = validatePublication(
    publication.value,
    origin.value,
    executorCommit,
  );
  if (path.dirname(INFRASTRUCTURE_BOUNDARY) !== '/private/tmp') {
    throw new Error('P5 infrastructure boundary drift');
  }
  runContractTests();
  await writeFile(
    DRIVER_INPUT_PATH,
    `${JSON.stringify(buildDriverInput({
      executorCommit,
      origin: origin.value,
      roots,
    }))}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  await chmod(DRIVER_INPUT_PATH, 0o600);
  runElectronDriver(executorCommit);
  const hostReceipt = await readStrictJson(
    HOST_RECEIPT_PATH,
    'P5 live Host receipt',
    { mode: 0o600 },
  );
  const hostResults = validateHostReceipt(
    hostReceipt.value,
    executorCommit,
  );
  const results = buildScenarioResults(hostResults);
  const receipt = {
    schemaVersion: 1,
    receiptId: 'package_canary_e1_scenario_matrix_20260729_0001',
    authorizationId: AUTHORIZATION_ID,
    environment: 'e1',
    workPackage: 'p5_package_canary',
    executionStatus: 'scenario_matrix_passed',
    executorCommit,
    inputDigests: {
      authorizationSha256: typedSha256(authorization.bytes),
      oauthEvidenceSha256: typedSha256(oauth.bytes),
      byokEvidenceSha256: typedSha256(byok.bytes),
      publicationStateSha256: typedSha256(publication.bytes),
      liveHostReceiptSha256: typedSha256(hostReceipt.bytes),
    },
    scenarioCount: results.length,
    results,
    budget: {
      providerInferenceOperationsUsed,
      providerInferenceOperationsAdded: 0,
      maximumProviderInferenceOperations: MAX_PROVIDER_OPERATIONS,
      agentMeshCreditsUsed: 0,
      maximumAgentMeshCredits: 0,
      maximumProviderCostUsd: 1,
      maximumInfrastructureCostUsd: 3,
    },
    mutationSummary: {
      packageMutationsPerformed: hostReceipt.value.packageMutationsPerformed,
      accountMutationsPerformed: 0,
      subscriptionMutationsPerformed: 0,
      productionMutationsPerformed: 0,
    },
    cleanupRequired: true,
    productionAuthorityGranted: false,
    accountIdentifierRecorded: false,
    credentialMaterialRecorded: false,
    promptOrResponseRecorded: false,
    completedAt: new Date().toISOString(),
  };
  await writeFile(OUTPUT_RECEIPT_PATH, `${JSON.stringify(receipt)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  await chmod(OUTPUT_RECEIPT_PATH, 0o600);
  return receipt;
}

function parseArguments(argv) {
  if (
    argv.length !== 2
    || argv[0] !== '--executor-commit'
    || !/^[0-9a-f]{40}$/u.test(argv[1] || '')
  ) {
    throw new Error(
      'usage: run-scenario-matrix.mjs --executor-commit <commit>',
    );
  }
  return { executorCommit: argv[1] };
}

function isMainModule() {
  return process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
  if (options) {
    runScenarioMatrix(options.executorCommit)
      .then((receipt) => {
        process.stdout.write(
          `P5 E1 ${receipt.scenarioCount}-scenario matrix passed with no additional Provider inference\n`,
        );
      })
      .catch(() => {
        process.stderr.write('P5 E1 scenario matrix failed\n');
        process.exitCode = 1;
      });
  }
}

export {
  CLIENT_BOUNDARY,
  DRIVER_INPUT_PATH,
  HARD_STOP,
  HOST_RECEIPT_PATH,
  HOST_SCENARIOS,
  OUTPUT_RECEIPT_PATH,
  SCENARIOS,
  buildDriverInput,
  buildScenarioResults,
  parseArguments,
  validateEvidence,
  validateHostReceipt,
  validateProviderBudget,
  validatePublication,
};
