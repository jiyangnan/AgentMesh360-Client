#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  constants,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const APPROVED_TEMP_ROOT = '/private/tmp';
const AUTHORIZATION_ID = 'package_canary_e1_20260729_0002';
const HARD_STOP = '2026-07-31T17:48:33Z';
const CLIENT_BOUNDARY = '/private/tmp/agentmesh360-p5-e1-client';
const INFRASTRUCTURE_BOUNDARY =
  '/private/tmp/agentmesh360-p5-e1-infrastructure';
const CLIENT_STATE = path.join(CLIENT_BOUNDARY, 'state');
const CLIENT_USER_DATA = path.join(CLIENT_BOUNDARY, 'user-data');
const CLIENT_SOURCE = path.join(CLIENT_BOUNDARY, 'source');
const CLIENT_BUILD = path.join(CLIENT_BOUNDARY, 'build');
const HOST_BINARY = path.join(
  CLIENT_BOUNDARY,
  'build/debug/xai-grok-pager',
);
const STATE_DB = path.join(CLIENT_STATE, 'state.db');
const HOST_LOCK = path.join(CLIENT_STATE, 'run/host.lock');
const PROVIDER_CLEANUP_RECEIPT = path.join(
  CLIENT_BOUNDARY,
  'local-provider-cleanup-receipt.json',
);
const PROVIDER_CREDENTIAL_STATE = path.join(
  CLIENT_BOUNDARY,
  'local-provider-cleanup-credential-ref.json',
);
const ELECTRON_BINARY = path.join(
  REPOSITORY_ROOT,
  'desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
);
const PROVIDER_CLEANUP_DRIVER = path.join(
  REPOSITORY_ROOT,
  'desktop/src/package-canary-e1-cleanup-driver.js',
);
const CLOUD_EVIDENCE = path.join(
  REPOSITORY_ROOT,
  'docs/operations/tabletops/2026-07-29-p5-e1-cloud-cleanup.json',
);
const MATRIX_RECEIPT =
  '/private/tmp/agentmesh360-p5-e1-scenario-matrix.json';
const RELEASE_CLEANUP_STATE =
  '/private/tmp/agentmesh360-p5-e1-release-cleanup-state.json';
const PUBLICATION_STATE =
  '/private/tmp/agentmesh360-p5-e1-publication-state.json';
const RELEASE_STATE =
  '/private/tmp/agentmesh360-p5-e1-release-chain-state.json';
const KEYCHAIN_SERVICE = 'com.agentmesh360.client.provider';
const EXPECTED_TEMP_NAMES = new Set([
  'agentmesh360-p5-e1-client',
  'agentmesh360-p5-e1-client-advance.json',
  'agentmesh360-p5-e1-cloudflare-state.json',
  'agentmesh360-p5-e1-infrastructure',
  'agentmesh360-p5-e1-partial-publication-rollback.json',
  'agentmesh360-p5-e1-publication-state.json',
  'agentmesh360-p5-e1-release-chain-preflight.json',
  'agentmesh360-p5-e1-release-chain-state.json',
  'agentmesh360-p5-e1-release-cleanup-state.json',
  'agentmesh360-p5-e1-scenario-matrix.json',
  'agentmesh360-p5-e1-spaces-credentials.json',
]);
const STANDALONE_TEMP_PATHS = [
  '/private/tmp/agentmesh360-p5-e1-client-advance.json',
  '/private/tmp/agentmesh360-p5-e1-cloudflare-state.json',
  '/private/tmp/agentmesh360-p5-e1-partial-publication-rollback.json',
  '/private/tmp/agentmesh360-p5-e1-publication-state.json',
  '/private/tmp/agentmesh360-p5-e1-release-chain-preflight.json',
  '/private/tmp/agentmesh360-p5-e1-release-chain-state.json',
  '/private/tmp/agentmesh360-p5-e1-release-cleanup-state.json',
  '/private/tmp/agentmesh360-p5-e1-scenario-matrix.json',
  '/private/tmp/agentmesh360-p5-e1-spaces-credentials.json',
];

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
    stdio: options.stdio,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed`);
  }
  return result.stdout?.trim() ?? '';
}

function runGit(args) {
  return run('git', args, 'P5 local finalizer git inspection', {
    cwd: REPOSITORY_ROOT,
  });
}

function assertAncestry(ancestor, descendant) {
  if (
    !/^[0-9a-f]{40}$/u.test(ancestor ?? '')
    || !/^[0-9a-f]{40}$/u.test(descendant ?? '')
  ) {
    throw new Error('P5 local finalizer provenance is invalid');
  }
  runGit(['merge-base', '--is-ancestor', ancestor, descendant]);
}

async function assertExecutorBoundary(executorCommit) {
  if (
    !/^[0-9a-f]{40}$/u.test(executorCommit ?? '')
    || runGit(['rev-parse', 'HEAD']) !== executorCommit
    || runGit(['rev-parse', 'origin/main']) !== executorCommit
    || runGit([
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]) !== ''
    || Date.now() >= Date.parse(HARD_STOP)
  ) {
    throw new Error(
      'P5 local finalizer is not the approved clean pushed executor',
    );
  }
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

async function readStrictJson(filePath, label, expectedMode) {
  const info = await lstat(filePath);
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || (info.mode & 0o777) !== expectedMode
    || info.size <= 0
    || info.size > 8 * 1024 * 1024
  ) {
    throw new Error(`${label} is not a strict local evidence file`);
  }
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function matchingTempNames(temporaryRoot = APPROVED_TEMP_ROOT) {
  return (await readdir(temporaryRoot))
    .filter((name) => (
      name.startsWith('agentmesh360-p5-e1')
      || name.startsWith('agentmesh360-release-provenance-e1-')
    ))
    .sort();
}

function strictTempInventory(names) {
  if (
    !Array.isArray(names)
    || names.length !== EXPECTED_TEMP_NAMES.size
    || names.some((name) => !EXPECTED_TEMP_NAMES.has(name))
  ) {
    throw new Error(
      'P5 local temporary inventory is incomplete or expanded',
    );
  }
  return names;
}

async function validateBoundary(directory, expectedName) {
  const temporaryRoot = await realpath(APPROVED_TEMP_ROOT);
  const resolved = await realpath(directory);
  const info = await lstat(directory);
  if (
    resolved !== path.join(temporaryRoot, expectedName)
    || !info.isDirectory()
    || info.isSymbolicLink()
    || (info.mode & 0o777) !== 0o700
  ) {
    throw new Error('P5 local boundary is invalid');
  }
  return resolved;
}

function queryRows(sql) {
  const stdout = run(
    'sqlite3',
    ['-json', STATE_DB, sql],
    'P5 isolated provider inventory inspection',
  );
  try {
    return stdout ? JSON.parse(stdout) : [];
  } catch {
    throw new Error('P5 isolated provider inventory is invalid');
  }
}

function providerInventory() {
  const profiles = queryRows(
    'SELECT profile_id, preset_id, credential_ref '
    + 'FROM provider_profiles ORDER BY profile_id;',
  );
  const assignments = queryRows(
    'SELECT assignment_id, provider_profile_id, model_id '
    + 'FROM model_assignments ORDER BY assignment_id;',
  );
  const bindings = queryRows(
    'SELECT binding_id, provider_profile_id, model_id '
    + 'FROM session_provider_bindings ORDER BY binding_id;',
  );
  if (
    profiles.length !== 1
    || profiles[0].preset_id !== 'google-gemini'
    || !/^credential:\/\/vault\/h_[0-9a-f]{32}$/u.test(
      profiles[0].credential_ref ?? '',
    )
    || assignments.length !== 1
    || assignments[0].provider_profile_id !== profiles[0].profile_id
    || assignments[0].model_id !== 'gemini-3.5-flash-lite'
    || bindings.length !== 1
    || bindings[0].provider_profile_id !== profiles[0].profile_id
    || bindings[0].model_id !== 'gemini-3.5-flash-lite'
  ) {
    throw new Error('P5 temporary Provider inventory is invalid');
  }
  return {
    credentialRef: profiles[0].credential_ref,
    profileId: profiles[0].profile_id,
  };
}

function keychainCredentialPresent(credentialRef) {
  const result = spawnSync('security', [
    'find-generic-password',
    '-s',
    KEYCHAIN_SERVICE,
    '-a',
    credentialRef,
  ], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
  });
  if (!result.error && result.status === 0) return true;
  if (!result.error && result.status === 44) return false;
  throw new Error('P5 Keychain inspection failed');
}

function runProviderCleanup(hostExecutorCommit) {
  const result = spawnSync(ELECTRON_BINARY, [PROVIDER_CLEANUP_DRIVER], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
    env: {
      ...process.env,
      AGENTMESH360_HOME: CLIENT_STATE,
      AGENTMESH360_HOST_BIN: HOST_BINARY,
      AGENTMESH360_HOST_MODE: 'embedded',
      AGENTMESH360_P5_AUTHORIZATION_ID: AUTHORIZATION_ID,
      AGENTMESH360_P5_BOUNDARY: CLIENT_BOUNDARY,
      AGENTMESH360_P5_E1_CANARY: '1',
      AGENTMESH360_P5_EXECUTOR_COMMIT: hostExecutorCommit,
      AGENTMESH360_P5_USER_DATA: CLIENT_USER_DATA,
      AGENTMESH360_PACKAGE_CANARY_E1: '1',
    },
  });
  if (
    result.error
    || result.status !== 0
    || !result.stdout.includes(
      '"executionStatus":"temporary_provider_deleted"',
    )
    || !result.stdout.includes('"accountIdentifierPrinted":false')
    || !result.stdout.includes('"credentialMaterialPrinted":false')
  ) {
    throw new Error('P5 temporary Provider cleanup driver failed');
  }
}

async function stopRetainedLeader() {
  const raw = (await readFile(HOST_LOCK, 'utf8')).trim();
  if (!/^[1-9][0-9]{0,9}$/u.test(raw)) {
    throw new Error('P5 retained Host lock is invalid');
  }
  const pid = Number(raw);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') alive = false;
    else throw error;
  }
  if (alive) {
    const command = run(
      'ps',
      ['-p', String(pid), '-o', 'command='],
      'P5 retained Host process inspection',
    );
    if (
      !command.includes(HOST_BINARY)
      || !/\bagent\s+leader\b/u.test(command)
    ) {
      throw new Error('P5 retained Host lock points outside the boundary');
    }
    process.kill(pid, 'SIGTERM');
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code === 'ESRCH') {
          alive = false;
          break;
        }
        throw error;
      }
    }
    if (alive) {
      process.kill(pid, 'SIGKILL');
    }
  }
  return true;
}

async function securelyUnlink(filePath) {
  if (!Number.isInteger(constants.O_NOFOLLOW)) {
    throw new Error('platform does not provide O_NOFOLLOW');
  }
  const handle = await open(
    filePath,
    constants.O_RDWR | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 0 || info.size > 64 * 1024 * 1024) {
      throw new Error('P5 secure cleanup target is not a bounded file');
    }
    let offset = 0;
    while (offset < info.size) {
      const length = Math.min(4096, info.size - offset);
      const bytes = randomBytes(length);
      try {
        await handle.write(bytes, 0, bytes.length, offset);
      } finally {
        bytes.fill(0);
      }
      offset += length;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await unlink(filePath);
}

async function securelyRemovePrivateTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await securelyRemovePrivateTree(target);
    } else if (entry.isFile()) {
      await securelyUnlink(target);
    } else {
      await unlink(target);
    }
  }
  await rmdir(directory);
}

async function removeClientBoundary() {
  await rm(CLIENT_BUILD, { force: false, recursive: true, maxRetries: 3 });
  await rm(CLIENT_SOURCE, { force: false, recursive: true, maxRetries: 3 });
  await securelyRemovePrivateTree(CLIENT_STATE);
  await securelyRemovePrivateTree(CLIENT_USER_DATA);
  const entries = await readdir(CLIENT_BOUNDARY, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(CLIENT_BOUNDARY, entry.name);
    if (entry.isFile()) {
      await securelyUnlink(target);
    } else if (entry.isDirectory()) {
      await securelyRemovePrivateTree(target);
    } else {
      await unlink(target);
    }
  }
  await rmdir(CLIENT_BOUNDARY);
}

function validateCloudEvidence(value) {
  if (
    value?.schemaVersion !== 1
    || value.authorizationId !== AUTHORIZATION_ID
    || value.executionStatus !== 'cloud_resources_withdrawn'
    || value.dnsRecordAbsent !== true
    || value.exactDropletCount !== 0
    || value.operatorPrivateKeyAbsent !== true
    || value.limitedAccessKeyCount !== 0
    || value.bucketDeletionScheduledCount !== 2
    || value.bucketObjectCount !== 0
    || value.billableBucketCount !== 0
    || value.productionMutationCount !== 0
    || value.providerInferenceOperationsAdded !== 0
    || value.agentMeshCreditsUsed !== 0
    || value.approvedInfrastructureBudgetHardCapUsd !== 3
    || !Number.isFinite(value.estimatedInfrastructureCostUsdUpperBound)
    || value.estimatedInfrastructureCostUsdUpperBound < 0
    || value.estimatedInfrastructureCostUsdUpperBound > 3
    || value.invoiceFinal !== false
  ) {
    throw new Error('P5 cloud cleanup evidence is incomplete');
  }
}

function validateCleanupEvidence(
  matrix,
  cleanup,
  publication,
  release,
  executorCommit,
  assertOrdered = assertAncestry,
) {
  if (
    matrix?.authorizationId !== AUTHORIZATION_ID
    || matrix.executionStatus !== 'scenario_matrix_passed'
    || matrix.scenarioCount !== 21
    || matrix.results?.length !== 21
    || matrix.results.some((result) => result.status !== 'passed')
    || matrix.budget?.providerInferenceOperationsUsed !== 4
    || matrix.budget?.providerInferenceOperationsAdded !== 0
    || matrix.budget?.agentMeshCreditsUsed !== 0
    || matrix.mutationSummary?.packageMutationsPerformed !== 5
    || cleanup?.authorizationId !== AUTHORIZATION_ID
    || cleanup.executionStatus !== 'release_chain_withdrawn'
    || cleanup.registryWithdrawnFirst !== true
    || cleanup.plannedObjectCount !== 61
    || cleanup.deletedObjectCount !== 61
    || cleanup.verifiedAbsentObjectCount !== 61
    || cleanup.rootPrivateMaterialDestroyedCount !== 2
    || cleanup.publisherPrivateMaterialDestroyedCount !== 2
    || cleanup.releaseBoundaryRemovedCount !== 2
    || publication?.authorizationId !== AUTHORIZATION_ID
    || publication.executionStatus !== 'published'
    || publication.plannedObjects?.length !== 61
    || release?.authorizationId !== AUTHORIZATION_ID
    || release.executionStatus !== 'release_chain_built'
    || release.generations?.length !== 2
  ) {
    throw new Error('P5 local cleanup evidence is incomplete');
  }
  assertOrdered(matrix.executorCommit, cleanup.executorCommit);
  assertOrdered(cleanup.executorCommit, executorCommit);
  return matrix.hostExecutorCommit;
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeCredentialCleanupState(credentialRef) {
  await writeFile(
    PROVIDER_CREDENTIAL_STATE,
    `${JSON.stringify({
      schemaVersion: 1,
      authorizationId: AUTHORIZATION_ID,
      credentialRef,
    })}\n`,
    {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    },
  );
}

async function prepareProviderCleanup(hostExecutorCommit) {
  const credentialStateExists = await pathExists(PROVIDER_CREDENTIAL_STATE);
  if (!credentialStateExists) {
    const provider = providerInventory();
    if (!keychainCredentialPresent(provider.credentialRef)) {
      throw new Error('P5 temporary Provider credential is already absent');
    }
    await writeCredentialCleanupState(provider.credentialRef);
  }
  const credentialState = await readStrictJson(
    PROVIDER_CREDENTIAL_STATE,
    'P5 Provider credential cleanup state',
    0o600,
  );
  if (
    credentialState.authorizationId !== AUTHORIZATION_ID
    || !/^credential:\/\/vault\/h_[0-9a-f]{32}$/u.test(
      credentialState.credentialRef ?? '',
    )
  ) {
    throw new Error('P5 Provider credential cleanup state is invalid');
  }
  if (!(await pathExists(PROVIDER_CLEANUP_RECEIPT))) {
    const provider = providerInventory();
    if (
      provider.credentialRef !== credentialState.credentialRef
      || !keychainCredentialPresent(provider.credentialRef)
    ) {
      throw new Error('P5 Provider cleanup cannot be resumed safely');
    }
    runProviderCleanup(hostExecutorCommit);
  }
  return credentialState.credentialRef;
}

async function assertPrivateMaterialAbsent(publication, release) {
  const values = [
    ...(publication.rootPrivateKeyPaths ?? []),
    ...release.generations.flatMap((generation) => [
      generation.privateKeyPath,
      generation.boundary,
    ]),
  ];
  if (values.length !== 6) {
    throw new Error('P5 destroyed private-material inventory is incomplete');
  }
  for (const value of values) {
    try {
      await lstat(value);
      throw new Error('P5 private material still exists');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function finalizeLocalCleanup(executorCommit) {
  await assertExecutorBoundary(executorCommit);
  strictTempInventory(await matchingTempNames());
  await Promise.all([
    validateBoundary(
      CLIENT_BOUNDARY,
      'agentmesh360-p5-e1-client',
    ),
    validateBoundary(
      INFRASTRUCTURE_BOUNDARY,
      'agentmesh360-p5-e1-infrastructure',
    ),
  ]);
  const [
    cloud,
    matrix,
    cleanup,
    publication,
    release,
  ] = await Promise.all([
    readStrictJson(CLOUD_EVIDENCE, 'P5 cloud cleanup evidence', 0o644),
    readStrictJson(MATRIX_RECEIPT, 'P5 matrix receipt', 0o600),
    readStrictJson(RELEASE_CLEANUP_STATE, 'P5 Release cleanup state', 0o600),
    readStrictJson(PUBLICATION_STATE, 'P5 publication state', 0o600),
    readStrictJson(RELEASE_STATE, 'P5 Release state', 0o600),
  ]);
  validateCloudEvidence(cloud);
  const hostExecutorCommit = validateCleanupEvidence(
    matrix,
    cleanup,
    publication,
    release,
    executorCommit,
  );
  await assertPrivateMaterialAbsent(publication, release);
  if (
    run(
      'git',
      ['rev-parse', 'HEAD'],
      'P5 retained source git inspection',
      { cwd: CLIENT_SOURCE },
    ) !== hostExecutorCommit
  ) {
    throw new Error('P5 retained source differs from the Host executor');
  }
  const credentialRef = await prepareProviderCleanup(hostExecutorCommit);
  const providerCleanup = await readStrictJson(
    PROVIDER_CLEANUP_RECEIPT,
    'P5 Provider cleanup receipt',
    0o600,
  );
  if (
    providerCleanup.authorizationId !== AUTHORIZATION_ID
    || providerCleanup.executionStatus !== 'temporary_provider_deleted'
    || providerCleanup.providerProfileDeletedCount !== 1
    || providerCleanup.providerAssignmentDeletedCount !== 1
    || providerCleanup.providerInferenceOperationsAdded !== 0
    || providerCleanup.agentMeshCreditsUsed !== 0
    || providerCleanup.productionMutationCount !== 0
    || keychainCredentialPresent(credentialRef)
    || queryRows('SELECT COUNT(*) AS count FROM provider_profiles;')[0]?.count
      !== 0
    || queryRows('SELECT COUNT(*) AS count FROM model_assignments;')[0]?.count
      !== 0
    || queryRows(
      'SELECT COUNT(*) AS count FROM session_provider_bindings;',
    )[0]?.count !== 1
  ) {
    throw new Error('P5 temporary Provider cleanup is incomplete');
  }
  await stopRetainedLeader();
  await removeClientBoundary();
  await securelyRemovePrivateTree(INFRASTRUCTURE_BOUNDARY);
  for (const filePath of STANDALONE_TEMP_PATHS) {
    await securelyUnlink(filePath);
  }
  const remaining = await matchingTempNames();
  if (remaining.length !== 0) {
    throw new Error('P5 local temporary state remains after finalization');
  }
  return {
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    environment: 'e1',
    workPackage: 'p5_package_canary',
    executorCommit,
    executionStatus: 'local_secret_state_destroyed',
    providerProfileDeletedCount: 1,
    providerAssignmentDeletedCount: 1,
    historicalProviderBindingDestroyedWithBoundaryCount: 1,
    keychainCredentialDeletedCount: 1,
    destroyedStandaloneFileCount: STANDALONE_TEMP_PATHS.length,
    destroyedBoundaryCount: 2,
    remainingP5TempEntryCount: 0,
    productionPackageConstantsEmpty: true,
    providerInferenceOperationsAdded: 0,
    agentMeshCreditsUsed: 0,
    productionMutationCount: 0,
    completedAt: new Date().toISOString(),
  };
}

function parseArguments(argv) {
  if (
    argv.length !== 2
    || argv[0] !== '--executor-commit'
    || !/^[0-9a-f]{40}$/u.test(argv[1] ?? '')
  ) {
    throw new Error(
      'usage: finalize-local-cleanup.mjs --executor-commit <commit>',
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
    finalizeLocalCleanup(options.executorCommit)
      .then((receipt) => {
        process.stdout.write(`${JSON.stringify(receipt)}\n`);
      })
      .catch(() => {
        process.stderr.write('P5 local cleanup failed\n');
        process.exitCode = 1;
      });
  }
}

export {
  EXPECTED_TEMP_NAMES,
  finalizeLocalCleanup,
  parseArguments,
  strictTempInventory,
  validateCleanupEvidence,
  validateCloudEvidence,
};
