import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseArguments,
  releaseOriginFromState,
} from './build-release-set.mjs';

const COMMIT = 'a'.repeat(40);

test('parses only the complete absolute E1 Release Set boundary', () => {
  const parsed = parseArguments([
    '--executor-commit',
    COMMIT,
    '--origin-state',
    '/private/tmp/origin.json',
    '--output-state',
    '/private/tmp/release.json',
    '--deploy-source',
    '/tmp/deploy',
    '--job-source',
    '/tmp/job',
    '--lecturecast-source',
    '/tmp/lecturecast',
  ]);
  assert.equal(parsed.executorCommit, COMMIT);
  assert.throws(() => parseArguments([
    '--executor-commit',
    COMMIT,
    '--origin-state',
    'relative',
  ]));
});

test('accepts only a deployed DNS-only E1 HTTPS origin', () => {
  const state = {
    authorizationId: 'distribution_service_e1_20260728_0001',
    dns: {
      hostname: 'packages-e1-1234abcd.agentmesh360.com',
      proxied: false,
    },
    origin: {
      deployed: true,
      executorCommit: COMMIT,
      tls: 'caddy_managed_lets_encrypt',
    },
  };
  assert.equal(
    releaseOriginFromState(state),
    'https://packages-e1-1234abcd.agentmesh360.com',
  );
  for (const mutate of [
    (value) => {
      value.origin.deployed = false;
    },
    (value) => {
      value.dns.proxied = true;
    },
    (value) => {
      value.dns.hostname = 'packages.agentmesh360.com';
    },
  ]) {
    const value = structuredClone(state);
    mutate(value);
    assert.throws(() => releaseOriginFromState(value));
  }
});
