import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseArguments,
  strictTempInventory,
} from './finalize-local-cleanup.mjs';

const EXPECTED = [
  'agentmesh360-distribution-e1-cleanup-state.json',
  'agentmesh360-distribution-e1-current',
  'agentmesh360-distribution-e1-fault-matrix.json',
  'agentmesh360-distribution-e1-publication-state.json',
  'agentmesh360-distribution-e1-release-set-state.json',
  'agentmesh360-distribution-e1-replacement',
  'agentmesh360-p4-e1-spaces-current.json',
];

test('requires the exact seven-entry local E1 cleanup inventory', () => {
  assert.deepEqual(strictTempInventory(EXPECTED), EXPECTED);
  assert.throws(() => strictTempInventory(EXPECTED.slice(1)));
  assert.throws(() => strictTempInventory([
    ...EXPECTED,
    'agentmesh360-distribution-e1-unreviewed',
  ]));
  const replaced = [...EXPECTED];
  replaced[0] = 'agentmesh360-distribution-e1-other.json';
  assert.throws(() => strictTempInventory(replaced));
});

test('pins the approved cleanup root to private tmp, not process TMPDIR', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) =>
    readFile(
      new URL('./finalize-local-cleanup.mjs', import.meta.url),
      'utf8',
    ));
  assert.match(source, /const APPROVED_TEMP_ROOT = '\/private\/tmp';/u);
  assert.doesNotMatch(source, /os\.tmpdir/u);
});

test('parses only a frozen executor and eight absolute finalizer boundaries', () => {
  const parsed = parseArguments([
    '--active-boundary',
    '/private/tmp/agentmesh360-distribution-e1-replacement',
    '--cloud-evidence',
    '/repo/cloud.json',
    '--credentials',
    '/private/tmp/credentials.json',
    '--executor-commit',
    'a'.repeat(40),
    '--fault-receipt',
    '/private/tmp/fault.json',
    '--object-cleanup-state',
    '/private/tmp/cleanup.json',
    '--old-boundary',
    '/private/tmp/agentmesh360-distribution-e1-current',
    '--publication-state',
    '/private/tmp/publication.json',
    '--release-state',
    '/private/tmp/release.json',
  ]);
  assert.equal(parsed.executorCommit, 'a'.repeat(40));
  assert.throws(() => parseArguments([
    '--active-boundary',
    'relative',
  ]));
});
