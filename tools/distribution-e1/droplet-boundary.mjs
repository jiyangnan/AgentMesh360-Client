#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { readCredentialFile } from './spaces-client.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const AUTHORIZATION_ID = 'distribution_service_e1_20260728_0001';
const BOUNDARY_PREFIX = 'agentmesh360-distribution-e1-';
const DROPLET_TAG = 'agentmesh360-p4-e1';
const EXPECTED_REGION = 'sgp1';
const EXPECTED_SIZE = 's-1vcpu-1gb';
const EXPECTED_IMAGE = 'ubuntu-24-04-x64';
const SSH_OPERATOR = 'agentmesh-operator';
const MAX_DOCTL_OUTPUT = 4 * 1024 * 1024;

function typedSha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

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
    .slice(0, 320);
}

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    maxBuffer: MAX_DOCTL_OUTPUT,
  });
  if (result.error || result.status !== 0) {
    const diagnostic = sanitizedDiagnostic(result.stderr);
    throw new Error(
      diagnostic ? `${label} failed: ${diagnostic}` : `${label} failed`,
    );
  }
  return result.stdout.trim();
}

async function assertNewBoundary(boundary) {
  const resolvedParent = await realpath(path.dirname(boundary));
  const allowedParents = await allowedBoundaryParents();
  if (
    !allowedParents.has(resolvedParent)
    || !path.basename(boundary).startsWith(BOUNDARY_PREFIX)
  ) {
    throw new Error('Droplet boundary must be a direct E1 temporary directory');
  }
  try {
    await lstat(boundary);
    throw new Error('Droplet boundary already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(boundary, { mode: 0o700 });
  return realpath(boundary);
}

async function allowedBoundaryParents() {
  return new Set([
    await realpath(os.tmpdir()),
    await realpath('/private/tmp'),
  ]);
}

async function assertExistingBoundary(boundary) {
  const resolved = await realpath(boundary);
  const stat = await lstat(resolved);
  const allowedParents = await allowedBoundaryParents();
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o777) !== 0o700
    || !path.basename(resolved).startsWith(BOUNDARY_PREFIX)
    || !allowedParents.has(path.dirname(resolved))
  ) {
    throw new Error('Droplet boundary is invalid');
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
  let value;
  try {
    value = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  return value;
}

function cloudInit(publicKey) {
  if (
    typeof publicKey !== 'string'
    || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2} agentmesh360-p4-e1$/u
      .test(publicKey)
  ) {
    throw new Error('ephemeral SSH public key is invalid');
  }
  return `#cloud-config
disable_root: true
ssh_pwauth: false
users:
  - name: ${SSH_OPERATOR}
    gecos: AgentMesh360 E1 operator
    groups:
      - sudo
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    lock_passwd: true
    shell: /bin/bash
    ssh_authorized_keys:
      - ${publicKey}
package_update: true
packages:
  - ca-certificates
  - curl
  - nodejs
  - ufw
write_files:
  - path: /etc/agentmesh360-e1-boundary
    owner: root:root
    permissions: '0600'
    content: |
      ${AUTHORIZATION_ID}
runcmd:
  - [install, -d, -m, '0700', /opt/agentmesh360-e1]
  - [install, -d, -m, '0700', /etc/agentmesh360-e1]
  - [ufw, allow, 22/tcp]
  - [ufw, allow, 80/tcp]
  - [ufw, allow, 443/tcp]
  - [ufw, --force, enable]
`;
}

async function prepareBoundary(boundary, credentialPath) {
  const credentials = await readCredentialFile(credentialPath);
  const suffix = credentials.releasesBucket.split('-').at(-1);
  const resolved = await assertNewBoundary(boundary);
  const sshPrivatePath = path.join(resolved, 'operator');
  const sshPublicPath = `${sshPrivatePath}.pub`;
  const cloudInitPath = path.join(resolved, 'cloud-init.yaml');
  const preparedStatePath = path.join(resolved, 'prepared-state.json');
  const dropletName = `am360-p4-e1-${suffix}`;
  try {
    run(
      'ssh-keygen',
      [
        '-q',
        '-t',
        'ed25519',
        '-N',
        '',
        '-C',
        'agentmesh360-p4-e1',
        '-f',
        sshPrivatePath,
      ],
      'ephemeral SSH key generation',
    );
    await chmod(sshPrivatePath, 0o600);
    await chmod(sshPublicPath, 0o600);
    const publicKey = (await readFile(sshPublicPath, 'utf8')).trim();
    const privateStat = await lstat(sshPrivatePath);
    if (
      !privateStat.isFile()
      || privateStat.isSymbolicLink()
      || (privateStat.mode & 0o777) !== 0o600
    ) {
      throw new Error('ephemeral SSH private key boundary is invalid');
    }
    await writeFile(cloudInitPath, cloudInit(publicKey), {
      mode: 0o600,
      flag: 'wx',
    });
    const prepared = {
      schemaVersion: 1,
      authorizationId: AUTHORIZATION_ID,
      dropletName,
      tag: DROPLET_TAG,
      region: EXPECTED_REGION,
      size: EXPECTED_SIZE,
      image: EXPECTED_IMAGE,
      backupsEnabled: false,
      monitoringEnabled: false,
      sshPublicKeySha256: typedSha256(Buffer.from(publicKey, 'utf8')),
      cloudInitSha256: typedSha256(await readFile(cloudInitPath)),
      preparedAt: new Date().toISOString(),
    };
    await writeFile(preparedStatePath, JSON.stringify(prepared), {
      mode: 0o600,
      flag: 'wx',
    });
    return prepared;
  } catch (error) {
    await rm(resolved, { recursive: true, force: true });
    throw error;
  }
}

function parseDoctlJson(document, label) {
  let parsed;
  try {
    parsed = JSON.parse(document);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  const value = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} returned no object`);
  }
  return value;
}

export function validateDropletObject(value, prepared) {
  const publicNetwork = value.networks?.v4?.find(
    (entry) => entry.type === 'public',
  );
  if (
    !Number.isSafeInteger(value.id)
    || value.name !== prepared.dropletName
    || value.region?.slug !== EXPECTED_REGION
    || value.size_slug !== EXPECTED_SIZE
    || value.memory !== 1024
    || value.vcpus !== 1
    || value.disk !== 25
    || value.status !== 'active'
    || !publicNetwork
    || !/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(publicNetwork.ip_address)
    || (value.features ?? []).includes('backups')
  ) {
    throw new Error('created Droplet differs from the approved E1 boundary');
  }
  return {
    id: value.id,
    name: value.name,
    publicIpv4: publicNetwork.ip_address,
    region: value.region.slug,
    size: value.size_slug,
    memoryMiB: value.memory,
    vcpus: value.vcpus,
    diskGiB: value.disk,
    status: value.status,
  };
}

async function assertExecutorCommit(executorCommit) {
  if (!/^[0-9a-f]{40}$/u.test(executorCommit)) {
    throw new Error('executor commit is invalid');
  }
  const commit = run(
    'git',
    ['rev-parse', 'HEAD'],
    'executor commit inspection',
    { cwd: REPOSITORY_ROOT },
  );
  const status = run(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    'executor clean-tree inspection',
    { cwd: REPOSITORY_ROOT },
  );
  if (commit !== executorCommit || status !== '') {
    throw new Error('executor is not the approved clean commit');
  }
}

async function createDroplet(boundary, executorCommit) {
  const resolved = await assertExistingBoundary(boundary);
  await assertExecutorCommit(executorCommit);
  const prepared = await readMode0600Json(
    path.join(resolved, 'prepared-state.json'),
    'prepared Droplet state',
  );
  if (
    prepared.authorizationId !== AUTHORIZATION_ID
    || prepared.region !== EXPECTED_REGION
    || prepared.size !== EXPECTED_SIZE
    || prepared.image !== EXPECTED_IMAGE
    || prepared.tag !== DROPLET_TAG
    || prepared.backupsEnabled !== false
    || prepared.monitoringEnabled !== false
  ) {
    throw new Error('prepared Droplet state differs from authorization');
  }
  const cloudInitPath = path.join(resolved, 'cloud-init.yaml');
  const publicKeyPath = path.join(resolved, 'operator.pub');
  const cloudInitStat = await lstat(cloudInitPath);
  const publicKeyStat = await lstat(publicKeyPath);
  const privateKeyStat = await lstat(path.join(resolved, 'operator'));
  if (
    !cloudInitStat.isFile()
    || cloudInitStat.isSymbolicLink()
    || (cloudInitStat.mode & 0o777) !== 0o600
    || !publicKeyStat.isFile()
    || publicKeyStat.isSymbolicLink()
    || (publicKeyStat.mode & 0o777) !== 0o600
    || !privateKeyStat.isFile()
    || privateKeyStat.isSymbolicLink()
    || (privateKeyStat.mode & 0o777) !== 0o600
    || typedSha256(await readFile(cloudInitPath))
      !== prepared.cloudInitSha256
    || typedSha256(
      Buffer.from((await readFile(publicKeyPath, 'utf8')).trim(), 'utf8'),
    ) !== prepared.sshPublicKeySha256
  ) {
    throw new Error('prepared Droplet files failed digest or mode validation');
  }
  const existing = parseDoctlJsonList(
    run(
      'doctl',
      [
        'compute',
        'droplet',
        'list',
        '--tag-name',
        DROPLET_TAG,
        '--output',
        'json',
      ],
      'pre-create Droplet inspection',
    ),
    'pre-create Droplet inspection',
  ).filter((entry) => entry.name === prepared.dropletName);
  if (existing.length !== 0) {
    throw new Error('approved E1 Droplet already exists');
  }
  let idOutput;
  try {
    idOutput = run(
      'doctl',
      [
        'compute',
        'droplet',
        'create',
        prepared.dropletName,
        '--region',
        EXPECTED_REGION,
        '--size',
        EXPECTED_SIZE,
        '--image',
        EXPECTED_IMAGE,
        '--tag-name',
        DROPLET_TAG,
        '--droplet-agent=false',
        '--user-data-file',
        cloudInitPath,
        '--wait',
        '--format',
        'ID',
        '--no-header',
      ],
      'approved E1 Droplet creation',
    );
  } catch (error) {
    const discovered = parseDoctlJsonList(
      run(
        'doctl',
        [
          'compute',
          'droplet',
          'list',
          '--tag-name',
          DROPLET_TAG,
          '--output',
          'json',
        ],
        'failed-create Droplet discovery',
      ),
      'failed-create Droplet discovery',
    ).filter((entry) => entry.name === prepared.dropletName);
    if (discovered.length === 1 && Number.isSafeInteger(discovered[0].id)) {
      await writeFile(
        path.join(resolved, 'pending-live-state.json'),
        JSON.stringify({
          schemaVersion: 1,
          authorizationId: AUTHORIZATION_ID,
          dropletId: discovered[0].id,
          dropletName: prepared.dropletName,
          cleanupRequired: true,
        }),
        { mode: 0o600, flag: 'wx' },
      );
    }
    throw error;
  }
  if (!/^\d+$/u.test(idOutput)) {
    throw new Error('Droplet creation returned an invalid identifier');
  }
  const pendingStatePath = path.join(resolved, 'pending-live-state.json');
  await writeFile(
    pendingStatePath,
    JSON.stringify({
      schemaVersion: 1,
      authorizationId: AUTHORIZATION_ID,
      dropletId: Number(idOutput),
      dropletName: prepared.dropletName,
      cleanupRequired: true,
    }),
    { mode: 0o600, flag: 'wx' },
  );
  const value = parseDoctlJson(
    run(
      'doctl',
      ['compute', 'droplet', 'get', idOutput, '--output', 'json'],
      'created Droplet inspection',
    ),
    'created Droplet inspection',
  );
  const droplet = validateDropletObject(value, prepared);
  const liveState = {
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    executorCommit,
    droplet,
    createdAt: new Date().toISOString(),
    automaticDestroyNoLaterThan: '2026-07-31T14:03:19Z',
    hourlyRateUsd: 0.00893,
  };
  await writeFile(
    path.join(resolved, 'live-state.json'),
    JSON.stringify(liveState),
    { mode: 0o600, flag: 'wx' },
  );
  await unlink(pendingStatePath);
  return liveState;
}

async function recordDns(boundary) {
  const resolved = await assertExistingBoundary(boundary);
  const liveStatePath = path.join(resolved, 'live-state.json');
  const liveState = await readMode0600Json(
    liveStatePath,
    'live Droplet state',
  );
  const suffix = liveState?.droplet?.name
    ?.match(/^am360-p4-e1-([0-9a-f]{8})$/u)?.[1];
  if (
    liveState?.authorizationId !== AUTHORIZATION_ID
    || liveState?.droplet?.status !== 'active'
    || !suffix
    || liveState.dns != null
  ) {
    throw new Error('live Droplet state cannot accept staging DNS');
  }
  const nextState = {
    ...liveState,
    dns: {
      provider: 'cloudflare',
      hostname: `packages-e1-${suffix}.agentmesh360.com`,
      proxied: false,
      recordedAt: new Date().toISOString(),
    },
  };
  await writeFile(liveStatePath, JSON.stringify(nextState), {
    mode: 0o600,
    flag: 'w',
  });
  await chmod(liveStatePath, 0o600);
  return nextState;
}

function parseDoctlJsonList(document, label) {
  let parsed;
  try {
    parsed = JSON.parse(document);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} returned an invalid collection`);
  }
  return parsed;
}

async function overwriteAndUnlink(filePath) {
  let handle;
  try {
    handle = await open(filePath, 'r+');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  try {
    const stat = await handle.stat();
    let offset = 0;
    while (offset < stat.size) {
      const length = Math.min(4096, stat.size - offset);
      const bytes = randomBytes(length);
      try {
        await handle.write(bytes, 0, length, offset);
      } finally {
        bytes.fill(0);
      }
      offset += length;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await unlink(filePath);
}

async function destroyDroplet(boundary) {
  const resolved = await assertExistingBoundary(boundary);
  let dropletId;
  try {
    const liveState = await readMode0600Json(
      path.join(resolved, 'live-state.json'),
      'live Droplet state',
    );
    dropletId = liveState?.droplet?.id;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const pendingState = await readMode0600Json(
      path.join(resolved, 'pending-live-state.json'),
      'pending live Droplet state',
    );
    dropletId = pendingState?.dropletId;
  }
  if (!Number.isSafeInteger(dropletId)) {
    throw new Error('live Droplet identifier is invalid');
  }
  run(
    'doctl',
    ['compute', 'droplet', 'delete', String(dropletId), '--force'],
    'approved E1 Droplet destruction',
  );
  const remaining = parseDoctlJsonList(
    run(
      'doctl',
      [
        'compute',
        'droplet',
        'list',
        '--tag-name',
        DROPLET_TAG,
        '--output',
        'json',
      ],
      'post-destroy Droplet inspection',
    ),
    'post-destroy Droplet inspection',
  ).filter((entry) => entry.id === dropletId);
  if (remaining.length !== 0) {
    throw new Error('E1 Droplet remains after destruction');
  }
  await overwriteAndUnlink(path.join(resolved, 'operator'));
  return {
    destroyed: true,
    ephemeralSshPrivateMaterialDestroyed: true,
  };
}

function parseArguments(argv) {
  const action = argv[0];
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value == null || values.has(key)) {
      throw new Error('invalid or duplicate argument');
    }
    values.set(key, value);
  }
  const boundary = values.get('--boundary');
  if (!boundary || !path.isAbsolute(boundary)) {
    throw new Error('absolute --boundary is required');
  }
  if (action === 'prepare') {
    if (
      values.size !== 2
      || !values.has('--credentials')
      || !path.isAbsolute(values.get('--credentials'))
    ) {
      throw new Error(
        'usage: droplet-boundary.mjs prepare --boundary <absolute> --credentials <absolute>',
      );
    }
    return {
      action,
      boundary,
      credentials: values.get('--credentials'),
    };
  }
  if (action === 'create') {
    if (values.size !== 2 || !values.has('--executor-commit')) {
      throw new Error(
        'usage: droplet-boundary.mjs create --boundary <absolute> --executor-commit <commit>',
      );
    }
    return {
      action,
      boundary,
      executorCommit: values.get('--executor-commit'),
    };
  }
  if (action === 'record-dns' && values.size === 1) {
    return { action, boundary };
  }
  if (action === 'destroy' && values.size === 1) {
    return { action, boundary };
  }
  throw new Error('Droplet boundary action is invalid');
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
    const task = options.action === 'prepare'
      ? prepareBoundary(options.boundary, options.credentials)
      : options.action === 'create'
        ? createDroplet(options.boundary, options.executorCommit)
        : options.action === 'record-dns'
          ? recordDns(options.boundary)
          : destroyDroplet(options.boundary);
    task
      .then((result) => {
        if (options.action === 'prepare') {
          console.log(
            'E1 Droplet boundary prepared; ephemeral SSH key is local only',
          );
        } else if (options.action === 'create') {
          console.log(
            'E1 Droplet active: SGP1, 1 GiB, no backups or monitoring',
          );
        } else if (options.action === 'record-dns') {
          console.log('E1 DNS-only staging boundary recorded');
        } else if (
          result.destroyed
          && result.ephemeralSshPrivateMaterialDestroyed
        ) {
          console.log('E1 Droplet and ephemeral SSH private key destroyed');
        }
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}

export {
  cloudInit,
  parseArguments,
  prepareBoundary,
  recordDns,
  sanitizedDiagnostic,
};
