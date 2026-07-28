#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  readCredentialFile,
  requestSpaces,
} from './spaces-client.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const SIGNER = path.join(
  REPOSITORY_ROOT,
  'tools/release-provenance/e0-release-signer.mjs',
);
const AUTHORIZATION_ID = 'distribution_service_e1_20260728_0001';
const REGISTRY_OBJECT_KEY = 'metadata/registry.v2.json';
const EXPECTED_SCENARIOS = 14;

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error('cleanup executor git inspection failed');
  }
  return result.stdout.trim();
}

async function assertExecutorBoundary(executorCommit) {
  if (
    !/^[0-9a-f]{40}$/u.test(executorCommit)
    || runGit(['rev-parse', 'HEAD']) !== executorCommit
    || runGit(['status', '--porcelain=v1', '--untracked-files=all']) !== ''
  ) {
    throw new Error('cleanup executor is not the approved clean commit');
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

async function readMode0600Json(filePath, label, maximum = 8 * 1024 * 1024) {
  const sourceStat = await lstat(filePath);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }
  const resolved = await realpath(filePath);
  const stat = await lstat(resolved);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size <= 0
    || stat.size > maximum
    || (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error(`${label} must be a bounded mode-0600 regular file`);
  }
  try {
    return JSON.parse(await readFile(resolved, 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function safeObjectKey(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= 1024
    && !value.startsWith('/')
    && !value.includes('\\')
    && value.split('/').every((part) =>
      part !== '' && part !== '.' && part !== '..')
  );
}

function strictInventory(publication) {
  if (
    publication?.schemaVersion !== 1
    || publication.authorizationId !== AUTHORIZATION_ID
    || publication.executionStatus !== 'published'
    || publication.registryPublishedLast !== true
    || !Array.isArray(publication.plannedObjects)
    || publication.plannedObjects.length !== 35
    || !Array.isArray(publication.objectReceipts)
    || publication.objectReceipts.length !== 35
  ) {
    throw new Error('publication state is not a complete E1 inventory');
  }
  const seen = new Set();
  let releases = 0;
  let metadata = 0;
  for (let index = 0; index < publication.plannedObjects.length; index += 1) {
    const planned = publication.plannedObjects[index];
    const receipt = publication.objectReceipts[index];
    if (
      !['release', 'metadata'].includes(planned?.bucketClass)
      || !safeObjectKey(planned.objectKey)
      || !/^sha256:[0-9a-f]{64}$/u.test(planned.sha256)
      || seen.has(`${planned.bucketClass}/${planned.objectKey}`)
      || receipt?.bucketClass !== planned.bucketClass
      || receipt.objectKey !== planned.objectKey
      || receipt.sha256 !== planned.sha256
    ) {
      throw new Error('publication inventory entry is invalid');
    }
    seen.add(`${planned.bucketClass}/${planned.objectKey}`);
    if (planned.bucketClass === 'release') releases += 1;
    else metadata += 1;
  }
  const last = publication.plannedObjects.at(-1);
  if (
    releases !== 27
    || metadata !== 8
    || last.bucketClass !== 'metadata'
    || last.objectKey !== REGISTRY_OBJECT_KEY
  ) {
    throw new Error('publication inventory order or class count is invalid');
  }
  return publication.plannedObjects;
}

async function strictReleaseBoundary(release, publication) {
  if (
    release?.authorizationId !== AUTHORIZATION_ID
    || publication.releaseState == null
    || release.privateKeyPath !== publication.publisherPrivateKeyPath
    || !path.isAbsolute(release.boundary)
    || !path.isAbsolute(publication.rootPrivateKeyPath)
    || !path.isAbsolute(publication.publisherPrivateKeyPath)
  ) {
    throw new Error('release and publication private-material state differs');
  }
  const boundary = await realpath(release.boundary);
  const temporaryRoot = await realpath(os.tmpdir());
  if (
    path.dirname(boundary) !== temporaryRoot
    || !path.basename(boundary).startsWith(
      'agentmesh360-release-provenance-e1-',
    )
  ) {
    throw new Error('release boundary is outside the approved E1 namespace');
  }
  for (const target of [
    publication.rootPrivateKeyPath,
    publication.publisherPrivateKeyPath,
  ]) {
    if (
      path.extname(target) !== '.pk8'
      || !path.resolve(target).startsWith(`${boundary}${path.sep}`)
    ) {
      throw new Error('private material escapes the approved E1 boundary');
    }
  }
  return boundary;
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
    throw new Error('isolated E1 signer destroy failed');
  }
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new Error('isolated E1 signer returned invalid destroy evidence');
  }
  if (response.destroyed !== true) {
    throw new Error('isolated E1 signer did not destroy private material');
  }
  return response;
}

function registryProbeConfig(hostname, ipAddress) {
  if (
    !/^packages-e1-[0-9a-f]{8}\.agentmesh360\.com$/u.test(hostname)
    || !/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(ipAddress)
  ) {
    throw new Error('registry withdrawal probe boundary is invalid');
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

function registryIsWithdrawn(hostname, ipAddress, curlSpawn = spawnSync) {
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

async function writeState(outputState, state, flag = 'w') {
  await writeFile(outputState, JSON.stringify(state), {
    mode: 0o600,
    flag,
  });
  await chmod(outputState, 0o600);
}

async function cleanup(options) {
  await assertExecutorBoundary(options.executorCommit);
  const credentials = await readCredentialFile(options.credentials);
  const origin = await readMode0600Json(options.originState, 'origin state');
  const publication = await readMode0600Json(
    options.publicationState,
    'publication state',
  );
  const release = await readMode0600Json(
    options.releaseState,
    'Release Set state',
  );
  const fault = await readMode0600Json(
    options.faultReceipt,
    'fault-matrix receipt',
  );
  const inventory = strictInventory(publication);
  if (publication.releaseState !== options.releaseState) {
    throw new Error('publication state points to a different Release Set');
  }
  const boundary = await strictReleaseBoundary(release, publication);
  if (
    origin.authorizationId !== AUTHORIZATION_ID
    || origin.origin?.deployed !== true
    || fault.authorizationId !== AUTHORIZATION_ID
    || fault.executionStatus !== 'fault_matrix_passed'
    || fault.scenarioCount !== EXPECTED_SCENARIOS
    || fault.results?.length !== EXPECTED_SCENARIOS
    || fault.results.some((result) => result.status !== 'passed')
  ) {
    throw new Error('cleanup prerequisite state differs from approved P4 E1');
  }
  let existingState;
  try {
    existingState = await readMode0600Json(
      options.outputState,
      'existing cleanup state',
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (
    existingState != null
    && (
      existingState.authorizationId !== AUTHORIZATION_ID
      || existingState.executorCommit !== options.executorCommit
      || existingState.executionStatus
        === 'objects_and_private_material_destroyed'
    )
  ) {
    throw new Error('existing cleanup state cannot be resumed');
  }
  const startedAt =
    existingState?.startedAt ?? new Date().toISOString();
  const state = {
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    environment: 'e1',
    workPackage: 'p4_r3',
    executorCommit: options.executorCommit,
    executionStatus: 'withdrawing',
    registryWithdrawnFirst: false,
    deletedObjectCount: 0,
    verifiedAbsentObjectCount: 0,
    rootPrivateMaterialDestroyed: false,
    publisherPrivateMaterialDestroyed: false,
    releaseBoundaryRemoved: false,
    providerRequests: 0,
    creditsConsumed: 0,
    startedAt,
    lastUpdatedAt: startedAt,
  };
  await writeState(
    options.outputState,
    state,
    existingState == null ? 'wx' : 'w',
  );

  const registry = inventory.at(-1);
  await deleteAndVerify(credentials, registry);
  if (!registryIsWithdrawn(
    origin.dns.hostname,
    origin.droplet.publicIpv4,
  )) {
    throw new Error('Registry was deleted but public withdrawal is not visible');
  }
  state.registryWithdrawnFirst = true;
  state.deletedObjectCount = 1;
  state.verifiedAbsentObjectCount = 1;
  state.executionStatus = 'deleting_objects';
  state.lastUpdatedAt = new Date().toISOString();
  await writeState(options.outputState, state);

  for (const item of inventory.slice(0, -1).reverse()) {
    await deleteAndVerify(credentials, item);
    state.deletedObjectCount += 1;
    state.verifiedAbsentObjectCount += 1;
    state.lastUpdatedAt = new Date().toISOString();
    await writeState(options.outputState, state);
  }

  const rootResult = invokeSigner(
    boundary,
    publication.rootPrivateKeyPath,
  );
  state.rootPrivateMaterialDestroyed = rootResult.destroyed === true;
  state.lastUpdatedAt = new Date().toISOString();
  await writeState(options.outputState, state);

  const publisherResult = invokeSigner(
    boundary,
    publication.publisherPrivateKeyPath,
  );
  state.publisherPrivateMaterialDestroyed =
    publisherResult.destroyed === true;
  state.lastUpdatedAt = new Date().toISOString();
  await writeState(options.outputState, state);

  await rm(boundary, { recursive: true, force: false });
  state.releaseBoundaryRemoved = true;
  state.executionStatus = 'objects_and_private_material_destroyed';
  state.completedAt = new Date().toISOString();
  state.lastUpdatedAt = state.completedAt;
  await writeState(options.outputState, state);
  return state;
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
    '--credentials',
    '--executor-commit',
    '--fault-receipt',
    '--origin-state',
    '--output-state',
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
      'usage: cleanup-release-set.mjs --executor-commit <commit> '
      + '--credentials <absolute> --origin-state <absolute> '
      + '--publication-state <absolute> --release-state <absolute> '
      + '--fault-receipt <absolute> --output-state <absolute>',
    );
  }
  return {
    credentials: values.get('--credentials'),
    executorCommit: values.get('--executor-commit'),
    faultReceipt: values.get('--fault-receipt'),
    originState: values.get('--origin-state'),
    outputState: values.get('--output-state'),
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
    cleanup(options)
      .then(() => {
        console.log(
          'E1 Registry withdrawn first; 35 objects and ephemeral signing material destroyed',
        );
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}

export {
  parseArguments,
  registryIsWithdrawn,
  registryProbeConfig,
  strictInventory,
};
