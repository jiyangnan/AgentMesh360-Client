import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  BOUNDARY,
  BUILD,
  MARKER_PATH,
  OUTPUT_RECEIPT_PATH,
  SOURCE,
  parseArguments,
  validateMarkerTransition,
} from './advance-isolated-client.mjs';

const OLD_COMMIT = '1'.repeat(40);
const NEW_COMMIT = '2'.repeat(40);

function marker() {
  return {
    schemaVersion: 2,
    authorizationId: 'package_canary_e1_20260729_0002',
    boundaryId: 'p5-e1-isolated-client-02',
    executorCommit: OLD_COMMIT,
    productionAuthorityGranted: false,
    normalStateReadable: false,
    keychainWritePerformed: false,
    networkRequestPerformed: false,
    packageMutationPerformed: false,
  };
}

test('advances only an exact isolated marker to an approved descendant', () => {
  const next = validateMarkerTransition(
    marker(),
    NEW_COMMIT,
    (oldCommit, newCommit) => (
      oldCommit === OLD_COMMIT && newCommit === NEW_COMMIT
    ),
  );
  assert.equal(next.previousExecutorCommit, OLD_COMMIT);
  assert.equal(next.executorCommit, NEW_COMMIT);
  assert.throws(() => validateMarkerTransition(
    marker(),
    NEW_COMMIT,
    () => false,
  ));
  const expanded = marker();
  expanded.productionAuthorityGranted = true;
  assert.throws(() => validateMarkerTransition(
    expanded,
    NEW_COMMIT,
    () => true,
  ));
});

test('pins retained source, build, marker, and receipt paths', () => {
  assert.equal(BOUNDARY, '/private/tmp/agentmesh360-p5-e1-client');
  assert.equal(SOURCE, `${BOUNDARY}/source`);
  assert.equal(BUILD, `${BOUNDARY}/build`);
  assert.equal(MARKER_PATH, `${BOUNDARY}/canary-boundary.json`);
  assert.equal(
    OUTPUT_RECEIPT_PATH,
    '/private/tmp/agentmesh360-p5-e1-client-advance.json',
  );
});

test('parses only a frozen executor commit', () => {
  assert.deepEqual(
    parseArguments(['--executor-commit', NEW_COMMIT]),
    { executorCommit: NEW_COMMIT },
  );
  assert.throws(() => parseArguments([NEW_COMMIT]));
  assert.throws(() => parseArguments([
    '--executor-commit',
    NEW_COMMIT,
    '--state',
    '/tmp/other',
  ]));
});

test('builds only inside the retained boundary and never reads credentials', async () => {
  const source = await readFile(
    new URL('./advance-isolated-client.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /CARGO_TARGET_DIR: BUILD/u);
  assert.match(source, /git',\s*\['checkout', '--detach'/u);
  assert.match(
    source,
    /assertFixedDirectory\(SOURCE,[\s\S]*assertFixedDirectory\(BUILD,/u,
  );
  assert.doesNotMatch(
    source,
    /safeStorage|GEMINI_API_KEY|refresh-token|security find-generic-password/u,
  );
});
