import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalRegistryPayload,
  objectKeyFromUrl,
  parseArguments,
  publicationWindow,
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
