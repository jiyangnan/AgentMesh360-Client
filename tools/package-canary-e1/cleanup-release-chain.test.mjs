import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  OUTPUT_STATE_PATH,
  REGISTRY_OBJECT_KEY,
  parseArguments,
  registryIsWithdrawn,
  registryProbeConfig,
  safeObjectKey,
  strictInventory,
} from './cleanup-release-chain.mjs';

const COMMIT = 'a'.repeat(40);
const AUTHORIZATION_ID = 'package_canary_e1_20260729_0002';

function publication() {
  const plannedObjects = Array.from({ length: 24 }, (_, index) => ({
    bucketClass: index % 3 === 0 ? 'metadata' : 'release',
    objectKey: `objects/object-${index}.json`,
    sha256: `sha256:${index.toString(16).padStart(64, '0')}`,
  }));
  plannedObjects.at(-1).bucketClass = 'metadata';
  plannedObjects.at(-1).objectKey = REGISTRY_OBJECT_KEY;
  return {
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    executionStatus: 'published',
    registryPublishedLast: true,
    cleanupRequired: true,
    plannedObjects,
    objectReceipts: structuredClone(plannedObjects),
  };
}

test('accepts only a complete unique Registry-last inventory', () => {
  const inventory = strictInventory(publication());
  assert.equal(inventory.length, 24);
  assert.equal(inventory.at(-1).objectKey, REGISTRY_OBJECT_KEY);
  const missing = publication();
  missing.objectReceipts.pop();
  assert.throws(() => strictInventory(missing));
  const traversal = publication();
  traversal.plannedObjects[0].objectKey = '../escape';
  traversal.objectReceipts[0].objectKey = '../escape';
  assert.throws(() => strictInventory(traversal));
  const duplicate = publication();
  duplicate.plannedObjects[1] = structuredClone(duplicate.plannedObjects[0]);
  duplicate.objectReceipts[1] = structuredClone(duplicate.objectReceipts[0]);
  assert.throws(() => strictInventory(duplicate));
});

test('validates safe object keys without accepting path escapes', () => {
  assert.equal(safeObjectKey('metadata/registry.v2.json'), true);
  assert.equal(safeObjectKey('releases/job/0.4.7/artifact.tar.zst'), true);
  assert.equal(safeObjectKey('/absolute'), false);
  assert.equal(safeObjectKey('../escape'), false);
  assert.equal(safeObjectKey('a//b'), false);
  assert.equal(safeObjectKey('a\\b'), false);
});

test('Registry withdrawal probe is direct HTTPS, fixed-host, and no-redirect', () => {
  const config = registryProbeConfig(
    'packages-e1-1234abcd.agentmesh360.com',
    '203.0.113.10',
  );
  assert.match(config, /proto = "=https"/u);
  assert.match(config, /max-redirs = 0/u);
  assert.match(config, /noproxy = "\*"/u);
  assert.match(config, /resolve = "/u);
  assert.throws(() => registryProbeConfig(
    'packages.agentmesh360.com',
    '203.0.113.10',
  ));
});

test('accepts only an exact public Registry 404 response', () => {
  const hostname = 'packages-e1-1234abcd.agentmesh360.com';
  const ipAddress = '203.0.113.10';
  assert.equal(registryIsWithdrawn(
    hostname,
    ipAddress,
    () => ({
      status: 0,
      stdout: 'HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\n\r\n',
    }),
  ), true);
  assert.equal(registryIsWithdrawn(
    hostname,
    ipAddress,
    () => ({
      status: 0,
      stdout: 'HTTP/1.1 200 OK\r\n\r\n',
    }),
  ), false);
});

test('pins the cleanup state and executor-only CLI', () => {
  assert.equal(
    OUTPUT_STATE_PATH,
    '/private/tmp/agentmesh360-p5-e1-release-cleanup-state.json',
  );
  assert.deepEqual(
    parseArguments(['--executor-commit', COMMIT]),
    { executorCommit: COMMIT },
  );
  assert.throws(() => parseArguments([COMMIT]));
  assert.throws(() => parseArguments([
    '--executor-commit',
    COMMIT,
    '--credentials',
    '/tmp/other',
  ]));
});

test('source enforces Registry-first, two Roots, two Publishers, and staged follow-up', async () => {
  const source = await readFile(
    new URL('./cleanup-release-chain.mjs', import.meta.url),
    'utf8',
  );
  const registryDelete = source.indexOf(
    'await deleteAndVerify(credentials, registry)',
  );
  const remainingDelete = source.indexOf(
    'for (const item of inventory.slice(0, -1).reverse())',
  );
  assert.ok(registryDelete > 0);
  assert.ok(remainingDelete > registryDelete);
  assert.match(source, /rootPrivateMaterialDestroyedCount/u);
  assert.match(source, /publisherPrivateMaterialDestroyedCount/u);
  assert.match(source, /remove_cloudflare_dns/u);
  assert.match(source, /delete_spaces_buckets_and_revoke_keys/u);
  assert.match(source, /assertCleanupAuthority/u);
  assert.match(source, /CLEANUP_AUTHORITY_FILES/u);
  assert.match(source, /infrastructure-boundary\.mjs/u);
  assert.match(source, /publish-release-chain\.mjs/u);
  assert.match(source, /run-scenario-matrix\.mjs/u);
  assert.doesNotMatch(source, /assertP5ExecutionAuthority/u);
  assert.doesNotMatch(
    source,
    /GEMINI_API_KEY|api\.cloudflare\.com|droplet create/u,
  );
});
