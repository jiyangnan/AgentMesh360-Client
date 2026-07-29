#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  typedSha256,
} from '../distribution-e1/publish-release-set.mjs';
import {
  readCredentialFile,
  requestSpaces,
} from '../distribution-e1/spaces-client.mjs';
import {
  assertP5ExecutorAncestry,
} from '../distribution-e1/deploy-origin.mjs';
import {
  AUTHORIZATION_ID,
  CREDENTIAL_PATH,
} from './infrastructure-boundary.mjs';
import {
  ORIGIN_STATE_PATH,
  OUTPUT_STATE_PATH as PUBLICATION_STATE_PATH,
  RELEASE_STATE_PATH,
} from './publish-release-chain.mjs';
import {
  OUTPUT_RECEIPT_PATH as SCENARIO_RECEIPT_PATH,
} from './run-scenario-matrix.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const SIGNER = path.join(
  REPOSITORY_ROOT,
  'tools/release-provenance/e0-release-signer.mjs',
);
const AUTHORIZATION_PATH = path.join(
  REPOSITORY_ROOT,
  'docs/operations/tabletops/2026-07-29-p5-owner-account-e1-authorization.json',
);
const CLEANUP_AUTHORITY_FILES = Object.freeze([
  'docs/operations/tabletops/2026-07-29-p5-owner-account-e1-authorization.json',
  'tools/package-canary-e1/cleanup-release-chain.mjs',
  'tools/package-canary-e1/infrastructure-boundary.mjs',
  'tools/package-canary-e1/publish-release-chain.mjs',
  'tools/package-canary-e1/run-scenario-matrix.mjs',
  'tools/distribution-e1/deploy-origin.mjs',
  'tools/distribution-e1/spaces-client.mjs',
  'tools/release-provenance/e0-release-signer.mjs',
]);
const OUTPUT_STATE_PATH =
  '/private/tmp/agentmesh360-p5-e1-release-cleanup-state.json';
const PARTIAL_ROLLBACK_STATE_PATH =
  '/private/tmp/agentmesh360-p5-e1-partial-publication-rollback.json';
const REGISTRY_OBJECT_KEY = 'metadata/registry.v2.json';
const MAX_STATE_BYTES = 8 * 1024 * 1024;

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error('P5 Release cleanup git inspection failed');
  }
  return result.stdout.trim();
}

async function assertCleanupAuthority(executorCommit) {
  if (
    !/^[0-9a-f]{40}$/u.test(executorCommit || '')
    || runGit(['rev-parse', 'HEAD']) !== executorCommit
    || runGit(['rev-parse', 'origin/main']) !== executorCommit
    || runGit([
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]) !== ''
  ) {
    throw new Error('P5 Release cleanup executor is not the pushed commit');
  }
  for (const target of CLEANUP_AUTHORITY_FILES) {
    if (runGit(['diff', '--name-only', 'HEAD', '--', target]) !== '') {
      throw new Error('P5 Release cleanup implementation is dirty');
    }
  }
  const authorization = JSON.parse(
    await readFile(AUTHORIZATION_PATH, 'utf8'),
  );
  if (
    authorization.authorizationId !== AUTHORIZATION_ID
    || authorization.approvalStatus !== 'approved'
    || authorization.approvalReceipt?.productionAuthorityGranted !== false
    || authorization.cleanupPlan?.withdrawRegistryFirst !== true
    || authorization.cleanupPlan?.destroyEphemeralSigningKeys !== true
    || authorization.cleanupPlan?.retainOnlyNonSecretEvidence !== true
  ) {
    throw new Error('P5 Release cleanup authority is invalid');
  }
}

async function readMode0600Json(filePath, label) {
  const direct = await lstat(filePath);
  const resolved = await realpath(filePath);
  const info = await lstat(resolved);
  if (
    direct.isSymbolicLink()
    || !info.isFile()
    || info.isSymbolicLink()
    || info.size <= 0
    || info.size > MAX_STATE_BYTES
    || (info.mode & 0o777) !== 0o600
  ) {
    throw new Error(`${label} is not a bounded mode-0600 regular file`);
  }
  try {
    return JSON.parse(await readFile(resolved, 'utf8'));
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
}

function safeObjectKey(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= 1024
    && !value.startsWith('/')
    && !value.includes('\\')
    && value.split('/').every((part) => (
      part !== '' && part !== '.' && part !== '..'
    ))
  );
}

function strictInventory(publication) {
  if (
    publication?.schemaVersion !== 1
    || publication.authorizationId !== AUTHORIZATION_ID
    || publication.executionStatus !== 'published'
    || publication.registryPublishedLast !== true
    || publication.cleanupRequired !== true
    || !Array.isArray(publication.plannedObjects)
    || publication.plannedObjects.length < 20
    || !Array.isArray(publication.objectReceipts)
    || publication.objectReceipts.length !== publication.plannedObjects.length
  ) {
    throw new Error('P5 publication state is not a complete cleanup inventory');
  }
  const seen = new Set();
  for (let index = 0; index < publication.plannedObjects.length; index += 1) {
    const planned = publication.plannedObjects[index];
    const receipt = publication.objectReceipts[index];
    const identity = `${planned?.bucketClass}/${planned?.objectKey}`;
    if (
      !['release', 'metadata'].includes(planned?.bucketClass)
      || !safeObjectKey(planned.objectKey)
      || !/^sha256:[0-9a-f]{64}$/u.test(planned.sha256 || '')
      || seen.has(identity)
      || receipt?.bucketClass !== planned.bucketClass
      || receipt.objectKey !== planned.objectKey
      || receipt.sha256 !== planned.sha256
    ) {
      throw new Error('P5 publication cleanup inventory entry is invalid');
    }
    seen.add(identity);
  }
  const registry = publication.plannedObjects.at(-1);
  if (
    registry.bucketClass !== 'metadata'
    || registry.objectKey !== REGISTRY_OBJECT_KEY
  ) {
    throw new Error('P5 publication cleanup inventory is not Registry-last');
  }
  return publication.plannedObjects;
}

function strictPartialInventory(publication) {
  if (
    publication?.schemaVersion !== 1
    || publication.authorizationId !== AUTHORIZATION_ID
    || publication.executionStatus !== 'publishing'
    || publication.registryPublishedLast !== false
    || publication.cleanupRequired !== true
    || publication.temporaryRootPrivateKeyCount !== 2
    || !Array.isArray(publication.plannedObjects)
    || publication.plannedObjects.length < 20
    || !Array.isArray(publication.objectReceipts)
    || publication.objectReceipts.length >= publication.plannedObjects.length
  ) {
    throw new Error('P5 partial publication is not rollback-safe');
  }
  const seen = new Set();
  for (let index = 0; index < publication.plannedObjects.length; index += 1) {
    const planned = publication.plannedObjects[index];
    const identity = `${planned?.bucketClass}/${planned?.objectKey}`;
    if (
      !['release', 'metadata'].includes(planned?.bucketClass)
      || !safeObjectKey(planned.objectKey)
      || !/^sha256:[0-9a-f]{64}$/u.test(planned.sha256 || '')
      || seen.has(identity)
    ) {
      throw new Error('P5 partial publication plan is invalid');
    }
    seen.add(identity);
    if (index < publication.objectReceipts.length) {
      const receipt = publication.objectReceipts[index];
      if (
        receipt?.bucketClass !== planned.bucketClass
        || receipt.objectKey !== planned.objectKey
        || receipt.sha256 !== planned.sha256
      ) {
        throw new Error('P5 partial publication receipt is not a plan prefix');
      }
    }
  }
  const registry = publication.plannedObjects.at(-1);
  if (
    registry.bucketClass !== 'metadata'
    || registry.objectKey !== REGISTRY_OBJECT_KEY
  ) {
    throw new Error('P5 partial publication plan is not Registry-last');
  }
  return {
    next: publication.plannedObjects[publication.objectReceipts.length],
    planned: publication.plannedObjects,
    recorded: publication.objectReceipts,
    registry,
  };
}

function registryProbeConfig(hostname, ipAddress) {
  if (
    !/^packages-p5-e1-[0-9a-f]{8}\.agentmesh360\.com$/u.test(
      hostname || '',
    )
    || !/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(ipAddress || '')
  ) {
    throw new Error('P5 Registry withdrawal probe boundary is invalid');
  }
  return [
    'silent',
    'show-error',
    'max-time = 15',
    'max-redirs = 0',
    'proto = "=https"',
    'noproxy = "*"',
    `resolve = "${hostname}:443:${ipAddress}"`,
    'include',
    `url = "https://${hostname}/v2/registry.json"`,
    '',
  ].join('\n');
}

function registryIsWithdrawn(
  hostname,
  ipAddress,
  curlSpawn = spawnSync,
) {
  const result = curlSpawn('curl', ['--config', '-'], {
    encoding: 'utf8',
    input: registryProbeConfig(hostname, ipAddress),
    maxBuffer: 64 * 1024,
    timeout: 20_000,
  });
  return (
    !result.error
    && result.status === 0
    && /^HTTP\/\S+\s+404\b/u.test(result.stdout)
  );
}

async function deleteAndVerify(credentials, item) {
  const bucket = item.bucketClass === 'release'
    ? credentials.releasesBucket
    : credentials.metadataBucket;
  const deletion = await requestSpaces({
    credentials,
    principal: 'publisher',
    bucket,
    method: 'DELETE',
    objectKey: item.objectKey,
    expectedStatuses: [204],
  });
  await deletion.response.body?.cancel();
  const absence = await requestSpaces({
    credentials,
    principal: 'origin-reader',
    bucket,
    method: 'HEAD',
    objectKey: item.objectKey,
    expectedStatuses: [404],
  });
  await absence.response.body?.cancel();
}

async function deleteIfPresentAndVerify(credentials, item) {
  const bucket = item.bucketClass === 'release'
    ? credentials.releasesBucket
    : credentials.metadataBucket;
  const inspection = await requestSpaces({
    credentials,
    principal: 'publisher',
    bucket,
    method: 'HEAD',
    objectKey: item.objectKey,
    expectedStatuses: [200, 404],
  });
  const exists = inspection.response.status === 200;
  await inspection.response.body?.cancel();
  if (!exists) return false;
  const readback = await requestSpaces({
    credentials,
    principal: 'origin-reader',
    bucket,
    method: 'GET',
    objectKey: item.objectKey,
    expectedStatuses: [200],
  });
  const returned = Buffer.from(await readback.response.arrayBuffer());
  if (typedSha256(returned) !== item.sha256) {
    throw new Error('P5 unrecorded object differs from the publication plan');
  }
  await deleteAndVerify(credentials, item);
  return true;
}

function invokeSigner(boundary, target) {
  const result = spawnSync(process.execPath, [SIGNER], {
    encoding: 'utf8',
    input: `${JSON.stringify({
      action: 'destroy',
      boundary,
      target,
    })}\n`,
    maxBuffer: 256 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error('P5 isolated signer destruction failed');
  }
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new Error('P5 isolated signer returned invalid destruction evidence');
  }
  if (response.destroyed !== true) {
    throw new Error('P5 isolated signer did not destroy private material');
  }
}

async function privateInventory(release, publication) {
  if (
    release?.authorizationId !== AUTHORIZATION_ID
    || release.executionStatus !== 'release_chain_built'
    || release.generations?.length !== 2
    || publication.rootPrivateKeyPaths?.length !== 2
  ) {
    throw new Error('P5 private-material cleanup inventory is incomplete');
  }
  const temporaryRoot = await realpath(os.tmpdir());
  const values = [];
  for (const generation of release.generations) {
    const boundary = await realpath(generation.boundary);
    if (
      path.dirname(boundary) !== temporaryRoot
      || !path.basename(boundary).startsWith(
        'agentmesh360-release-provenance-e1-',
      )
      || generation.privateKeyPath
        !== path.join(boundary, 'private/publisher.pk8')
    ) {
      throw new Error('P5 retained Release boundary escaped cleanup scope');
    }
    const rootPath = publication.rootPrivateKeyPaths.find(
      (value) => path.dirname(path.dirname(value)) === boundary,
    );
    if (
      !rootPath
      || !/^root-[ab]\.pk8$/u.test(path.basename(rootPath))
      || path.dirname(rootPath) !== path.join(boundary, 'private')
    ) {
      throw new Error('P5 Root cleanup path does not match its generation');
    }
    values.push({
      boundary,
      publisherPath: generation.privateKeyPath,
      rootPath,
    });
  }
  if (
    new Set(values.map((value) => value.boundary)).size !== 2
    || new Set(values.flatMap((value) => [
      value.publisherPath,
      value.rootPath,
    ])).size !== 4
  ) {
    throw new Error('P5 private-material cleanup inventory is not unique');
  }
  return values;
}

async function writeState(state, flag = 'w') {
  await writeFile(OUTPUT_STATE_PATH, `${JSON.stringify(state)}\n`, {
    mode: 0o600,
    flag,
  });
  await chmod(OUTPUT_STATE_PATH, 0o600);
}

async function writePartialRollbackState(state, flag = 'w') {
  await writeFile(
    PARTIAL_ROLLBACK_STATE_PATH,
    `${JSON.stringify(state)}\n`,
    { mode: 0o600, flag },
  );
  await chmod(PARTIAL_ROLLBACK_STATE_PATH, 0o600);
}

function assertCleanupExecutorAncestry({
  cleanupExecutorCommit,
  originExecutorCommit,
  publicationExecutorCommit,
  releaseExecutorCommit,
  scenarioExecutorCommit,
}, assertAncestry = assertP5ExecutorAncestry) {
  assertAncestry(originExecutorCommit, releaseExecutorCommit);
  assertAncestry(releaseExecutorCommit, publicationExecutorCommit);
  assertAncestry(publicationExecutorCommit, scenarioExecutorCommit);
  assertAncestry(scenarioExecutorCommit, cleanupExecutorCommit);
}

async function rollbackPartialPublication(executorCommit) {
  await assertCleanupAuthority(executorCommit);
  try {
    await lstat(PARTIAL_ROLLBACK_STATE_PATH);
    throw new Error('P5 partial rollback state already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const [credentials, origin, publication, release] = await Promise.all([
    readCredentialFile(CREDENTIAL_PATH),
    readMode0600Json(ORIGIN_STATE_PATH, 'P5 origin state'),
    readMode0600Json(PUBLICATION_STATE_PATH, 'P5 publication state'),
    readMode0600Json(RELEASE_STATE_PATH, 'P5 Release Chain state'),
  ]);
  const inventory = strictPartialInventory(publication);
  const privateMaterial = await privateInventory(release, publication);
  assertP5ExecutorAncestry(
    origin.origin?.executorCommit,
    release.executorCommit,
  );
  assertP5ExecutorAncestry(
    release.executorCommit,
    publication.executorCommit,
  );
  assertP5ExecutorAncestry(publication.executorCommit, executorCommit);
  if (
    !/^am360-p5-e1-metadata-[0-9a-f]{8}$/u.test(
      credentials.metadataBucket || '',
    )
    || !/^am360-p5-e1-releases-[0-9a-f]{8}$/u.test(
      credentials.releasesBucket || '',
    )
  ) {
    throw new Error('P5 partial rollback credentials escaped the namespace');
  }
  const state = {
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    executorCommit,
    failedPublicationExecutorCommit: publication.executorCommit,
    executionStatus: 'withdrawing_possible_registry',
    recordedObjectCount: inventory.recorded.length,
    unrecordedNextObjectDeleted: false,
    registryWithdrawnFirst: false,
    deletedObjectCount: 0,
    verifiedAbsentObjectCount: 0,
    rootPrivateMaterialDestroyedCount: 0,
    publisherPrivateMaterialPreservedCount: 2,
    releaseBoundaryPreservedCount: 2,
    productionMutationCount: 0,
    cleanupRequired: true,
    startedAt: new Date().toISOString(),
  };
  await writePartialRollbackState(state, 'wx');

  const registryDeleted = await deleteIfPresentAndVerify(
    credentials,
    inventory.registry,
  );
  if (!registryIsWithdrawn(
    origin.dns.hostname,
    origin.droplet.publicIpv4,
  )) {
    throw new Error('P5 partial Registry is not publicly withdrawn');
  }
  state.registryWithdrawnFirst = true;
  state.deletedObjectCount += registryDeleted ? 1 : 0;
  state.verifiedAbsentObjectCount += 1;
  state.executionStatus = 'deleting_partial_objects';
  state.lastUpdatedAt = new Date().toISOString();
  await writePartialRollbackState(state);

  if (inventory.next.objectKey !== REGISTRY_OBJECT_KEY) {
    state.unrecordedNextObjectDeleted = await deleteIfPresentAndVerify(
      credentials,
      inventory.next,
    );
    state.deletedObjectCount += state.unrecordedNextObjectDeleted ? 1 : 0;
    state.verifiedAbsentObjectCount += 1;
    state.lastUpdatedAt = new Date().toISOString();
    await writePartialRollbackState(state);
  }
  for (const item of [...inventory.recorded].reverse()) {
    await deleteAndVerify(credentials, item);
    state.deletedObjectCount += 1;
    state.verifiedAbsentObjectCount += 1;
    state.lastUpdatedAt = new Date().toISOString();
    await writePartialRollbackState(state);
  }

  state.executionStatus = 'destroying_partial_roots';
  state.lastUpdatedAt = new Date().toISOString();
  await writePartialRollbackState(state);
  for (const item of privateMaterial) {
    invokeSigner(item.boundary, item.rootPath);
    state.rootPrivateMaterialDestroyedCount += 1;
    state.lastUpdatedAt = new Date().toISOString();
    await writePartialRollbackState(state);
  }
  await unlink(PUBLICATION_STATE_PATH);
  state.executionStatus = 'partial_publication_rolled_back';
  state.cleanupRequired = false;
  state.publicationStateRemoved = true;
  state.completedAt = new Date().toISOString();
  state.lastUpdatedAt = state.completedAt;
  await writePartialRollbackState(state);
  return state;
}

async function cleanupReleaseChain(executorCommit) {
  await assertCleanupAuthority(executorCommit);
  try {
    await lstat(OUTPUT_STATE_PATH);
    throw new Error('P5 Release cleanup state already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const [
    credentials,
    origin,
    publication,
    release,
    scenarios,
  ] = await Promise.all([
    readCredentialFile(CREDENTIAL_PATH),
    readMode0600Json(ORIGIN_STATE_PATH, 'P5 origin state'),
    readMode0600Json(PUBLICATION_STATE_PATH, 'P5 publication state'),
    readMode0600Json(RELEASE_STATE_PATH, 'P5 Release Chain state'),
    readMode0600Json(SCENARIO_RECEIPT_PATH, 'P5 scenario receipt'),
  ]);
  const inventory = strictInventory(publication);
  const privateMaterial = await privateInventory(release, publication);
  assertCleanupExecutorAncestry({
    cleanupExecutorCommit: executorCommit,
    originExecutorCommit: origin.origin?.executorCommit,
    publicationExecutorCommit: publication.executorCommit,
    releaseExecutorCommit: release.executorCommit,
    scenarioExecutorCommit: scenarios.executorCommit,
  });
  if (
    scenarios.executionStatus !== 'scenario_matrix_passed'
    || scenarios.scenarioCount !== 21
    || scenarios.results?.length !== 21
    || scenarios.results.some((result) => result.status !== 'passed')
    || !/^am360-p5-e1-metadata-[0-9a-f]{8}$/u.test(
      credentials.metadataBucket || '',
    )
    || !/^am360-p5-e1-releases-[0-9a-f]{8}$/u.test(
      credentials.releasesBucket || '',
    )
  ) {
    throw new Error('P5 Release cleanup prerequisites are incomplete');
  }
  const state = {
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    environment: 'e1',
    workPackage: 'p5_package_canary',
    executorCommit,
    executionStatus: 'withdrawing_registry',
    registryWithdrawnFirst: false,
    plannedObjectCount: inventory.length,
    deletedObjectCount: 0,
    verifiedAbsentObjectCount: 0,
    rootPrivateMaterialDestroyedCount: 0,
    publisherPrivateMaterialDestroyedCount: 0,
    releaseBoundaryRemovedCount: 0,
    providerInferenceOperationsAdded: 0,
    agentMeshCreditsUsed: 0,
    productionMutationCount: 0,
    cleanupRequired: true,
    startedAt: new Date().toISOString(),
  };
  await writeState(state, 'wx');

  const registry = inventory.at(-1);
  await deleteAndVerify(credentials, registry);
  if (!registryIsWithdrawn(
    origin.dns.hostname,
    origin.droplet.publicIpv4,
  )) {
    throw new Error('P5 Registry deletion is not publicly visible as 404');
  }
  state.registryWithdrawnFirst = true;
  state.deletedObjectCount = 1;
  state.verifiedAbsentObjectCount = 1;
  state.executionStatus = 'deleting_remaining_objects';
  state.lastUpdatedAt = new Date().toISOString();
  await writeState(state);

  for (const item of inventory.slice(0, -1).reverse()) {
    await deleteAndVerify(credentials, item);
    state.deletedObjectCount += 1;
    state.verifiedAbsentObjectCount += 1;
    state.lastUpdatedAt = new Date().toISOString();
    await writeState(state);
  }

  state.executionStatus = 'destroying_private_material';
  state.lastUpdatedAt = new Date().toISOString();
  await writeState(state);
  for (const item of privateMaterial) {
    invokeSigner(item.boundary, item.rootPath);
    state.rootPrivateMaterialDestroyedCount += 1;
    state.lastUpdatedAt = new Date().toISOString();
    await writeState(state);
    invokeSigner(item.boundary, item.publisherPath);
    state.publisherPrivateMaterialDestroyedCount += 1;
    state.lastUpdatedAt = new Date().toISOString();
    await writeState(state);
    await rm(item.boundary, { recursive: true, force: false });
    state.releaseBoundaryRemovedCount += 1;
    state.lastUpdatedAt = new Date().toISOString();
    await writeState(state);
  }

  state.executionStatus = 'release_chain_withdrawn';
  state.cleanupRequired = true;
  state.nextRequiredActions = [
    'remove_cloudflare_dns',
    'destroy_droplet',
    'delete_spaces_buckets_and_revoke_keys',
    'remove_temporary_byok_profile_binding_and_keychain_credential',
    'destroy_isolated_client_and_local_state',
  ];
  state.completedAt = new Date().toISOString();
  state.lastUpdatedAt = state.completedAt;
  await writeState(state);
  return state;
}

function parseArguments(argv) {
  if (
    argv.length !== 2
    || argv[0] !== '--executor-commit'
    || !/^[0-9a-f]{40}$/u.test(argv[1] || '')
  ) {
    if (
      argv.length === 3
      && argv[0] === 'rollback-partial'
      && argv[1] === '--executor-commit'
      && /^[0-9a-f]{40}$/u.test(argv[2] || '')
    ) {
      return {
        action: 'rollback-partial',
        executorCommit: argv[2],
      };
    }
    throw new Error(
      'usage: cleanup-release-chain.mjs '
      + '[rollback-partial] --executor-commit <commit>',
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
    const operation = options.action === 'rollback-partial'
      ? rollbackPartialPublication
      : cleanupReleaseChain;
    operation(options.executorCommit)
      .then((state) => {
        if (options.action === 'rollback-partial') {
          process.stdout.write(
            `P5 partial publication rolled back; ${state.deletedObjectCount} objects and two Root keys destroyed\n`,
          );
        } else {
          process.stdout.write(
            `P5 Registry withdrawn first; ${state.deletedObjectCount} objects and four private keys destroyed\n`,
          );
        }
      })
      .catch(() => {
        process.stderr.write('P5 Registry-first Release cleanup failed\n');
        process.exitCode = 1;
      });
  }
}

export {
  OUTPUT_STATE_PATH,
  PARTIAL_ROLLBACK_STATE_PATH,
  REGISTRY_OBJECT_KEY,
  assertCleanupExecutorAncestry,
  cleanupReleaseChain,
  parseArguments,
  registryIsWithdrawn,
  registryProbeConfig,
  rollbackPartialPublication,
  safeObjectKey,
  strictInventory,
  strictPartialInventory,
};
