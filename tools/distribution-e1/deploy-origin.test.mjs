import assert from 'node:assert/strict';
import test from 'node:test';

import {
  caddyfile,
  originConfig,
  parseArguments,
  sanitizedDiagnostic,
  systemdUnit,
  validateLiveState,
} from './deploy-origin.mjs';

const COMMIT = 'a'.repeat(40);
const DROPLET_COMMIT =
  '028fc9fd2b6892f980c93e29d2af87f98433a7bc';

function credentials() {
  return {
    region: 'sgp1',
    endpoint: 'sgp1.digitaloceanspaces.com',
    releasesBucket: 'am360-e1-releases-1234abcd',
    metadataBucket: 'am360-e1-metadata-1234abcd',
    publisher: {
      keyName: 'am360-p4-e1-publisher-1234abcd',
      accessKeyId: 'P'.repeat(20),
      secretAccessKey: 'p'.repeat(43),
    },
    originReader: {
      keyName: 'am360-p4-e1-origin-1234abcd',
      accessKeyId: 'R'.repeat(20),
      secretAccessKey: 'r'.repeat(43),
    },
  };
}

function liveState() {
  return {
    schemaVersion: 1,
    authorizationId: 'distribution_service_e1_20260728_0001',
    executorCommit: DROPLET_COMMIT,
    droplet: {
      id: 123,
      name: 'am360-p4-e1-1234abcd',
      publicIpv4: '203.0.113.10',
      region: 'sgp1',
      size: 's-1vcpu-1gb',
      memoryMiB: 1024,
      vcpus: 1,
      diskGiB: 25,
      status: 'active',
    },
    dns: {
      provider: 'cloudflare',
      hostname: 'packages-e1-1234abcd.agentmesh360.com',
      proxied: false,
    },
  };
}

test('origin config includes only the read-only principal', () => {
  const config = originConfig(credentials(), 'x'.repeat(43));
  assert.deepEqual(config.originReader, credentials().originReader);
  assert.ok(!Object.hasOwn(config, 'publisher'));
  assert.ok(!JSON.stringify(config).includes('p'.repeat(43)));
});

test('Caddy and systemd configs expose only the local hardened service', () => {
  const caddy = caddyfile('packages-e1-1234abcd.agentmesh360.com');
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8791/u);
  assert.doesNotMatch(caddy, /\blog\b/u);
  assert.throws(() => caddyfile('packages.agentmesh360.com'));

  const unit = systemdUnit();
  assert.match(unit, /User=agentmesh-e1/u);
  assert.match(unit, /NoNewPrivileges=true/u);
  assert.match(unit, /ProtectSystem=strict/u);
  assert.match(unit, /CapabilityBoundingSet=\n/u);
  assert.doesNotMatch(unit, /Environment=.*(?:KEY|TOKEN|SECRET)/u);
});

test('validates the exact Droplet, DNS-only hostname, and executor commit', () => {
  assert.deepEqual(validateLiveState(liveState()), liveState());
  assert.deepEqual(validateLiveState(liveState(), DROPLET_COMMIT), liveState());
  for (const mutate of [
    (value) => {
      value.executorCommit = 'b'.repeat(40);
    },
    (value) => {
      value.droplet.size = 's-1vcpu-2gb';
    },
    (value) => {
      value.dns.proxied = true;
    },
    (value) => {
      value.dns.hostname = 'packages.agentmesh360.com';
    },
  ]) {
    const value = structuredClone(liveState());
    mutate(value);
    assert.throws(() => validateLiveState(value, DROPLET_COMMIT));
  }
});

test('parses only the complete absolute deployment boundary', () => {
  const parsed = parseArguments([
    '--boundary',
    '/private/tmp/agentmesh360-distribution-e1-current',
    '--credentials',
    '/private/tmp/agentmesh360-p4-e1-spaces-current.json',
    '--executor-commit',
    COMMIT,
  ]);
  assert.equal(parsed.executorCommit, COMMIT);
  assert.throws(() =>
    parseArguments([
      '--boundary',
      'relative',
      '--credentials',
      '/private/tmp/credentials.json',
      '--executor-commit',
      COMMIT,
    ]));
});

test('sanitizes remote paths, IPs, credential IDs, and tokens', () => {
  const diagnostic = sanitizedDiagnostic(
    'failed /root/config 203.0.113.10 AAAAAAAAAAAAAAAAAAAA '
    + 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  );
  assert.doesNotMatch(diagnostic, /root/u);
  assert.doesNotMatch(diagnostic, /203\.0\.113\.10/u);
  assert.doesNotMatch(diagnostic, /A{20}/u);
  assert.doesNotMatch(diagnostic, /x{43}/u);
});
