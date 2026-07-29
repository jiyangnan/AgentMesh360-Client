import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AUTHORIZATION_ID,
  BOUNDARY,
} from './infrastructure-boundary.mjs';
import {
  EXPECTED_GENERATIONS,
  PUBLISHER_KEY_IDS,
} from './build-release-chain.mjs';
import {
  ORIGIN_STATE_PATH,
  OUTPUT_STATE_PATH,
  RELEASE_STATE_PATH,
  ROOT_KEY_IDS,
  assertPublicationExecutorAncestry,
  assertUniquePackages,
  metadataObject,
  parseArguments,
  publisherRecord,
  validateReleaseChainState,
} from './publish-release-chain.mjs';

const COMMIT = 'a'.repeat(40);

function generation(name) {
  return {
    generation: name,
    publisherKeyId: PUBLISHER_KEY_IDS[name],
    agentPlan: name === 'a' ? 'baseline-four-agent' : 'p5-job-variants',
    agentResults: EXPECTED_GENERATIONS[name].map((identity) => {
      const [agentId, version] = identity.split('@');
      return {
        agentId,
        version,
        status: 'passed',
        buildCount: 2,
        signatureVerificationCount: 2,
        outputComparisons: Array.from(
          { length: 10 },
          () => ({ byteIdentical: true }),
        ),
      };
    }),
  };
}

function states() {
  const hostname = 'packages-p5-e1-1234abcd.agentmesh360.com';
  return {
    release: {
      authorizationId: AUTHORIZATION_ID,
      executionStatus: 'release_chain_built',
      executorCommit: COMMIT,
      releaseOrigin: `https://${hostname}`,
      generations: [generation('a'), generation('b')],
      temporaryPublisherPrivateKeyCount: 2,
      temporaryRootPrivateKeyCount: 0,
      productionAuthorityGranted: false,
      cleanupRequired: true,
    },
    origin: {
      authorizationId: AUTHORIZATION_ID,
      dns: { hostname, proxied: false },
      origin: {
        deployed: true,
        executorCommit: COMMIT,
        tls: 'caddy_managed_lets_encrypt',
      },
      infrastructure: {
        dropletCount: 1,
        spacesBucketCount: 2,
      },
    },
  };
}

test('pins the fixed P5 publication paths and executor-only CLI', () => {
  assert.equal(
    ORIGIN_STATE_PATH,
    `${BOUNDARY}/origin-state.json`,
  );
  assert.equal(
    RELEASE_STATE_PATH,
    '/private/tmp/agentmesh360-p5-e1-release-chain-state.json',
  );
  assert.equal(
    OUTPUT_STATE_PATH,
    '/private/tmp/agentmesh360-p5-e1-publication-state.json',
  );
  assert.deepEqual(
    parseArguments(['--executor-commit', COMMIT]),
    { executorCommit: COMMIT },
  );
  assert.throws(() => parseArguments([]));
  assert.throws(() => parseArguments([
    '--executor-commit',
    COMMIT,
    '--output-state',
    '/tmp/other',
  ]));
});

test('binds both exact release generations to the deployed P5 origin', () => {
  const value = states();
  assert.deepEqual(
    validateReleaseChainState(value.release, value.origin, COMMIT),
    {
      a: value.release.generations[0],
      b: value.release.generations[1],
    },
  );
  for (const mutate of [
    (state) => { state.release.temporaryPublisherPrivateKeyCount = 1; },
    (state) => { state.release.generations[1].agentResults.pop(); },
    (state) => { state.origin.origin.deployed = false; },
    (state) => { state.origin.infrastructure.spacesBucketCount = 3; },
  ]) {
    const changed = structuredClone(states());
    mutate(changed);
    assert.throws(() =>
      validateReleaseChainState(changed.release, changed.origin, COMMIT));
  }
});

test('requires ordered Origin to Release to Publisher provenance', () => {
  const originCommit = 'a'.repeat(40);
  const releaseCommit = 'b'.repeat(40);
  const publicationCommit = 'c'.repeat(40);
  const pairs = [];
  assert.doesNotThrow(() => assertPublicationExecutorAncestry(
    originCommit,
    releaseCommit,
    publicationCommit,
    (ancestor, descendant) => {
      pairs.push([ancestor, descendant]);
    },
  ));
  assert.deepEqual(pairs, [
    [originCommit, releaseCommit],
    [releaseCommit, publicationCommit],
  ]);
  assert.throws(
    () => assertPublicationExecutorAncestry(
      releaseCommit,
      originCommit,
      publicationCommit,
      (ancestor, descendant) => {
        if (ancestor === releaseCommit && descendant === originCommit) {
          throw new Error('not an ancestor');
        }
      },
    ),
    /not an ancestor/u,
  );

  const value = states();
  value.origin.origin.executorCommit = originCommit;
  value.release.executorCommit = releaseCommit;
  assert.doesNotThrow(() =>
    validateReleaseChainState(
      value.release,
      value.origin,
      publicationCommit,
    ));
  value.release.executorCommit = 'invalid';
  assert.throws(() =>
    validateReleaseChainState(
      value.release,
      value.origin,
      publicationCommit,
    ));
});

test('Registry package order is unique and deterministic', () => {
  const records = [
    { packageId: 'com.agentmesh360.deploy-agent' },
    { packageId: 'com.agentmesh360.job-agent' },
  ];
  assert.deepEqual(assertUniquePackages(records), records);
  assert.throws(() => assertUniquePackages([
    records[1],
    records[0],
  ]));
  assert.throws(() => assertUniquePackages([
    records[0],
    records[0],
  ]));
});

test('metadata bytes are newline terminated and typed', () => {
  const object = metadataObject('metadata/example.json', { ok: true });
  assert.equal(object.bytes.toString('utf8'), '{"ok":true}\n');
  assert.equal(object.contentType, 'application/json');
  assert.match(object.digest, /^sha256:[0-9a-f]{64}$/u);
});

test('publisher and Root generations are distinct', () => {
  const record = publisherRecord({
    generation: 'a',
    publicKey: Buffer.alloc(32).toString('base64'),
    status: 'active',
    window: {
      generatedAt: '2026-07-29T00:00:00.000Z',
      expiresAt: '2026-07-30T00:00:00.000Z',
    },
  });
  assert.equal(record.keyId, PUBLISHER_KEY_IDS.a);
  assert.notEqual(PUBLISHER_KEY_IDS.a, PUBLISHER_KEY_IDS.b);
  assert.notEqual(ROOT_KEY_IDS.a, ROOT_KEY_IDS.b);
});

test('publisher has no cloud creation, Provider, or production mutation path', async () => {
  const source = await readFile(
    new URL('./publish-release-chain.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /doctl|api\.cloudflare\.com|GEMINI_API_KEY|PRODUCTION_REGISTRY_URL/u,
  );
  assert.match(source, /assertP5ExecutionAuthority/u);
  assert.match(source, /metadata\/registry\.v2\.json/u);
  assert.match(source, /registryPublishedLast/u);
  for (const scenario of [
    'same_permission_update',
    'permission_expansion_rejected',
    'permission_expansion_approved',
    'root_rotation',
    'publisher_rotation',
    'publisher_revocation',
  ]) {
    assert.match(source, new RegExp(`'${scenario}'`, 'u'));
  }
  assert.match(source, /trustSequences = \[1, 2, 3, 4\]/u);
  assert.match(source, /registryRevisions = \[1, 2, 3, 4, 5\]/u);
});
