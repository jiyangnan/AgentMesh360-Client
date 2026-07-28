import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertSourceRepository,
} from '../release-provenance/run-e0-release-provenance.mjs';
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

test('dirty source root is allowed only for the isolated E1 retain path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'am360-e1-source-'));
  try {
    const run = (args) => spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(run(['init', '-q']).status, 0);
    await writeFile(path.join(root, 'source.txt'), 'frozen\n');
    assert.equal(run(['add', 'source.txt']).status, 0);
    assert.equal(run([
      '-c',
      'user.name=AgentMesh360 Test',
      '-c',
      'user.email=test@invalid.local',
      'commit',
      '-q',
      '-m',
      'frozen',
    ]).status, 0);
    const commit = run(['rev-parse', 'HEAD']).stdout.trim();
    await writeFile(path.join(root, 'source.txt'), 'user work\n');
    await assert.rejects(
      assertSourceRepository(root, commit, 'source'),
      /source tree is dirty/u,
    );
    assert.equal(
      await assertSourceRepository(root, commit, 'source', true),
      await realpath(root),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
