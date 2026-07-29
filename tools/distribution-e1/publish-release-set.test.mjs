import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  canonicalRegistryPayload,
  isTransientSpacesFailure,
  objectKeyFromUrl,
  parseArguments,
  putNewObject,
  publicationWindow,
  requestWithTransientRetries,
  strictRegistryRecord,
} from './publish-release-set.mjs';

function record() {
  const base =
    'https://packages-e1-1234abcd.agentmesh360.com/objects/releases/'
    + 'com.agentmesh360.job-agent/0.4.7';
  return {
    packageId: 'com.agentmesh360.job-agent',
    agentId: 'job-agent',
    version: '0.4.7',
    publisher: 'agentmesh360',
    releaseManifestUrl: `${base}/release.json`,
    releaseManifestSha256: '1'.repeat(64),
    artifactUrl: `${base}/artifact.tar.zst`,
    artifactSha256: '2'.repeat(64),
    envelopeUrl: `${base}/envelope.json`,
    envelopeSha256: '3'.repeat(64),
    hostProjectionUrl: `${base}/projection.json`,
    hostProjectionSha256: '4'.repeat(64),
    hostBundles: [{
      host: 'codex',
      entrypoint: 'skills/codex/SKILL.md',
      bundleUrl: `${base}/codex.tar.zst`,
      bundleSha256: '5'.repeat(64),
    }],
  };
}

function response(status, bytes = Buffer.alloc(0)) {
  return {
    response: {
      status,
      body: { cancel: async () => {} },
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    },
  };
}

test('mirrors the Rust Registry v2 canonical payload order', () => {
  const snapshot = {
    schemaVersion: 2,
    revision: 2,
    rootKeyId: 'root-e1',
    trustBundleSequence: 1,
    generatedAt: '2026-07-28T00:00:00.000Z',
    expiresAt: '2026-07-30T00:00:00.000Z',
    packages: [record()],
    signature: '',
  };
  const payload = canonicalRegistryPayload(snapshot);
  assert.ok(payload.startsWith(
    'agentmesh360-package-registry-v2\n'
    + 'schemaVersion=2\nrevision=2\nrootKeyId=root-e1\n'
    + 'trustBundleSequence=1\n',
  ));
  assert.match(payload, /\npackage=Y29tLmFnZW50bWVzaDM2MC5qb2ItYWdlbnQ=\|/u);
  assert.match(payload, /\nhost=Y29tLmFnZW50bWVzaDM2MC5qb2ItYWdlbnQ=\|codex\|/u);
  assert.ok(payload.endsWith(`${'5'.repeat(64)}\n`));
});

test('accepts only canonical E1 release URLs and strict records', () => {
  const origin = 'https://packages-e1-1234abcd.agentmesh360.com';
  assert.equal(
    objectKeyFromUrl(record().artifactUrl, origin),
    'releases/com.agentmesh360.job-agent/0.4.7/artifact.tar.zst',
  );
  assert.equal(strictRegistryRecord(record(), origin).packageId,
    'com.agentmesh360.job-agent');
  assert.throws(() => objectKeyFromUrl(
    `${record().artifactUrl}?mutable=1`,
    origin,
  ));
  const drift = record();
  drift.artifactSha256 = 'ABC';
  assert.throws(() => strictRegistryRecord(drift, origin));
});

test('publication window is bounded by automatic destruction', () => {
  const state = {
    automaticDestroyNoLaterThan: new Date(
      Date.now() + 6 * 60 * 60_000,
    ).toISOString(),
  };
  const window = publicationWindow(state);
  assert.ok(Date.parse(window.generatedAt) < Date.now());
  assert.ok(
    Date.parse(window.expiresAt)
      < Date.parse(state.automaticDestroyNoLaterThan),
  );
  assert.throws(() => publicationWindow({
    automaticDestroyNoLaterThan: '2026-01-01T00:00:00.000Z',
  }));
});

test('parses only four absolute publication boundaries', () => {
  const parsed = parseArguments([
    '--executor-commit',
    'a'.repeat(40),
    '--credentials',
    '/private/tmp/credentials.json',
    '--origin-state',
    '/private/tmp/origin.json',
    '--release-state',
    '/private/tmp/release.json',
    '--output-state',
    '/private/tmp/publication.json',
  ]);
  assert.equal(parsed.executorCommit, 'a'.repeat(40));
  assert.equal(parsed.outputState, '/private/tmp/publication.json');
  assert.throws(() => parseArguments([
    '--credentials',
    'relative',
  ]));
});

test('retries only bounded transient Spaces failures', async () => {
  assert.equal(isTransientSpacesFailure(
    Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
  ), true);
  assert.equal(isTransientSpacesFailure(
    new Error('Spaces request returned unexpected status 503'),
  ), true);
  assert.equal(isTransientSpacesFailure(
    new Error('Spaces request returned unexpected status 403'),
  ), false);

  let attempts = 0;
  const result = await requestWithTransientRetries(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError('fetch failed');
      return 'ok';
    },
    { sleep: async () => {} },
  );
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('recovers an uncertain PUT only after exact readback', async () => {
  const bytes = Buffer.from('immutable payload');
  const object = {
    bytes,
    contentType: 'application/octet-stream',
    digest: `sha256:${
      createHash('sha256')
        .update(bytes)
        .digest('hex')
    }`,
    objectKey: 'releases/object.bin',
  };
  const credentials = {
    releasesBucket: 'am360-e1-releases-1234abcd',
  };
  const methods = [];
  let putAttempts = 0;
  const receipt = await putNewObject(
    credentials,
    credentials.releasesBucket,
    object,
    {
      request: async ({ method, expectedStatuses }) => {
        methods.push(method);
        if (method === 'HEAD' && expectedStatuses.length === 1) {
          return response(404);
        }
        if (method === 'PUT') {
          putAttempts += 1;
          throw Object.assign(
            new Error('network timed out'),
            { name: 'TimeoutError' },
          );
        }
        if (method === 'HEAD') return response(200);
        if (method === 'GET') return response(200, bytes);
        throw new Error('unexpected request');
      },
      retryOptions: { sleep: async () => {} },
    },
  );
  assert.equal(putAttempts, 1);
  assert.equal(receipt.objectKey, object.objectKey);
  assert.deepEqual(methods, ['HEAD', 'PUT', 'HEAD', 'GET', 'GET']);
});

test('never overwrites an uncertain PUT with a different digest', async () => {
  const bytes = Buffer.from('planned');
  const object = {
    bytes,
    contentType: 'application/octet-stream',
    digest: `sha256:${
      createHash('sha256')
        .update(bytes)
        .digest('hex')
    }`,
    objectKey: 'releases/object.bin',
  };
  let putAttempts = 0;
  await assert.rejects(
    putNewObject(
      { releasesBucket: 'am360-e1-releases-1234abcd' },
      'am360-e1-releases-1234abcd',
      object,
      {
        request: async ({ method, expectedStatuses }) => {
          if (method === 'HEAD' && expectedStatuses.length === 1) {
            return response(404);
          }
          if (method === 'PUT') {
            putAttempts += 1;
            throw new TypeError('fetch failed');
          }
          if (method === 'HEAD') return response(200);
          if (method === 'GET') {
            return response(200, Buffer.from('different'));
          }
          throw new Error('unexpected request');
        },
        retryOptions: { sleep: async () => {} },
      },
    ),
    /different immutable object/u,
  );
  assert.equal(putAttempts, 1);
});
