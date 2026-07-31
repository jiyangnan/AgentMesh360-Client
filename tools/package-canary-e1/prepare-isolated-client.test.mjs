import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { prepareIsolatedClient } from './prepare-isolated-client.mjs';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(TEST_DIRECTORY, 'prepare-isolated-client.mjs');
const AUTHORIZATION = path.resolve(
  TEST_DIRECTORY,
  '../../docs/operations/tabletops/2026-07-29-p5-owner-account-e1-authorization.json',
);
const ABORTED_AUTHORIZATION = path.resolve(
  TEST_DIRECTORY,
  '../../docs/operations/tabletops/2026-07-29-p5-package-canary-e1-authorization.json',
);
const EXECUTOR = '3'.repeat(40);

async function withTempDirectory(run) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'agentmesh360-p5-client-test-'),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeBaseline(directory, authorizationPath = AUTHORIZATION) {
  const authorizationBytes = readFileSync(authorizationPath);
  const authorization = JSON.parse(authorizationBytes);
  const baselinePath = path.join(directory, 'baseline.json');
  await writeFile(
    baselinePath,
    JSON.stringify({
      authorizationId: authorization.authorizationId,
      authorizationSha256: `sha256:${createHash('sha256')
        .update(authorizationBytes)
        .digest('hex')}`,
      gate: {
        localBaselinePassed: true,
        cloudAssemblyAllowed: false,
      },
      execution: {
        externalNetworkRequestsUsed: 0,
        keychainWritesPerformed: 0,
        packageMutationsPerformed: 0,
      },
      normalState: {
        unchangedDuringCapture: true,
      },
    }),
  );
  return baselinePath;
}

test('prepares one private isolated client boundary without side effects', async () => {
  await withTempDirectory(async (directory) => {
    const canonicalDirectory = await realpath(directory);
    const baselinePath = await writeBaseline(directory);
    const result = await prepareIsolatedClient({
      authorizationPath: AUTHORIZATION,
      baselinePath,
      expectedExecutorCommit: EXECUTOR,
      repositoryProbe: () => ({
        head: EXECUTOR,
        originMain: EXECUTOR,
        clean: true,
      }),
      approvedTempRoot: canonicalDirectory,
      boundaryName: 'boundary',
    });
    assert.deepEqual(result, {
      boundaryId: 'p5-e1-isolated-client-02',
      executorCommit: EXECUTOR,
      productionAuthorityGranted: false,
      networkRequestPerformed: false,
      keychainWritePerformed: false,
      packageMutationPerformed: false,
    });
    const marker = JSON.parse(
      await readFile(path.join(canonicalDirectory, 'boundary', 'canary-boundary.json')),
    );
    assert.equal(marker.executorCommit, EXECUTOR);
    assert.equal(marker.normalStateReadable, false);
    for (const directoryName of [
      'grok-home',
      'cache',
      'config',
      'data',
      'xdg-state',
    ]) {
      const privateDirectory = await lstat(
        path.join(canonicalDirectory, 'boundary', directoryName),
      );
      assert.equal(privateDirectory.isDirectory(), true);
      assert.equal(privateDirectory.isSymbolicLink(), false);
      assert.equal(privateDirectory.mode & 0o777, 0o700);
    }
  });
});

test('refuses an existing or symlinked boundary', async () => {
  await withTempDirectory(async (directory) => {
    const canonicalDirectory = await realpath(directory);
    const baselinePath = await writeBaseline(directory);
    const common = {
      authorizationPath: AUTHORIZATION,
      baselinePath,
      expectedExecutorCommit: EXECUTOR,
      repositoryProbe: () => ({
        head: EXECUTOR,
        originMain: EXECUTOR,
        clean: true,
      }),
      approvedTempRoot: canonicalDirectory,
      boundaryName: 'boundary',
    };
    await prepareIsolatedClient(common);
    await assert.rejects(
      prepareIsolatedClient(common),
      /already exists/u,
    );
  });
  await withTempDirectory(async (directory) => {
    const canonicalDirectory = await realpath(directory);
    const baselinePath = await writeBaseline(directory);
    const target = path.join(canonicalDirectory, 'target');
    const boundary = path.join(canonicalDirectory, 'boundary');
    await symlink(target, boundary);
    await assert.rejects(
      prepareIsolatedClient({
        authorizationPath: AUTHORIZATION,
        baselinePath,
        expectedExecutorCommit: EXECUTOR,
        repositoryProbe: () => ({
          head: EXECUTOR,
          originMain: EXECUTOR,
          clean: true,
        }),
        approvedTempRoot: canonicalDirectory,
        boundaryName: 'boundary',
      }),
      /already exists/u,
    );
  });
});

test('refuses an unfrozen, dirty, or mismatched executor', async () => {
  await withTempDirectory(async (directory) => {
    const canonicalDirectory = await realpath(directory);
    const baselinePath = await writeBaseline(directory);
    for (const repository of [
      { head: EXECUTOR, originMain: '4'.repeat(40), clean: true },
      { head: EXECUTOR, originMain: EXECUTOR, clean: false },
      { head: '5'.repeat(40), originMain: '5'.repeat(40), clean: true },
    ]) {
      await assert.rejects(
        prepareIsolatedClient({
          authorizationPath: AUTHORIZATION,
          baselinePath,
          expectedExecutorCommit: EXECUTOR,
          repositoryProbe: () => repository,
          approvedTempRoot: canonicalDirectory,
          boundaryName: `boundary-${repository.head.slice(0, 1)}`,
        }),
        /frozen pushed commit/u,
      );
    }
  });
});

test('refuses the superseded and aborted v1 authorization', async () => {
  await withTempDirectory(async (directory) => {
    const canonicalDirectory = await realpath(directory);
    const baselinePath = await writeBaseline(directory, ABORTED_AUTHORIZATION);
    await assert.rejects(
      prepareIsolatedClient({
        authorizationPath: ABORTED_AUTHORIZATION,
        baselinePath,
        expectedExecutorCommit: EXECUTOR,
        repositoryProbe: () => ({
          head: EXECUTOR,
          originMain: EXECUTOR,
          clean: true,
        }),
        approvedTempRoot: canonicalDirectory,
        boundaryName: 'boundary',
      }),
      /does not authorize isolated assembly/u,
    );
  });
});

test('assembler has no network, Keychain, Provider, or secret capability', () => {
  const source = readFileSync(SOURCE, 'utf8');
  assert.doesNotMatch(
    source,
    /node:(?:http|https|net|tls)|\bfetch\s*\(|\bcurl\b|\bsecurity\b|\bdoctl\b/u,
  );
  assert.doesNotMatch(source, /GEMINI_API_KEY|apiKey|credential/i);
});
