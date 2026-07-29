import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  caddyfile,
  checkFaultToken,
  checkHttpsHealth,
  validateLiveState,
} from '../distribution-e1/deploy-origin.mjs';
import {
  AUTHORIZATION_ID,
} from './infrastructure-boundary.mjs';
import {
  parseArguments,
} from './deploy-origin.mjs';

const COMMIT = 'a'.repeat(40);

function dnsState() {
  return {
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    executionStatus: 'dns_recorded',
    executorCommit: COMMIT,
    infrastructure: {
      dropletCount: 1,
      spacesBucketCount: 2,
      cloudflareDnsRecordCount: 1,
    },
    droplet: {
      id: 123,
      name: 'am360-p5-e1-1234abcd',
      publicIpv4: '203.0.113.10',
      status: 'active',
    },
    dns: {
      hostname: 'packages-p5-e1-1234abcd.agentmesh360.com',
      ipv4: '203.0.113.10',
      proxied: false,
      recordId: 'a'.repeat(32),
      ttlSeconds: 60,
      zoneId: 'b'.repeat(32),
    },
    automaticDestroyNoLaterThan: '2099-01-01T00:00:00.000Z',
    cleanupRequired: true,
  };
}

test('pins the frozen executor-only P5 deployment command', () => {
  assert.deepEqual(
    parseArguments(['--executor-commit', COMMIT]),
    { executorCommit: COMMIT },
  );
  assert.throws(() => parseArguments([]));
  assert.throws(() => parseArguments([
    '--executor-commit',
    COMMIT,
    '--boundary',
    '/tmp/other',
  ]));
});

test('accepts only the active dedicated P5 DNS boundary', () => {
  assert.deepEqual(
    validateLiveState(dnsState(), COMMIT, 'p5'),
    dnsState(),
  );
  for (const mutate of [
    (value) => { value.authorizationId = 'distribution_service_e1_20260728_0001'; },
    (value) => { value.infrastructure.spacesBucketCount = 3; },
    (value) => { value.droplet.name = 'am360-p4-e1-1234abcd'; },
    (value) => { value.dns.proxied = true; },
    (value) => { value.dns.ipv4 = '203.0.113.11'; },
    (value) => { value.automaticDestroyNoLaterThan = '2020-01-01T00:00:00.000Z'; },
  ]) {
    const value = structuredClone(dnsState());
    mutate(value);
    assert.throws(() => validateLiveState(value, COMMIT, 'p5'));
  }
});

test('P5 hostname uses the same hardened TLS and fault probes', () => {
  const hostname = 'packages-p5-e1-1234abcd.agentmesh360.com';
  assert.match(caddyfile(hostname), /reverse_proxy 127\.0\.0\.1:8791/u);
  assert.equal(
    checkHttpsHealth(hostname, () => ({
      status: 0,
      stdout: '{"environment":"e1","status":"ok"}\n200\napplication/json',
    })),
    true,
  );
  assert.equal(
    checkFaultToken(
      hostname,
      '203.0.113.10',
      'x'.repeat(43),
      () => ({
        status: 0,
        stdout: [
          'HTTP/1.1 200 OK',
          'content-type: text/plain',
          '',
          '{}',
        ].join('\r\n'),
      }),
    ),
    true,
  );
});

test('wrapper cannot select paths or create infrastructure', async () => {
  const source = await readFile(
    new URL('./deploy-origin.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /doctl|api\.cloudflare\.com|GEMINI_API_KEY|--boundary|--credentials/u,
  );
  assert.match(source, /assertP5ExecutionAuthority/u);
  assert.match(source, /'p5'/u);
});
