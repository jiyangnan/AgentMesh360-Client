#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  readFile,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  AUTHORIZATION_ID,
  assertP5ExecutionAuthority,
} from './infrastructure-boundary.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const BOUNDARY = '/private/tmp/agentmesh360-p5-e1-client';
const STATE_HOME = path.join(BOUNDARY, 'state');
const USER_DATA_HOME = path.join(BOUNDARY, 'user-data');
const SOURCE = path.join(BOUNDARY, 'source');
const BUILD = path.join(BOUNDARY, 'build');
const HOST_BINARY = path.join(BUILD, 'debug/xai-grok-pager');
const MARKER_PATH = path.join(BOUNDARY, 'canary-boundary.json');
const NEXT_MARKER_PATH = path.join(BOUNDARY, 'canary-boundary.next.json');
const OUTPUT_RECEIPT_PATH =
  '/private/tmp/agentmesh360-p5-e1-client-advance.json';

function run(command, args, label, {
  cwd = REPOSITORY_ROOT,
  env = process.env,
  timeout = 30_000,
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed`);
  }
  return result.stdout.trim();
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
    throw new Error(`${label} is not a fixed mode-0700 directory`);
  }
}

async function assertFixedDirectory(directory, label, expectedMode) {
  const direct = await lstat(directory);
  const resolved = await realpath(directory);
  if (
    !direct.isDirectory()
    || direct.isSymbolicLink()
    || (direct.mode & 0o777) !== expectedMode
    || resolved !== directory
    || !resolved.startsWith(`${BOUNDARY}/`)
  ) {
    throw new Error(`${label} is not a fixed retained directory`);
  }
}

async function readMarker() {
  const info = await lstat(MARKER_PATH);
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || (info.mode & 0o777) !== 0o600
    || info.size <= 0
    || info.size > 4096
  ) {
    throw new Error('P5 retained client marker is invalid');
  }
  try {
    return JSON.parse(await readFile(MARKER_PATH, 'utf8'));
  } catch {
    throw new Error('P5 retained client marker is invalid JSON');
  }
}

function validateMarkerTransition(marker, executorCommit, isAncestor) {
  if (
    marker?.schemaVersion !== 2
    || marker.authorizationId !== AUTHORIZATION_ID
    || marker.boundaryId !== 'p5-e1-isolated-client-02'
    || marker.productionAuthorityGranted !== false
    || marker.normalStateReadable !== false
    || marker.keychainWritePerformed !== false
    || marker.networkRequestPerformed !== false
    || marker.packageMutationPerformed !== false
    || !/^[0-9a-f]{40}$/u.test(marker.executorCommit || '')
    || !/^[0-9a-f]{40}$/u.test(executorCommit || '')
    || marker.executorCommit === executorCommit
    || isAncestor(marker.executorCommit, executorCommit) !== true
  ) {
    throw new Error('P5 retained client marker cannot advance to this executor');
  }
  return {
    ...marker,
    previousExecutorCommit: marker.executorCommit,
    executorCommit,
  };
}

function assertSourceWorktree() {
  const common = run(
    'git',
    ['rev-parse', '--git-common-dir'],
    'retained source common-dir inspection',
    { cwd: SOURCE },
  );
  const expected = run(
    'git',
    ['rev-parse', '--git-common-dir'],
    'executor common-dir inspection',
  );
  if (
    path.resolve(SOURCE, common) !== path.resolve(REPOSITORY_ROOT, expected)
    || run(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      'retained source clean-tree inspection',
      { cwd: SOURCE },
    ) !== ''
  ) {
    throw new Error('P5 retained client source is not a clean shared worktree');
  }
}

function buildHost(executorCommit) {
  run(
    'cargo',
    [
      'build',
      '--manifest-path',
      'crates/codegen/xai-grok-pager-bin/Cargo.toml',
      '--bin',
      'xai-grok-pager',
    ],
    'retained P5 Host build',
    {
      cwd: SOURCE,
      env: {
        ...process.env,
        CARGO_TARGET_DIR: BUILD,
      },
      timeout: 30 * 60 * 1000,
    },
  );
  const version = run(
    HOST_BINARY,
    ['--version'],
    'retained P5 Host version inspection',
    { cwd: SOURCE },
  );
  if (!version.includes(`(${executorCommit.slice(0, 7)})`)) {
    throw new Error('retained P5 Host does not match the executor commit');
  }
  return version.replace(/\s+/gu, ' ').slice(0, 160);
}

async function assertAbsent(filePath, label) {
  try {
    await lstat(filePath);
    throw new Error(`${label} already exists`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function advanceIsolatedClient(executorCommit) {
  await assertP5ExecutionAuthority(executorCommit);
  await Promise.all([
    assertPrivateDirectory(BOUNDARY, 'P5 retained client boundary'),
    assertPrivateDirectory(STATE_HOME, 'P5 retained client state'),
    assertPrivateDirectory(USER_DATA_HOME, 'P5 retained client userData'),
    assertFixedDirectory(SOURCE, 'P5 retained client source', 0o755),
    assertFixedDirectory(BUILD, 'P5 retained client build', 0o755),
    assertAbsent(NEXT_MARKER_PATH, 'P5 next marker'),
    assertAbsent(OUTPUT_RECEIPT_PATH, 'P5 client advance receipt'),
  ]);
  assertSourceWorktree();
  const marker = await readMarker();
  const next = validateMarkerTransition(
    marker,
    executorCommit,
    (oldCommit, newCommit) => (
      run(
        'git',
        ['merge-base', '--is-ancestor', oldCommit, newCommit],
        'retained marker ancestry inspection',
      ) === ''
    ),
  );
  run(
    'git',
    ['checkout', '--detach', executorCommit],
    'retained source advance',
    { cwd: SOURCE, timeout: 120_000 },
  );
  if (
    run(
      'git',
      ['rev-parse', 'HEAD'],
      'retained source commit inspection',
      { cwd: SOURCE },
    ) !== executorCommit
    || run(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      'retained source post-advance inspection',
      { cwd: SOURCE },
    ) !== ''
  ) {
    throw new Error('P5 retained source did not advance cleanly');
  }
  const hostVersion = buildHost(executorCommit);
  const advancedAt = new Date().toISOString();
  await writeFile(
    NEXT_MARKER_PATH,
    `${JSON.stringify({ ...next, advancedAt }, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  await chmod(NEXT_MARKER_PATH, 0o600);
  await rename(NEXT_MARKER_PATH, MARKER_PATH);
  await chmod(MARKER_PATH, 0o600);
  const receipt = {
    schemaVersion: 1,
    receiptId: 'package_canary_e1_retained_client_advance_20260729_0001',
    authorizationId: AUTHORIZATION_ID,
    executionStatus: 'retained_client_advanced',
    previousExecutorCommit: marker.executorCommit,
    executorCommit,
    hostVersion,
    statePreserved: true,
    userDataPreserved: true,
    encryptedRefreshTokenRead: false,
    providerCredentialRead: false,
    providerInferenceOperationsAdded: 0,
    agentMeshCreditsUsed: 0,
    packageMutationsPerformed: 0,
    productionAuthorityGranted: false,
    completedAt: advancedAt,
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
      'usage: advance-isolated-client.mjs --executor-commit <commit>',
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
    advanceIsolatedClient(options.executorCommit)
      .then(() => {
        process.stdout.write(
          'P5 retained client source, Host, and marker advanced without reading credentials\n',
        );
      })
      .catch(() => {
        process.stderr.write('P5 retained client advance failed\n');
        process.exitCode = 1;
      });
  }
}

export {
  BOUNDARY,
  BUILD,
  MARKER_PATH,
  OUTPUT_RECEIPT_PATH,
  SOURCE,
  advanceIsolatedClient,
  parseArguments,
  validateMarkerTransition,
};
