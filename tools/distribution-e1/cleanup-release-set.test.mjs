import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseArguments,
  registryIsWithdrawn,
  registryProbeConfig,
  strictInventory,
} from './cleanup-release-set.mjs';

function inventory() {
  const plannedObjects = [];
  for (let index = 0; index < 27; index += 1) {
    plannedObjects.push({
      bucketClass: 'release',
      objectKey: `objects/release-${index}.bin`,
      sha256: `sha256:${index.toString(16).padStart(64, '0')}`,
    });
  }
  for (let index = 0; index < 7; index += 1) {
    plannedObjects.push({
      bucketClass: 'metadata',
      objectKey: `faults/scenario-${index}/registry.json`,
      sha256: `sha256:${(index + 27).toString(16).padStart(64, '0')}`,
    });
  }
  plannedObjects.push({
    bucketClass: 'metadata',
    objectKey: 'metadata/registry.v2.json',
    sha256: `sha256:${'f'.repeat(64)}`,
  });
  return {
    schemaVersion: 1,
    authorizationId: 'distribution_service_e1_20260728_0001',
    executionStatus: 'published',
    registryPublishedLast: true,
    plannedObjects,
    objectReceipts: structuredClone(plannedObjects),
  };
}

test('accepts only the complete Registry-last 35-object inventory', () => {
  assert.equal(strictInventory(inventory()).length, 35);
  for (const mutate of [
    (value) => value.plannedObjects.pop(),
    (value) => {
      value.plannedObjects.at(-1).objectKey = '../registry.json';
      value.objectReceipts.at(-1).objectKey = '../registry.json';
    },
    (value) => {
      value.objectReceipts[0].sha256 = `sha256:${'a'.repeat(64)}`;
    },
    (value) => {
      value.plannedObjects.at(-1).bucketClass = 'release';
      value.objectReceipts.at(-1).bucketClass = 'release';
    },
  ]) {
    const value = inventory();
    mutate(value);
    assert.throws(() => strictInventory(value));
  }
});

test('Registry withdrawal probe is direct, HTTPS-only, and no-redirect', () => {
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
  let invocation;
  assert.equal(registryIsWithdrawn(
    hostname,
    ipAddress,
    (command, args, options) => {
      invocation = { command, args, input: options.input };
      return {
        status: 0,
        stdout: 'HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\n\r\n',
      };
    },
  ), true);
  assert.equal(invocation.command, 'curl');
  assert.deepEqual(invocation.args, ['--config', '-']);
  assert.equal(registryIsWithdrawn(
    hostname,
    ipAddress,
    () => ({
      status: 0,
      stdout: 'HTTP/1.1 200 OK\r\n\r\n',
    }),
  ), false);
});

test('parses only the frozen executor and six absolute cleanup boundaries', () => {
  const parsed = parseArguments([
    '--credentials',
    '/private/tmp/credentials.json',
    '--executor-commit',
    'a'.repeat(40),
    '--fault-receipt',
    '/private/tmp/faults.json',
    '--origin-state',
    '/private/tmp/origin.json',
    '--output-state',
    '/private/tmp/cleanup.json',
    '--publication-state',
    '/private/tmp/publication.json',
    '--release-state',
    '/private/tmp/release.json',
  ]);
  assert.equal(parsed.executorCommit, 'a'.repeat(40));
  assert.throws(() => parseArguments([
    '--credentials',
    'relative',
  ]));
});
