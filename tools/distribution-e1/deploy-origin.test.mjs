import assert from 'node:assert/strict';
import test from 'node:test';

import {
  caddyfile,
  checkFaultToken,
  checkHttpsHealth,
  isFakeIpAddress,
  isTransientSshFailure,
  originDirectoryCommands,
  originConfig,
  parseArguments,
  resolvesToApprovedDroplet,
  resolveWithCloudflareDoh,
  resolveWithCloudflareDohCurl,
  sanitizedDiagnostic,
  systemdUnit,
  validateLiveState,
  waitForDns,
  waitForHttps,
} from './deploy-origin.mjs';

const COMMIT = 'a'.repeat(40);
const DROPLET_COMMIT =
  'be108f436c24014ec6e4670d883f5b9c95de2925';

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

  assert.deepEqual(originDirectoryCommands(), [
    [
      'install',
      '-d',
      '-o',
      'root',
      '-g',
      'root',
      '-m',
      '0755',
      '/opt/agentmesh360-e1',
    ],
    [
      'install',
      '-d',
      '-o',
      'root',
      '-g',
      'agentmesh-e1',
      '-m',
      '0750',
      '/etc/agentmesh360-e1',
    ],
  ]);
});

test('fault token probe bypasses proxies and keeps the token off argv', () => {
  const hostname = 'packages-e1-1234abcd.agentmesh360.com';
  const token = 'x'.repeat(43);
  let invocation;
  const passed = checkFaultToken(
    hostname,
    '203.0.113.10',
    token,
    (command, args, options) => {
      invocation = { command, args, input: options.input };
      return {
        status: 0,
        stdout: [
          'HTTP/1.1 200 OK',
          'content-type: text/plain',
          '',
          '{}',
        ].join('\r\n'),
      };
    },
  );
  assert.equal(passed, true);
  assert.equal(invocation.command, 'curl');
  assert.deepEqual(invocation.args, ['--config', '-']);
  assert.ok(!invocation.args.join(' ').includes(token));
  assert.match(invocation.input, /noproxy = "\*"/u);
  assert.match(invocation.input, /resolve = "/u);
  assert.ok(invocation.input.includes(token));
  assert.equal(
    checkFaultToken(hostname, '203.0.113.10', token, () => ({
      status: 0,
      stdout: [
        'HTTP/1.1 404 Not Found',
        'content-type: application/json',
        '',
        '',
      ].join('\r\n'),
    })),
    false,
  );
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

test('recognizes only the RFC 2544 Fake-IP range used by local TUN DNS', () => {
  assert.equal(isFakeIpAddress('198.18.0.1'), true);
  assert.equal(isFakeIpAddress('198.19.255.254'), true);
  assert.equal(isFakeIpAddress('198.17.255.254'), false);
  assert.equal(isFakeIpAddress('198.20.0.1'), false);
  assert.equal(isFakeIpAddress('203.0.113.10'), false);
  assert.equal(isFakeIpAddress('invalid'), false);
});

test('accepts an exact system DNS answer without consulting HTTPS DNS', async () => {
  let dohCalls = 0;
  const result = await resolvesToApprovedDroplet(
    'packages-e1-1234abcd.agentmesh360.com',
    '203.0.113.10',
    {
      systemResolve4: async () => ['203.0.113.10'],
      dohResolve: async () => {
        dohCalls += 1;
        throw new Error('should not be called');
      },
    },
  );
  assert.equal(result, true);
  assert.equal(dohCalls, 0);
});

test('uses bounded HTTPS DNS when local TUN returns a Fake-IP', async () => {
  const result = await resolvesToApprovedDroplet(
    'packages-e1-1234abcd.agentmesh360.com',
    '203.0.113.10',
    {
      systemResolve4: async () => ['198.18.1.88'],
      dohResolve: async (hostname) => {
        assert.equal(
          hostname,
          'packages-e1-1234abcd.agentmesh360.com',
        );
        return ['203.0.113.10'];
      },
    },
  );
  assert.equal(result, true);
});

test('curl HTTPS DNS uses no redirects and parses only an exact A answer', () => {
  const hostname = 'packages-e1-1234abcd.agentmesh360.com';
  const addresses = resolveWithCloudflareDohCurl(
    hostname,
    (command, args, options) => {
      assert.equal(command, 'curl');
      assert.ok(args.includes('--max-redirs'));
      assert.equal(args[args.indexOf('--max-redirs') + 1], '0');
      assert.ok(args.includes(`name=${hostname}`));
      assert.equal(options.maxBuffer, 64 * 1024);
      return {
        status: 0,
        stdout: JSON.stringify({
          Status: 0,
          Answer: [{
            name: 'packages-e1-1234abcd.agentmesh360.com.',
            type: 1,
            data: '203.0.113.10',
          }],
        }),
      };
    },
  );
  assert.deepEqual(addresses, ['203.0.113.10']);
});

test('rejects mismatched or malformed HTTPS DNS answers', async () => {
  const hostname = 'packages-e1-1234abcd.agentmesh360.com';
  const mismatch = await resolvesToApprovedDroplet(
    hostname,
    '203.0.113.10',
    {
      systemResolve4: async () => ['198.18.1.88'],
      dohResolve: async () => ['203.0.113.11'],
    },
  );
  assert.equal(mismatch, false);

  await assert.rejects(
    resolveWithCloudflareDoh(
      hostname,
      async () => new Response(JSON.stringify({ Status: 2 }), { status: 200 }),
    ),
    /answer is invalid/u,
  );
});

test('bounded DNS wait stops immediately on success and fails closed', async () => {
  let calls = 0;
  await waitForDns('example.com', '203.0.113.10', {
    attempts: 3,
    resolves: async () => {
      calls += 1;
      return calls === 2;
    },
    sleep: async () => {},
  });
  assert.equal(calls, 2);

  await assert.rejects(
    waitForDns('example.com', '203.0.113.10', {
      attempts: 2,
      resolves: async () => false,
      sleep: async () => {},
    }),
    /did not resolve/u,
  );
});

test('retries only recognized transient SSH transport failures', () => {
  assert.equal(isTransientSshFailure({
    stderr: 'Connection closed by 203.0.113.10 port 22',
  }), true);
  assert.equal(isTransientSshFailure({
    stderr: 'kex_exchange_identification: read: Connection reset by peer',
  }), true);
  assert.equal(isTransientSshFailure({
    error: { code: 'ETIMEDOUT' },
  }), true);
  assert.equal(isTransientSshFailure({
    stderr: 'Permission denied (publickey).',
  }), false);
  assert.equal(isTransientSshFailure({
    stderr: 'sudo: a password is required',
  }), false);
});

test('HTTPS health uses curl without redirects and validates exact output', () => {
  const hostname = 'packages-e1-1234abcd.agentmesh360.com';
  const healthy = checkHttpsHealth(hostname, (command, args, options) => {
    assert.equal(command, 'curl');
    assert.equal(args[args.indexOf('--max-redirs') + 1], '0');
    assert.equal(args.at(-1), `https://${hostname}/healthz`);
    assert.equal(options.maxBuffer, 64 * 1024);
    return {
      status: 0,
      stdout: '{"environment":"e1","status":"ok"}\n200\napplication/json',
    };
  });
  assert.equal(healthy, true);
  assert.equal(checkHttpsHealth(hostname, () => ({
    status: 0,
    stdout: '{"environment":"e1","status":"ok"}\n302\napplication/json',
  })), false);
  assert.throws(() => checkHttpsHealth('packages.agentmesh360.com'));
});

test('bounded HTTPS wait retries and fails closed', async () => {
  let calls = 0;
  await waitForHttps('packages-e1-1234abcd.agentmesh360.com', {
    attempts: 3,
    check: () => {
      calls += 1;
      return calls === 2;
    },
    sleep: async () => {},
  });
  assert.equal(calls, 2);
  await assert.rejects(
    waitForHttps('packages-e1-1234abcd.agentmesh360.com', {
      attempts: 2,
      check: () => false,
      sleep: async () => {},
    }),
    /did not become ready/u,
  );
});
