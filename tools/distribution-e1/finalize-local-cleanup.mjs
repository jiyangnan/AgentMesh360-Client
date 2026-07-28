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
  rmdir,
  unlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const AUTHORIZATION_ID = 'distribution_service_e1_20260728_0001';
const EXPECTED_TEMP_NAMES = new Set([
  'agentmesh360-distribution-e1-cleanup-state.json',
  'agentmesh360-distribution-e1-current',
  'agentmesh360-distribution-e1-fault-matrix.json',
  'agentmesh360-distribution-e1-publication-state.json',
  'agentmesh360-distribution-e1-release-set-state.json',
  'agentmesh360-distribution-e1-replacement',
  'agentmesh360-p4-e1-spaces-current.json',
]);
const TEMP_PREFIXES = [
  'agentmesh360-distribution-e1-',
  'agentmesh360-p4-e1-',
  'agentmesh360-release-provenance-e1-',
];

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error('local finalizer git inspection failed');
  }
  return result.stdout.trim();
}

async function assertExecutorBoundary(executorCommit) {
  if (
    !/^[0-9a-f]{40}$/u.test(executorCommit)
    || runGit(['rev-parse', 'HEAD']) !== executorCommit
    || runGit(['status', '--porcelain=v1', '--untracked-files=all']) !== ''
  ) {
    throw new Error('local finalizer is not the approved clean commit');
  }
  const trustSource = await readFile(path.join(
    REPOSITORY_ROOT,
    'crates/codegen/xai-grok-shell/src/agentmesh360/package_trust.rs',
  ), 'utf8');
  const fetcherSource = await readFile(path.join(
    REPOSITORY_ROOT,
    'crates/codegen/xai-grok-shell/src/agentmesh360/package_registry_fetcher.rs',
  ), 'utf8');
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
  const sourceStat = await lstat(filePath);
  if (
    !sourceStat.isFile()
    || sourceStat.isSymbolicLink()
    || (sourceStat.mode & 0o777) !== expectedMode
    || sourceStat.size <= 0
    || sourceStat.size > 8 * 1024 * 1024
  ) {
    throw new Error(`${label} is not a strict local evidence file`);
  }
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function matchingTempNames(temporaryRoot = os.tmpdir()) {
  return (await readdir(temporaryRoot))
    .filter((name) => TEMP_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .sort();
}

function strictTempInventory(names) {
  if (
    !Array.isArray(names)
    || names.length !== EXPECTED_TEMP_NAMES.size
    || names.some((name) => !EXPECTED_TEMP_NAMES.has(name))
  ) {
    throw new Error('local E1 temporary inventory is incomplete or expanded');
  }
  return names;
}

async function validateDirectory(directory, expectedName) {
  const temporaryRoot = await realpath(os.tmpdir());
  const resolved = await realpath(directory);
  const stat = await lstat(directory);
  if (
    resolved !== path.join(temporaryRoot, expectedName)
    || !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o777) !== 0o700
  ) {
    throw new Error('local E1 boundary is not the expected mode-0700 directory');
  }
  return resolved;
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
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 0 || stat.size > 64 * 1024 * 1024) {
      throw new Error('local cleanup target is not a bounded regular file');
    }
    let offset = 0;
    while (offset < stat.size) {
      const length = Math.min(4096, stat.size - offset);
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

async function securelyRemoveTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error('local E1 boundary contains a symbolic link');
    }
    if (entry.isDirectory()) {
      await securelyRemoveTree(target);
    } else if (entry.isFile()) {
      await securelyUnlink(target);
    } else {
      throw new Error('local E1 boundary contains an unsupported entry');
    }
  }
  await rmdir(directory);
}

async function finalize(options) {
  await assertExecutorBoundary(options.executorCommit);
  const cloud = await readStrictJson(
    options.cloudEvidence,
    'cloud cleanup evidence',
    0o644,
  );
  const objectCleanup = await readStrictJson(
    options.objectCleanupState,
    'object cleanup state',
    0o600,
  );
  const publication = await readStrictJson(
    options.publicationState,
    'publication state',
    0o600,
  );
  const release = await readStrictJson(
    options.releaseState,
    'Release Set state',
    0o600,
  );
  const fault = await readStrictJson(
    options.faultReceipt,
    'fault-matrix receipt',
    0o600,
  );
  await readStrictJson(options.credentials, 'Spaces credentials', 0o600);
  if (
    cloud.authorizationId !== AUTHORIZATION_ID
    || cloud.executionStatus !== 'cloud_resources_withdrawn'
    || cloud.dnsRecordAbsent !== true
    || cloud.exactDropletCount !== 0
    || cloud.operatorPrivateKeyAbsent !== true
    || cloud.limitedAccessKeyCount !== 0
    || cloud.bucketDeletionScheduledCount !== 2
    || cloud.bucketObjectCount !== 0
    || cloud.billableBucketCount !== 0
    || cloud.productionMutationCount !== 0
    || objectCleanup.authorizationId !== AUTHORIZATION_ID
    || objectCleanup.executionStatus
      !== 'objects_and_private_material_destroyed'
    || objectCleanup.registryWithdrawnFirst !== true
    || objectCleanup.deletedObjectCount !== 35
    || objectCleanup.verifiedAbsentObjectCount !== 35
    || objectCleanup.rootPrivateMaterialDestroyed !== true
    || objectCleanup.publisherPrivateMaterialDestroyed !== true
    || objectCleanup.releaseBoundaryRemoved !== true
    || publication.authorizationId !== AUTHORIZATION_ID
    || release.authorizationId !== AUTHORIZATION_ID
    || fault.authorizationId !== AUTHORIZATION_ID
    || fault.executionStatus !== 'fault_matrix_passed'
    || fault.scenarioCount !== 14
  ) {
    throw new Error('local finalizer prerequisite evidence is incomplete');
  }
  try {
    await lstat(release.boundary);
    throw new Error('Release boundary unexpectedly still exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const privatePath of [
    publication.rootPrivateKeyPath,
    publication.publisherPrivateKeyPath,
  ]) {
    try {
      await lstat(privatePath);
      throw new Error('ephemeral signing private material still exists');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  strictTempInventory(await matchingTempNames());
  const oldBoundary = await validateDirectory(
    options.oldBoundary,
    'agentmesh360-distribution-e1-current',
  );
  const activeBoundary = await validateDirectory(
    options.activeBoundary,
    'agentmesh360-distribution-e1-replacement',
  );
  for (const filePath of [
    options.credentials,
    options.faultReceipt,
    options.publicationState,
    options.releaseState,
    options.objectCleanupState,
  ]) {
    await securelyUnlink(filePath);
  }
  await securelyRemoveTree(oldBoundary);
  await securelyRemoveTree(activeBoundary);
  const remaining = await matchingTempNames();
  if (remaining.length !== 0) {
    throw new Error('local E1 temporary inventory remains after finalization');
  }
  return {
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    environment: 'e1',
    workPackage: 'p4_r3',
    executorCommit: options.executorCommit,
    executionStatus: 'local_secret_state_destroyed',
    destroyedStandaloneFileCount: 5,
    destroyedBoundaryCount: 2,
    remainingE1TempEntryCount: 0,
    productionPackageConstantsEmpty: true,
    providerRequests: 0,
    creditsConsumed: 0,
    completedAt: new Date().toISOString(),
  };
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value == null || values.has(key)) {
      throw new Error('invalid or duplicate argument');
    }
    values.set(key, value);
  }
  const required = [
    '--active-boundary',
    '--cloud-evidence',
    '--credentials',
    '--executor-commit',
    '--fault-receipt',
    '--object-cleanup-state',
    '--old-boundary',
    '--publication-state',
    '--release-state',
  ];
  if (
    values.size !== required.length
    || required
      .filter((key) => key !== '--executor-commit')
      .some((key) => !path.isAbsolute(values.get(key) ?? ''))
    || !/^[0-9a-f]{40}$/u.test(values.get('--executor-commit') ?? '')
  ) {
    throw new Error(
      'usage: finalize-local-cleanup.mjs --executor-commit <commit> '
      + '--cloud-evidence <absolute> --credentials <absolute> '
      + '--object-cleanup-state <absolute> --publication-state <absolute> '
      + '--release-state <absolute> --fault-receipt <absolute> '
      + '--old-boundary <absolute> --active-boundary <absolute>',
    );
  }
  return {
    activeBoundary: values.get('--active-boundary'),
    cloudEvidence: values.get('--cloud-evidence'),
    credentials: values.get('--credentials'),
    executorCommit: values.get('--executor-commit'),
    faultReceipt: values.get('--fault-receipt'),
    objectCleanupState: values.get('--object-cleanup-state'),
    oldBoundary: values.get('--old-boundary'),
    publicationState: values.get('--publication-state'),
    releaseState: values.get('--release-state'),
  };
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
  if (options) {
    finalize(options)
      .then((receipt) => {
        console.log(JSON.stringify(receipt));
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}

export {
  parseArguments,
  strictTempInventory,
};
