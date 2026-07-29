import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  captureLocalCanaryBaseline,
} from './capture-local-canary-baseline.mjs';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(TEST_DIRECTORY, 'capture-local-canary-baseline.mjs');
const AUTHORIZATION = path.resolve(
  TEST_DIRECTORY,
  '../../docs/operations/tabletops/2026-07-29-p5-owner-account-e1-authorization.json',
);
const REPOSITORY_ROOT = path.resolve(TEST_DIRECTORY, '../..');
const HEAD = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: REPOSITORY_ROOT,
  encoding: 'utf8',
}).stdout.trim();

async function withTempDirectory(run) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'agentmesh360-p5-baseline-test-'),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createStateDb(stateHome, setupSql = '') {
  const result = spawnSync(
    'sqlite3',
    [path.join(stateHome, 'state.db')],
    {
      input: `
        PRAGMA user_version=10;
        CREATE TABLE provider_profiles (
          profile_id TEXT, owner_account_id INTEGER
        );
        CREATE TABLE product_agents (
          owner_account_id INTEGER
        );
        CREATE TABLE model_assignments (
          owner_account_id INTEGER
        );
        CREATE TABLE agent_package_registry (
          package_id TEXT
        );
        CREATE TABLE package_trust_cache (
          singleton_id INTEGER
        );
        CREATE TABLE package_registry_fetch_state (
          singleton_id INTEGER
        );
        ${setupSql}
      `,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
}

function outputPath(name) {
  return path.join('/private/tmp', `agentmesh360-p5-${name}-${process.pid}.json`);
}

async function captureFixture({
  directory,
  name,
  environment = { GEMINI_API_KEY: 'test-key-12345678' },
  keychainProbe = () => false,
  now = new Date('2026-07-29T00:00:00Z'),
} = {}) {
  const stateHome = path.join(directory, 'state');
  await mkdir(stateHome, { mode: 0o700 });
  createStateDb(stateHome);
  const output = outputPath(name);
  await rm(output, { force: true });
  try {
    const receipt = await captureLocalCanaryBaseline({
      authorizationPath: AUTHORIZATION,
      outputPath: output,
      stateHome,
      now,
      environment,
      expectedExecutorCommit: HEAD,
      keychainProbe,
      repositoryProbe: () => ({
        head: HEAD,
        originMain: HEAD,
        clean: true,
      }),
    });
    return { output, receipt };
  } catch (error) {
    await rm(output, { force: true });
    throw error;
  }
}

test('captures only retention-safe local baseline signals', async () => {
  await withTempDirectory(async (directory) => {
    const { output, receipt } = await captureFixture({
      directory,
      name: 'safe',
    });
    try {
      assert.equal(receipt.gate.localBaselinePassed, true);
      assert.equal(receipt.gate.cloudAssemblyAllowed, false);
      assert.equal(
        receipt.baselineId,
        'package_canary_e1_local_baseline_20260729_0002',
      );
      assert.equal(
        receipt.authorizationId,
        'package_canary_e1_20260729_0002',
      );
      assert.equal(receipt.provider.savedSourceCredentialPresent, true);
      assert.equal(receipt.provider.inferenceRequestsUsed, 0);
      assert.equal(receipt.normalState.packageRegistryCount, 0);
      assert.equal(receipt.normalState.unchangedDuringCapture, true);
      assert.equal(statSync(output).mode & 0o777, 0o600);
      const document = await readFile(output, 'utf8');
      assert.doesNotMatch(document, /test-key|GEMINI_API_KEY|\/Users\/|\/private\/tmp/u);
    } finally {
      await rm(output, { force: true });
    }
  });
});

test('blocks missing saved credential or preexisting product Keychain item', async () => {
  await withTempDirectory(async (directory) => {
    await assert.rejects(
      captureFixture({
        directory,
        name: 'missing-key',
        environment: {},
      }),
      /saved Provider credential is unavailable/u,
    );
  });
  await withTempDirectory(async (directory) => {
    await assert.rejects(
      captureFixture({
        directory,
        name: 'occupied-keychain',
        keychainProbe: () => true,
      }),
      /product Keychain is not empty/u,
    );
  });
});

test('blocks outside the exact authorization window', async () => {
  await withTempDirectory(async (directory) => {
    await assert.rejects(
      captureFixture({
        directory,
        name: 'expired',
        now: new Date('2026-07-31T17:48:33Z'),
      }),
      /authorization window is not active/u,
    );
  });
});

test('blocks symbolic-link normal state without reading it', async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, 'target');
    const stateHome = path.join(directory, 'state');
    await mkdir(target, { mode: 0o700 });
    createStateDb(target);
    await symlink(target, stateHome);
    const output = outputPath('symlink-state');
    await rm(output, { force: true });
    await assert.rejects(
      captureLocalCanaryBaseline({
        authorizationPath: AUTHORIZATION,
        outputPath: output,
        stateHome,
        now: new Date('2026-07-29T00:00:00Z'),
        environment: { GEMINI_API_KEY: 'test-key-12345678' },
        expectedExecutorCommit: HEAD,
        keychainProbe: () => false,
        repositoryProbe: () => ({
          head: HEAD,
          originMain: HEAD,
          clean: true,
        }),
      }),
      /state home is invalid/u,
    );
  });
});

test('source never prints, hashes, persists, or passes the Provider secret', () => {
  const source = readFileSync(SOURCE, 'utf8');
  assert.doesNotMatch(source, /typedSha256\s*\(\s*secret|console\.log\s*\(\s*secret/u);
  assert.doesNotMatch(source, /writeFile\s*\([^)]*secret|authorization:\s*Bearer/iu);
  assert.doesNotMatch(source, /\bfetch\s*\(|node:(?:http|https|net|tls)/u);
});
