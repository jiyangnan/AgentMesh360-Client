#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve4 } from 'node:dns/promises';
import {
  chmod,
  lstat,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { readCredentialFile } from './spaces-client.mjs';
import { strictConfig } from './origin-service.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const AUTHORIZATION_ID = 'distribution_service_e1_20260728_0001';
const DROPLET_EXECUTOR_COMMIT =
  'be108f436c24014ec6e4670d883f5b9c95de2925';
const BOUNDARY_PREFIX = 'agentmesh360-distribution-e1-';
const SSH_OPERATOR = 'agentmesh-operator';
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function sanitizedDiagnostic(stderr) {
  if (typeof stderr !== 'string') return '';
  const line = stderr
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1) ?? '';
  return line
    .replace(/\/[^\s:]+/gu, '<path>')
    .replace(/(?:\d{1,3}\.){3}\d{1,3}/gu, '<ip>')
    .replace(/[A-Z0-9]{20}/gu, '<credential-id>')
    .replace(/[A-Za-z0-9_-]{43}/gu, '<secret>')
    .slice(0, 320);
}

function isTransientSshFailure(result) {
  const diagnostic = `${result?.error?.code ?? ''}\n${result?.stderr ?? ''}`;
  return /(?:ECONNRESET|ETIMEDOUT|Connection (?:closed|reset|timed out)|kex_exchange_identification|Connection refused)/iu
    .test(diagnostic);
}

function run(command, args, label, options = {}) {
  const attempts = (options.transientRetries ?? 0) + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: options.timeout ?? 10 * 60 * 1000,
    });
    if (!result.error && result.status === 0) {
      return result.stdout.trim();
    }
    if (
      attempt + 1 < attempts
      && isTransientSshFailure(result)
    ) {
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        1_000,
      );
      continue;
    }
    const diagnostic = sanitizedDiagnostic(result.stderr);
    throw new Error(
      diagnostic ? `${label} failed: ${diagnostic}` : `${label} failed`,
    );
  }
  throw new Error(`${label} failed`);
}

async function assertBoundary(boundary) {
  const resolved = await realpath(boundary);
  const allowedParents = new Set([
    await realpath(os.tmpdir()),
    await realpath('/private/tmp'),
  ]);
  const stat = await lstat(resolved);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o777) !== 0o700
    || !path.basename(resolved).startsWith(BOUNDARY_PREFIX)
    || !allowedParents.has(path.dirname(resolved))
  ) {
    throw new Error('origin deployment boundary is invalid');
  }
  return resolved;
}

async function readMode0600Json(filePath, label) {
  const stat = await lstat(filePath);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size <= 0
    || stat.size > 64 * 1024
    || (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error(`${label} must be a bounded mode-0600 regular file`);
  }
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function validateLiveState(
  value,
  dropletExecutorCommit = DROPLET_EXECUTOR_COMMIT,
) {
  if (
    !value
    || typeof value !== 'object'
    || value.schemaVersion !== 1
    || value.authorizationId !== AUTHORIZATION_ID
    || value.executorCommit !== dropletExecutorCommit
    || !Number.isSafeInteger(value.droplet?.id)
    || value.droplet?.region !== 'sgp1'
    || value.droplet?.size !== 's-1vcpu-1gb'
    || value.droplet?.memoryMiB !== 1024
    || value.droplet?.vcpus !== 1
    || value.droplet?.diskGiB !== 25
    || value.droplet?.status !== 'active'
    || !/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value.droplet?.publicIpv4)
    || value.dns?.provider !== 'cloudflare'
    || value.dns?.proxied !== false
    || !/^packages-e1-[0-9a-f]{8}\.agentmesh360\.com$/u.test(
      value.dns?.hostname,
    )
  ) {
    throw new Error('live origin state differs from the approved E1 boundary');
  }
  return value;
}

async function assertExecutorCommit(executorCommit) {
  if (!/^[0-9a-f]{40}$/u.test(executorCommit)) {
    throw new Error('executor commit is invalid');
  }
  const commit = run(
    'git',
    ['rev-parse', 'HEAD'],
    'origin executor commit inspection',
    { cwd: REPOSITORY_ROOT },
  );
  const status = run(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    'origin executor clean-tree inspection',
    { cwd: REPOSITORY_ROOT },
  );
  if (commit !== executorCommit || status !== '') {
    throw new Error('origin executor is not the approved clean commit');
  }
}

function originConfig(credentials, faultToken) {
  return strictConfig({
    schemaVersion: 1,
    region: credentials.region,
    endpoint: credentials.endpoint,
    releasesBucket: credentials.releasesBucket,
    metadataBucket: credentials.metadataBucket,
    faultToken,
    originReader: credentials.originReader,
  });
}

function systemdUnit() {
  return `[Unit]
Description=AgentMesh360 P4 E1 isolated package origin
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agentmesh-e1
Group=agentmesh-e1
ExecStart=/usr/bin/node /opt/agentmesh360-e1/origin-service.mjs /etc/agentmesh360-e1/origin-config.json
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
`;
}

function caddyfile(hostname) {
  if (
    !/^packages-e1-[0-9a-f]{8}\.agentmesh360\.com$/u.test(hostname)
  ) {
    throw new Error('Caddy hostname is invalid');
  }
  return `${hostname} {
  reverse_proxy 127.0.0.1:8791
  header -Server
}
`;
}

function sshBase(boundary, ipAddress) {
  return [
    '-i',
    path.join(boundary, 'operator'),
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    `UserKnownHostsFile=${path.join(boundary, 'known_hosts')}`,
    '-o',
    'ConnectTimeout=10',
    `${SSH_OPERATOR}@${ipAddress}`,
  ];
}

function ssh(boundary, ipAddress, command, label, timeout) {
  return run(
    'ssh',
    [...sshBase(boundary, ipAddress), '--', 'sudo', '--', ...command],
    label,
    { timeout, transientRetries: 3 },
  );
}

function scp(boundary, ipAddress, source, destination, label) {
  run(
    'scp',
    [
      '-q',
      '-i',
      path.join(boundary, 'operator'),
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      `UserKnownHostsFile=${path.join(boundary, 'known_hosts')}`,
      '-o',
      'ConnectTimeout=10',
      source,
      `${SSH_OPERATOR}@${ipAddress}:${destination}`,
    ],
    label,
    { transientRetries: 3 },
  );
}

function originDirectoryCommands() {
  return [
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
  ];
}

function isFakeIpAddress(address) {
  const octets = String(address).split('.').map(Number);
  return (
    octets.length === 4
    && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    && octets[0] === 198
    && (octets[1] === 18 || octets[1] === 19)
  );
}

function parseCloudflareDohAnswer(hostname, payload) {
  if (payload?.Status !== 0 || !Array.isArray(payload.Answer)) {
    throw new Error('Cloudflare DNS-over-HTTPS answer is invalid');
  }
  const normalizedHostname = hostname.toLowerCase();
  return payload.Answer
    .filter(
      (answer) =>
        answer?.type === 1
        && String(answer.name ?? '').replace(/\.$/u, '').toLowerCase()
          === normalizedHostname
        && /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(answer.data),
    )
    .map((answer) => answer.data);
}

async function resolveWithCloudflareDoh(hostname, dohFetch = fetch) {
  const endpoint = new URL('https://cloudflare-dns.com/dns-query');
  endpoint.searchParams.set('name', hostname);
  endpoint.searchParams.set('type', 'A');
  const response = await dohFetch(endpoint, {
    headers: {
      accept: 'application/dns-json',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error('Cloudflare DNS-over-HTTPS lookup failed');
  }
  return parseCloudflareDohAnswer(hostname, await response.json());
}

function resolveWithCloudflareDohCurl(
  hostname,
  curlSpawn = spawnSync,
) {
  const result = curlSpawn(
    'curl',
    [
      '--fail',
      '--silent',
      '--show-error',
      '--connect-timeout',
      '15',
      '--max-time',
      '30',
      '--max-redirs',
      '0',
      '--header',
      'accept: application/dns-json',
      '--get',
      '--data-urlencode',
      `name=${hostname}`,
      '--data-urlencode',
      'type=A',
      'https://cloudflare-dns.com/dns-query',
    ],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 35_000,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error('Cloudflare DNS-over-HTTPS curl lookup failed');
  }
  try {
    return parseCloudflareDohAnswer(hostname, JSON.parse(result.stdout));
  } catch (error) {
    throw new Error('Cloudflare DNS-over-HTTPS curl answer is invalid', {
      cause: error,
    });
  }
}

async function resolvesToApprovedDroplet(
  hostname,
  expectedIp,
  {
    systemResolve4 = resolve4,
    dohResolve = resolveWithCloudflareDohCurl,
  } = {},
) {
  let systemAddresses = [];
  try {
    systemAddresses = await systemResolve4(hostname);
  } catch {
    // The HTTPS resolver below is the bounded fallback.
  }
  if (systemAddresses.includes(expectedIp)) return true;

  const hasOnlyFakeIpAnswers =
    systemAddresses.length > 0 && systemAddresses.every(isFakeIpAddress);
  try {
    const dohAddresses = await dohResolve(hostname);
    return dohAddresses.includes(expectedIp);
  } catch (error) {
    if (hasOnlyFakeIpAnswers) {
      throw new Error(
        'local DNS returned Fake-IP and HTTPS DNS verification failed',
        { cause: error },
      );
    }
    return false;
  }
}

async function waitForDns(
  hostname,
  expectedIp,
  {
    attempts = 12,
    intervalMs = 5_000,
    resolves = resolvesToApprovedDroplet,
    sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await resolves(hostname, expectedIp)) return;
    } catch {
      // DNS propagation is retried within the approved bounded window.
    }
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }
  throw new Error('staging DNS did not resolve to the approved Droplet');
}

function checkHttpsHealth(hostname, curlSpawn = spawnSync) {
  if (!/^packages-e1-[0-9a-f]{8}\.agentmesh360\.com$/u.test(hostname)) {
    throw new Error('staging HTTPS hostname is invalid');
  }
  const result = curlSpawn(
    'curl',
    [
      '--fail',
      '--silent',
      '--show-error',
      '--connect-timeout',
      '10',
      '--max-time',
      '15',
      '--max-redirs',
      '0',
      '--proto',
      '=https',
      '--write-out',
      '\\n%{http_code}\\n%{content_type}',
      `https://${hostname}/healthz`,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 20_000,
    },
  );
  if (result.error || result.status !== 0) return false;
  const lines = result.stdout.split('\n');
  const contentType = lines.pop() ?? '';
  const status = lines.pop() ?? '';
  const body = lines.join('\n');
  return (
    status === '200'
    && contentType.startsWith('application/json')
    && body === '{"environment":"e1","status":"ok"}'
  );
}

async function waitForHttps(
  hostname,
  {
    attempts = 20,
    intervalMs = 3_000,
    check = checkHttpsHealth,
    sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (check(hostname)) return;
    if (attempt + 1 < attempts) {
      await sleep(intervalMs);
    }
  }
  throw new Error('staging HTTPS health check did not become ready');
}

async function deployOrigin(boundary, credentialPath, executorCommit) {
  const resolved = await assertBoundary(boundary);
  await assertExecutorCommit(executorCommit);
  const credentials = await readCredentialFile(credentialPath);
  const liveStatePath = path.join(resolved, 'live-state.json');
  const liveState = validateLiveState(
    await readMode0600Json(liveStatePath, 'live origin state'),
  );
  const suffix = credentials.releasesBucket.split('-').at(-1);
  if (
    liveState.dns.hostname !== `packages-e1-${suffix}.agentmesh360.com`
    || liveState.droplet.name !== `am360-p4-e1-${suffix}`
  ) {
    throw new Error('origin DNS, Droplet, and Spaces suffixes differ');
  }
  const faultToken = randomBytes(32).toString('base64url');
  const configPath = path.join(resolved, 'origin-config.json');
  const unitPath = path.join(resolved, 'agentmesh360-e1-origin.service');
  const caddyPath = path.join(resolved, 'Caddyfile');
  await writeFile(
    configPath,
    JSON.stringify(originConfig(credentials, faultToken)),
    { mode: 0o600, flag: 'w' },
  );
  await writeFile(unitPath, systemdUnit(), {
    mode: 0o600,
    flag: 'w',
  });
  await writeFile(caddyPath, caddyfile(liveState.dns.hostname), {
    mode: 0o600,
    flag: 'w',
  });
  await chmod(configPath, 0o600);
  await chmod(unitPath, 0o600);
  await chmod(caddyPath, 0o600);

  await waitForDns(liveState.dns.hostname, liveState.droplet.publicIpv4);
  const ipAddress = liveState.droplet.publicIpv4;
  ssh(
    resolved,
    ipAddress,
    ['cloud-init', 'status', '--wait'],
    'cloud-init completion',
    12 * 60 * 1000,
  );
  ssh(
    resolved,
    ipAddress,
    ['apt-get', 'update'],
    'origin package index refresh',
  );
  ssh(
    resolved,
    ipAddress,
    [
      'env',
      'DEBIAN_FRONTEND=noninteractive',
      'apt-get',
      'install',
      '-y',
      'caddy',
    ],
    'Caddy installation',
  );
  try {
    ssh(
      resolved,
      ipAddress,
      ['id', '-u', 'agentmesh-e1'],
      'origin service account inspection',
    );
  } catch {
    ssh(
      resolved,
      ipAddress,
      [
        'useradd',
        '--system',
        '--home',
        '/nonexistent',
        '--shell',
        '/usr/sbin/nologin',
        'agentmesh-e1',
      ],
      'origin service account creation',
    );
  }
  for (const command of originDirectoryCommands()) {
    ssh(resolved, ipAddress, command, 'origin directory installation');
  }
  scp(
    resolved,
    ipAddress,
    path.join(MODULE_DIRECTORY, 'origin-service.mjs'),
    '/tmp/origin-service.mjs',
    'origin service transfer',
  );
  scp(
    resolved,
    ipAddress,
    path.join(MODULE_DIRECTORY, 'spaces-client.mjs'),
    '/tmp/spaces-client.mjs',
    'Spaces client transfer',
  );
  scp(
    resolved,
    ipAddress,
    configPath,
    '/tmp/origin-config.json',
    'origin configuration transfer',
  );
  scp(
    resolved,
    ipAddress,
    unitPath,
    '/tmp/agentmesh360-e1-origin.service',
    'origin unit transfer',
  );
  scp(
    resolved,
    ipAddress,
    caddyPath,
    '/tmp/Caddyfile',
    'Caddy configuration transfer',
  );
  for (const command of [
    [
      'install',
      '-o',
      'root',
      '-g',
      'root',
      '-m',
      '0644',
      '/tmp/origin-service.mjs',
      '/opt/agentmesh360-e1/origin-service.mjs',
    ],
    [
      'install',
      '-o',
      'root',
      '-g',
      'root',
      '-m',
      '0644',
      '/tmp/spaces-client.mjs',
      '/opt/agentmesh360-e1/spaces-client.mjs',
    ],
    [
      'install',
      '-o',
      'agentmesh-e1',
      '-g',
      'agentmesh-e1',
      '-m',
      '0600',
      '/tmp/origin-config.json',
      '/etc/agentmesh360-e1/origin-config.json',
    ],
    [
      'install',
      '-o',
      'root',
      '-g',
      'root',
      '-m',
      '0644',
      '/tmp/agentmesh360-e1-origin.service',
      '/etc/systemd/system/agentmesh360-e1-origin.service',
    ],
    [
      'install',
      '-o',
      'root',
      '-g',
      'root',
      '-m',
      '0644',
      '/tmp/Caddyfile',
      '/etc/caddy/Caddyfile',
    ],
  ]) {
    ssh(resolved, ipAddress, command, 'origin file installation');
  }
  ssh(
    resolved,
    ipAddress,
    ['systemctl', 'daemon-reload'],
    'origin systemd reload',
  );
  ssh(
    resolved,
    ipAddress,
    ['systemctl', 'enable', '--now', 'agentmesh360-e1-origin.service'],
    'origin service enable',
  );
  ssh(
    resolved,
    ipAddress,
    ['systemctl', 'restart', 'caddy'],
    'Caddy restart',
  );
  ssh(
    resolved,
    ipAddress,
    ['systemctl', 'is-active', '--quiet', 'agentmesh360-e1-origin.service'],
    'origin service active check',
  );
  ssh(
    resolved,
    ipAddress,
    ['systemctl', 'is-active', '--quiet', 'caddy'],
    'Caddy active check',
  );
  await waitForHttps(liveState.dns.hostname);

  const nextState = {
    ...liveState,
    origin: {
      deployed: true,
      executorCommit,
      tls: 'caddy_managed_lets_encrypt',
      faultToken,
      deployedAt: new Date().toISOString(),
    },
  };
  await writeFile(liveStatePath, JSON.stringify(nextState), {
    mode: 0o600,
    flag: 'w',
  });
  await chmod(liveStatePath, 0o600);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value == null || values.has(key)) {
      throw new Error('invalid or duplicate argument');
    }
    values.set(key, value);
  }
  if (
    values.size !== 3
    || !path.isAbsolute(values.get('--boundary') ?? '')
    || !path.isAbsolute(values.get('--credentials') ?? '')
    || !/^[0-9a-f]{40}$/u.test(values.get('--executor-commit') ?? '')
  ) {
    throw new Error(
      'usage: deploy-origin.mjs --boundary <absolute> --credentials <absolute> --executor-commit <commit>',
    );
  }
  return {
    boundary: values.get('--boundary'),
    credentialPath: values.get('--credentials'),
    executorCommit: values.get('--executor-commit'),
  };
}

function isMainModule() {
  return process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
  if (options) {
    deployOrigin(
      options.boundary,
      options.credentialPath,
      options.executorCommit,
    )
      .then(() => {
        console.log(
          'E1 Spaces-backed HTTPS origin active; Caddy TLS and health passed',
        );
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}

export {
  caddyfile,
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
};
