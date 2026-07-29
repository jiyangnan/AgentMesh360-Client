import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AUTHORIZATION_ID,
  BOUNDARY,
  CLOUDFLARE_STATE_PATH,
  CREDENTIAL_PATH,
  cloudInit,
  exactTaggedDroplets,
  parseArguments,
  pendingDropletState,
  sanitizedDiagnostic,
  suffixFromCredentials,
  validateCloudflareState,
  validateDropletObject,
} from './infrastructure-boundary.mjs';

const COMMIT = 'a'.repeat(40);

function credentials() {
  return {
    region: 'sgp1',
    endpoint: 'sgp1.digitaloceanspaces.com',
    releasesBucket: 'am360-p5-e1-releases-1234abcd',
    metadataBucket: 'am360-p5-e1-metadata-1234abcd',
    publisher: {
      keyName: 'am360-p5-e1-publisher-1234abcd',
      accessKeyId: 'A'.repeat(20),
      secretAccessKey: 'b'.repeat(43),
    },
    originReader: {
      keyName: 'am360-p5-e1-origin-1234abcd',
      accessKeyId: 'B'.repeat(20),
      secretAccessKey: 'c'.repeat(43),
    },
  };
}

function droplet() {
  return {
    id: 123,
    name: 'am360-p5-e1-1234abcd',
    status: 'active',
    region: { slug: 'sgp1' },
    size_slug: 's-1vcpu-1gb',
    memory: 1024,
    vcpus: 1,
    disk: 25,
    features: [],
    networks: {
      v4: [{ type: 'public', ip_address: '203.0.113.10' }],
    },
  };
}

test('pins fixed private P5 infrastructure paths and strict actions', () => {
  assert.equal(BOUNDARY, '/private/tmp/agentmesh360-p5-e1-infrastructure');
  assert.equal(
    CREDENTIAL_PATH,
    '/private/tmp/agentmesh360-p5-e1-spaces-credentials.json',
  );
  assert.equal(
    CLOUDFLARE_STATE_PATH,
    '/private/tmp/agentmesh360-p5-e1-cloudflare-state.json',
  );
  assert.deepEqual(parseArguments([
    'probe-spaces',
    '--executor-commit',
    COMMIT,
  ]), {
    action: 'probe-spaces',
    executorCommit: COMMIT,
  });
  assert.deepEqual(parseArguments([
    'prepare',
    '--executor-commit',
    COMMIT,
  ]), {
    action: 'prepare',
    executorCommit: COMMIT,
  });
  assert.deepEqual(parseArguments([
    'record-dns',
    '--executor-commit',
    COMMIT,
  ]), {
    action: 'record-dns',
    executorCommit: COMMIT,
  });
  assert.throws(() => parseArguments(['create']));
  assert.throws(() => parseArguments(['probe-spaces']));
  assert.throws(() => parseArguments(['record-dns']));
  assert.throws(() => parseArguments(['prepare', '--executor-commit', 'bad']));
});

test('accepts only the exact P5 Spaces namespace', () => {
  assert.equal(suffixFromCredentials(credentials()), '1234abcd');
  for (const mutate of [
    (value) => { value.releasesBucket = 'am360-e1-releases-1234abcd'; },
    (value) => { value.metadataBucket = 'am360-p5-e1-metadata-ffffffff'; },
    (value) => { value.publisher.keyName = 'am360-p4-e1-publisher-1234abcd'; },
    (value) => { value.originReader.keyName = 'am360-p5-e1-origin-ffffffff'; },
  ]) {
    const value = structuredClone(credentials());
    mutate(value);
    assert.throws(() => suffixFromCredentials(value));
  }
});

test('cloud-init disables root and password login', () => {
  const value = cloudInit(
    `ssh-ed25519 ${'A'.repeat(48)} agentmesh360-p5-e1`,
  );
  assert.match(value, /disable_root: true/u);
  assert.match(value, /ssh_pwauth: false/u);
  assert.match(value, new RegExp(AUTHORIZATION_ID, 'u'));
  assert.match(value, /ufw, allow, 443\/tcp/u);
  assert.doesNotMatch(value, /enable-monitoring|enable-backups/u);
});

test('accepts only the approved active one-GiB Droplet', () => {
  const prepared = { dropletName: 'am360-p5-e1-1234abcd' };
  assert.deepEqual(validateDropletObject(droplet(), prepared), {
    id: 123,
    name: 'am360-p5-e1-1234abcd',
    publicIpv4: '203.0.113.10',
    status: 'active',
  });
  for (const mutate of [
    (value) => { value.memory = 2048; },
    (value) => { value.region.slug = 'nyc3'; },
    (value) => { value.features.push('backups'); },
    (value) => { value.networks.v4 = []; },
  ]) {
    const value = structuredClone(droplet());
    mutate(value);
    assert.throws(() => validateDropletObject(value, prepared));
  }
});

test('retains a pre-create cleanup receipt and exact discovery fallback', () => {
  const prepared = {
    authorizationId: AUTHORIZATION_ID,
    dropletName: 'am360-p5-e1-1234abcd',
  };
  assert.deepEqual(pendingDropletState(prepared), {
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    executionStatus: 'droplet_creation_pending',
    dropletId: null,
    dropletName: prepared.dropletName,
    cleanupRequired: true,
  });
  assert.equal(pendingDropletState(prepared, 123).dropletId, 123);
  assert.deepEqual(
    exactTaggedDroplets(
      JSON.stringify([
        { id: 123, name: prepared.dropletName },
        { id: 456, name: 'unrelated' },
        { id: 'bad', name: prepared.dropletName },
      ]),
      prepared.dropletName,
      'test discovery',
    ),
    [{ id: 123, name: prepared.dropletName }],
  );
  assert.throws(() => pendingDropletState(prepared, 1.5));
});

test('binds Cloudflare DNS-only state to the exact Droplet', () => {
  const live = {
    hostname: 'packages-p5-e1-1234abcd.agentmesh360.com',
    droplet: { publicIpv4: '203.0.113.10' },
  };
  const state = {
    hostname: live.hostname,
    ipv4: live.droplet.publicIpv4,
    proxied: false,
    recordId: 'a'.repeat(32),
    ttlSeconds: 60,
    zoneId: 'b'.repeat(32),
  };
  assert.deepEqual(validateCloudflareState(state, live), state);
  for (const mutate of [
    (value) => { value.proxied = true; },
    (value) => { value.ipv4 = '203.0.113.11'; },
    (value) => { value.hostname = 'packages.agentmesh360.com'; },
    (value) => { value.ttlSeconds = 120; },
  ]) {
    const value = structuredClone(state);
    mutate(value);
    assert.throws(() => validateCloudflareState(value, live));
  }
});

test('diagnostics redact paths, IPs, and credential identifiers', () => {
  const value = sanitizedDiagnostic(
    'failed /private/tmp/config 203.0.113.10 AAAAAAAAAAAAAAAAAAAA',
  );
  assert.doesNotMatch(value, /private|203\.0\.113\.10|A{20}/u);
});

test('source only mutates the approved Droplet through doctl', async () => {
  const source = await readFile(
    new URL('./infrastructure-boundary.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /api\.cloudflare\.com|GEMINI_API_KEY/u);
  assert.match(source, /'doctl'/u);
  assert.doesNotMatch(source, /--enable-backups|--enable-monitoring/u);
});
