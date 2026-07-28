import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
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

test('prepares one private isolated client boundary without side effects', async () => {
  await withTempDirectory(async (directory) => {
    const canonicalDirectory = await realpath(directory);
    const result = await prepareIsolatedClient({
      authorizationPath: AUTHORIZATION,
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
      boundaryId: 'p5-e1-isolated-client-01',
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
  });
});

test('refuses an existing or symlinked boundary', async () => {
  await withTempDirectory(async (directory) => {
    const canonicalDirectory = await realpath(directory);
    const common = {
      authorizationPath: AUTHORIZATION,
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
    const target = path.join(canonicalDirectory, 'target');
    const boundary = path.join(canonicalDirectory, 'boundary');
    await symlink(target, boundary);
    await assert.rejects(
      prepareIsolatedClient({
        authorizationPath: AUTHORIZATION,
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
    for (const repository of [
      { head: EXECUTOR, originMain: '4'.repeat(40), clean: true },
      { head: EXECUTOR, originMain: EXECUTOR, clean: false },
      { head: '5'.repeat(40), originMain: '5'.repeat(40), clean: true },
    ]) {
      await assert.rejects(
        prepareIsolatedClient({
          authorizationPath: AUTHORIZATION,
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

test('assembler has no network, Keychain, Provider, or secret capability', () => {
  const source = readFileSync(SOURCE, 'utf8');
  assert.doesNotMatch(
    source,
    /node:(?:http|https|net|tls)|\bfetch\s*\(|\bcurl\b|\bsecurity\b|\bdoctl\b/u,
  );
  assert.doesNotMatch(source, /GEMINI_API_KEY|apiKey|credential/i);
});
