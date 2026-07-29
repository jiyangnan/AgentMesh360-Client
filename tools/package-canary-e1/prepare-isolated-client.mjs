#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  validatePackageCanaryAuthorizationFile,
} from './validate-package-canary-authorization.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const APPROVED_TEMP_ROOT = '/private/tmp';
const BOUNDARY_NAME = 'agentmesh360-p5-e1-client';
const BASELINE_PATH = path.join(
  REPOSITORY_ROOT,
  'docs/operations/tabletops/2026-07-29-p5-owner-account-local-baseline.json',
);
const CURRENT_AUTHORIZATION_ID = 'package_canary_e1_20260729_0002';
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

function typedSha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error('isolated client repository check failed');
  }
  return result.stdout.trim();
}

function localRepositoryState() {
  return {
    head: runGit(['rev-parse', 'HEAD']),
    originMain: runGit(['rev-parse', 'origin/main']),
    clean: runGit(['status', '--porcelain']) === '',
  };
}

async function strictJson(filePath, label) {
  const info = await lstat(filePath);
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || info.size <= 0
    || info.size > 256 * 1024
  ) {
    throw new Error(`${label} is invalid`);
  }
  const bytes = await readFile(filePath);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} cannot be read`);
  }
  return { bytes, value };
}

async function makePrivateDirectory(directory) {
  await mkdir(directory, { mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || (info.mode & 0o077) !== 0
  ) {
    throw new Error('isolated client directory is not private');
  }
}

export async function prepareIsolatedClient({
  authorizationPath,
  baselinePath = BASELINE_PATH,
  expectedExecutorCommit,
  repositoryProbe = localRepositoryState,
  approvedTempRoot = APPROVED_TEMP_ROOT,
  boundaryName = BOUNDARY_NAME,
} = {}) {
  const authorizationErrors =
    await validatePackageCanaryAuthorizationFile(authorizationPath);
  if (authorizationErrors.length > 0) {
    throw new Error('P5 E1 authorization is invalid');
  }
  const authorizationRecord = await strictJson(
    authorizationPath,
    'P5 E1 authorization',
  );
  const baselineRecord = await strictJson(
    baselinePath,
    'P5 local baseline',
  );
  const authorization = authorizationRecord.value;
  const baseline = baselineRecord.value;
  if (
    authorization.schemaVersion !== 2
    || authorization.authorizationId !== CURRENT_AUTHORIZATION_ID
    || authorization.authorizationHistory?.priorAuthorizationReusable !== false
    || baseline.authorizationId !== authorization.authorizationId
    || baseline.authorizationSha256 !== typedSha256(authorizationRecord.bytes)
    || baseline.gate?.localBaselinePassed !== true
    || baseline.gate?.cloudAssemblyAllowed !== false
    || baseline.execution?.externalNetworkRequestsUsed !== 0
    || baseline.execution?.keychainWritesPerformed !== 0
    || baseline.execution?.packageMutationsPerformed !== 0
    || baseline.normalState?.unchangedDuringCapture !== true
  ) {
    throw new Error('P5 local baseline does not authorize isolated assembly');
  }

  const repository = repositoryProbe();
  if (
    !COMMIT_PATTERN.test(repository.head || '')
    || repository.head !== repository.originMain
    || repository.head !== expectedExecutorCommit
    || repository.clean !== true
  ) {
    throw new Error('isolated client executor is not the frozen pushed commit');
  }
  const canonicalRoot = await realpath(approvedTempRoot);
  if (canonicalRoot !== approvedTempRoot) {
    throw new Error('isolated client temp root is not canonical');
  }
  const boundary = path.join(approvedTempRoot, boundaryName);
  if (path.dirname(boundary) !== approvedTempRoot) {
    throw new Error('isolated client boundary escaped the approved root');
  }
  try {
    await lstat(boundary);
    throw new Error('isolated client boundary already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await makePrivateDirectory(boundary);
  try {
    await makePrivateDirectory(path.join(boundary, 'state'));
    await makePrivateDirectory(path.join(boundary, 'user-data'));
    const marker = {
      schemaVersion: 2,
      authorizationId: authorization.authorizationId,
      boundaryId: 'p5-e1-isolated-client-02',
      executorCommit: repository.head,
      productionAuthorityGranted: false,
      normalStateReadable: false,
      keychainWritePerformed: false,
      networkRequestPerformed: false,
      packageMutationPerformed: false,
    };
    const markerPath = path.join(boundary, 'canary-boundary.json');
    const handle = await open(markerPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return Object.freeze({
      boundaryId: marker.boundaryId,
      executorCommit: repository.head,
      productionAuthorityGranted: false,
      networkRequestPerformed: false,
      keychainWritePerformed: false,
      packageMutationPerformed: false,
    });
  } catch (error) {
    await rm(boundary, { recursive: true, force: true }).catch(() => {});
    throw new Error(`isolated client assembly stopped: ${error.message}`);
  }
}

function usage() {
  process.stderr.write(
    'usage: node prepare-isolated-client.mjs '
      + '<authorization.json> <baseline.json> <executor-commit>\n',
  );
}

async function main() {
  const [
    authorizationPath,
    baselinePath,
    expectedExecutorCommit,
  ] = process.argv.slice(2);
  if (!authorizationPath || !baselinePath || !expectedExecutorCommit) {
    usage();
    process.exitCode = 2;
    return;
  }
  try {
    await prepareIsolatedClient({
      authorizationPath: path.resolve(authorizationPath),
      baselinePath: path.resolve(baselinePath),
      expectedExecutorCommit,
    });
    process.stdout.write('isolated P5 client boundary prepared\n');
  } catch (error) {
    process.stderr.write(`isolated P5 client blocked: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
