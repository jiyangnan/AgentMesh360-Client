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
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  readCredentialFile,
  runAccessProbe,
} from '../distribution-e1/spaces-client.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const PREFLIGHT_PATH = path.join(
  REPOSITORY_ROOT,
  'docs/operations/tabletops/2026-07-29-p5-release-chain-preflight.json',
);
const AUTHORIZATION_PATH = path.join(
  REPOSITORY_ROOT,
  'docs/operations/tabletops/2026-07-29-p5-owner-account-e1-authorization.json',
);
const AUTHORIZATION_ID = 'package_canary_e1_20260729_0002';
const BOUNDARY = '/private/tmp/agentmesh360-p5-e1-infrastructure';
const CREDENTIAL_PATH =
  '/private/tmp/agentmesh360-p5-e1-spaces-credentials.json';
const CLOUDFLARE_STATE_PATH =
  '/private/tmp/agentmesh360-p5-e1-cloudflare-state.json';
const DROPLET_TAG = 'agentmesh360-p5-e1';
const EXPECTED_REGION = 'sgp1';
const EXPECTED_SIZE = 's-1vcpu-1gb';
const EXPECTED_IMAGE = 'ubuntu-24-04-x64';
const SSH_OPERATOR = 'agentmesh-operator';
const MAX_FILE_BYTES = 256 * 1024;
const MAX_COMMAND_BYTES = 4 * 1024 * 1024;

function typedSha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sanitizedDiagnostic(stderr) {
  if (typeof stderr !== 'string') return '';
  return (stderr
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1) ?? '')
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
    maxBuffer: MAX_COMMAND_BYTES,
  });
  if (result.error || result.status !== 0) {
    const diagnostic = sanitizedDiagnostic(result.stderr);
    throw new Error(
      diagnostic ? `${label} failed: ${diagnostic}` : `${label} failed`,
    );
  }
  return result.stdout.trim();
}

async function readMode0600Json(filePath, label) {
  const info = await lstat(filePath);
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || info.size <= 0
    || info.size > MAX_FILE_BYTES
    || (info.mode & 0o777) !== 0o600
  ) {
    throw new Error(`${label} must be a bounded mode-0600 regular file`);
  }
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
}

async function readRetainedPreflight() {
  const [info, authorizationInfo] = await Promise.all([
    lstat(PREFLIGHT_PATH),
    lstat(AUTHORIZATION_PATH),
  ]);
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || info.size <= 0
    || info.size > MAX_FILE_BYTES
    || !authorizationInfo.isFile()
    || authorizationInfo.isSymbolicLink()
    || authorizationInfo.size <= 0
    || authorizationInfo.size > MAX_FILE_BYTES
  ) {
    throw new Error('P5 release-chain authority is invalid');
  }
  const [preflightBytes, authorizationBytes] = await Promise.all([
    readFile(PREFLIGHT_PATH),
    readFile(AUTHORIZATION_PATH),
  ]);
  let value;
  let authorization;
  try {
    value = JSON.parse(preflightBytes.toString('utf8'));
    authorization = JSON.parse(authorizationBytes.toString('utf8'));
  } catch {
    throw new Error('P5 release-chain authority is invalid JSON');
  }
  const startsAt = Date.parse(authorization.authorizationWindow?.startsAt);
  const stopsAt = Date.parse(authorization.authorizationWindow?.stopsAt);
  const now = Date.now();
  if (
    value.authorizationId !== AUTHORIZATION_ID
    || value.executionStatus !== 'release_chain_preflight_passed'
    || value.gates?.cloudCreationAllowed !== true
    || value.infrastructure?.stagingDropletCount !== 1
    || value.infrastructure?.stagingDropletSize !== EXPECTED_SIZE
    || value.infrastructure?.spacesBucketCount !== 2
    || value.infrastructure?.cloudflareDnsRecordCount !== 1
    || value.infrastructure?.hardCapUsd !== 3
    || value.infrastructure?.destroyAtEnd !== true
    || value.authority?.productionAuthorityGranted !== false
    || value.authority?.productionDropletReusable !== false
    || value.inputDigests?.authorizationSha256
      !== typedSha256(authorizationBytes)
    || authorization.authorizationId !== AUTHORIZATION_ID
    || authorization.approvalStatus !== 'approved'
    || authorization.executionStatus !== 'authorized_not_started'
    || authorization.infrastructurePlan?.stagingDropletCount !== 1
    || authorization.infrastructurePlan?.spacesBucketCount !== 2
    || authorization.infrastructurePlan?.cloudflareDnsRecordCount !== 1
    || authorization.infrastructurePlan?.hardCapUsd !== 3
    || authorization.approvalReceipt?.productionAuthorityGranted !== false
    || !Number.isFinite(startsAt)
    || !Number.isFinite(stopsAt)
    || stopsAt - startsAt !== 72 * 60 * 60 * 1000
    || now < startsAt
    || now >= stopsAt
  ) {
    throw new Error('P5 preflight does not permit infrastructure creation');
  }
  return {
    preflight: value,
    automaticDestroyNoLaterThan:
      authorization.authorizationWindow.stopsAt,
  };
}

function assertFrozenExecutor(executorCommit, preflightCommit) {
  if (
    !/^[0-9a-f]{40}$/u.test(executorCommit)
    || run('git', ['rev-parse', 'HEAD'], 'executor commit inspection', {
      cwd: REPOSITORY_ROOT,
    }) !== executorCommit
    || run('git', ['rev-parse', 'origin/main'], 'origin commit inspection', {
      cwd: REPOSITORY_ROOT,
    }) !== executorCommit
    || run(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      'executor clean-tree inspection',
      { cwd: REPOSITORY_ROOT },
    ) !== ''
  ) {
    throw new Error('P5 infrastructure executor is not the clean pushed commit');
  }
  const ancestor = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', preflightCommit, executorCommit],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8' },
  );
  if (ancestor.error || ancestor.status !== 0) {
    throw new Error('P5 release-chain preflight is not an executor ancestor');
  }
}

async function assertP5ExecutionAuthority(executorCommit) {
  const authority = await readRetainedPreflight();
  assertFrozenExecutor(executorCommit, authority.preflight.executorCommit);
  return authority;
}

function cloudInit(publicKey) {
  if (
    typeof publicKey !== 'string'
    || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2} agentmesh360-p5-e1$/u
      .test(publicKey)
  ) {
    throw new Error('ephemeral SSH public key is invalid');
  }
  return `#cloud-config
disable_root: true
ssh_pwauth: false
users:
  - name: ${SSH_OPERATOR}
    gecos: AgentMesh360 P5 E1 operator
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

async function assertNewBoundary() {
  try {
    await lstat(BOUNDARY);
    throw new Error('P5 infrastructure boundary already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(BOUNDARY, { mode: 0o700 });
  const resolved = await realpath(BOUNDARY);
  if (
    resolved !== BOUNDARY
    || path.dirname(resolved) !== '/private/tmp'
  ) {
    throw new Error('P5 infrastructure boundary escaped private tmp');
  }
  return resolved;
}

async function assertExistingBoundary() {
  const direct = await lstat(BOUNDARY);
  const resolved = await realpath(BOUNDARY);
  if (
    resolved !== BOUNDARY
    || !direct.isDirectory()
    || direct.isSymbolicLink()
    || (direct.mode & 0o777) !== 0o700
  ) {
    throw new Error('P5 infrastructure boundary is invalid');
  }
  return resolved;
}

function suffixFromCredentials(credentials) {
  const match =
    /^am360-p5-e1-releases-([0-9a-f]{8})$/u.exec(
      credentials.releasesBucket,
    );
  if (
    !match
    || credentials.metadataBucket !== `am360-p5-e1-metadata-${match[1]}`
    || credentials.publisher.keyName
      !== `am360-p5-e1-publisher-${match[1]}`
    || credentials.originReader.keyName
      !== `am360-p5-e1-origin-${match[1]}`
  ) {
    throw new Error('P5 Spaces credential namespace is invalid');
  }
  return match[1];
}

async function probeSpaces(executorCommit) {
  await assertP5ExecutionAuthority(executorCommit);
  const credentials = await readCredentialFile(CREDENTIAL_PATH);
  suffixFromCredentials(credentials);
  await runAccessProbe(credentials);
  return { passed: true };
}

async function prepareBoundary(executorCommit) {
  const {
    preflight,
    automaticDestroyNoLaterThan,
  } = await assertP5ExecutionAuthority(executorCommit);
  const credentials = await readCredentialFile(CREDENTIAL_PATH);
  const suffix = suffixFromCredentials(credentials);
  const boundary = await assertNewBoundary();
  const privateKey = path.join(boundary, 'operator');
  const publicKeyPath = `${privateKey}.pub`;
  const cloudInitPath = path.join(boundary, 'cloud-init.yaml');
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
        'agentmesh360-p5-e1',
        '-f',
        privateKey,
      ],
      'ephemeral SSH key generation',
    );
    await chmod(privateKey, 0o600);
    await chmod(publicKeyPath, 0o600);
    const publicKey = (await readFile(publicKeyPath, 'utf8')).trim();
    await writeFile(cloudInitPath, cloudInit(publicKey), {
      mode: 0o600,
      flag: 'wx',
    });
    const state = {
      schemaVersion: 1,
      authorizationId: AUTHORIZATION_ID,
      executionStatus: 'infrastructure_prepared',
      executorCommit,
      preflightCommit: preflight.executorCommit,
      suffix,
      dropletName: `am360-p5-e1-${suffix}`,
      hostname: `packages-p5-e1-${suffix}.agentmesh360.com`,
      tag: DROPLET_TAG,
      region: EXPECTED_REGION,
      size: EXPECTED_SIZE,
      image: EXPECTED_IMAGE,
      dropletCount: 1,
      spacesBucketCount: 2,
      dnsRecordCount: 1,
      backupsEnabled: false,
      monitoringEnabled: false,
      automaticDestroyNoLaterThan,
      sshPublicKeySha256: typedSha256(Buffer.from(publicKey, 'utf8')),
      cloudInitSha256: typedSha256(await readFile(cloudInitPath)),
      cleanupRequired: true,
      preparedAt: new Date().toISOString(),
    };
    await writeFile(
      path.join(boundary, 'prepared-state.json'),
      JSON.stringify(state),
      { mode: 0o600, flag: 'wx' },
    );
    return state;
  } catch (error) {
    await rm(boundary, { recursive: true, force: true });
    throw error;
  }
}

function parseDoctlList(document, label) {
  let value;
  try {
    value = JSON.parse(document);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} returned an invalid list`);
  }
  return value;
}

function exactTaggedDroplets(document, dropletName, label) {
  return parseDoctlList(document, label).filter(
    (entry) =>
      entry?.name === dropletName
      && Number.isSafeInteger(entry?.id),
  );
}

async function assertAbsent(filePath, label) {
  try {
    await lstat(filePath);
    throw new Error(`${label} already exists`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
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
    const info = await handle.stat();
    let offset = 0;
    while (offset < info.size) {
      const length = Math.min(4096, info.size - offset);
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

function pendingDropletState(prepared, dropletId = null) {
  if (
    prepared?.authorizationId !== AUTHORIZATION_ID
    || !/^am360-p5-e1-[0-9a-f]{8}$/u.test(prepared?.dropletName ?? '')
    || (
      dropletId !== null
      && !Number.isSafeInteger(dropletId)
    )
  ) {
    throw new Error('pending P5 Droplet state is invalid');
  }
  return {
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    executionStatus: dropletId === null
      ? 'droplet_creation_pending'
      : 'droplet_created_pending_validation',
    dropletId,
    dropletName: prepared.dropletName,
    cleanupRequired: true,
  };
}

function validateDropletObject(value, prepared) {
  const publicNetwork = value.networks?.v4?.find(
    (network) => network.type === 'public',
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
    throw new Error('created Droplet differs from the approved P5 E1 boundary');
  }
  return {
    id: value.id,
    name: value.name,
    publicIpv4: publicNetwork.ip_address,
    status: value.status,
  };
}

async function createDroplet(executorCommit) {
  const boundary = await assertExistingBoundary();
  const {
    automaticDestroyNoLaterThan,
  } = await assertP5ExecutionAuthority(executorCommit);
  const prepared = await readMode0600Json(
    path.join(boundary, 'prepared-state.json'),
    'prepared P5 infrastructure state',
  );
  if (
    prepared.authorizationId !== AUTHORIZATION_ID
    || prepared.executionStatus !== 'infrastructure_prepared'
    || prepared.executorCommit !== executorCommit
    || prepared.tag !== DROPLET_TAG
    || prepared.region !== EXPECTED_REGION
    || prepared.size !== EXPECTED_SIZE
    || prepared.image !== EXPECTED_IMAGE
    || prepared.backupsEnabled !== false
    || prepared.monitoringEnabled !== false
    || prepared.automaticDestroyNoLaterThan !== automaticDestroyNoLaterThan
  ) {
    throw new Error('prepared P5 infrastructure state drift');
  }
  const liveStatePath = path.join(boundary, 'live-state.json');
  const pendingStatePath = path.join(boundary, 'pending-live-state.json');
  await assertAbsent(liveStatePath, 'live P5 infrastructure state');
  await assertAbsent(pendingStatePath, 'pending P5 infrastructure state');
  const cloudInitPath = path.join(boundary, 'cloud-init.yaml');
  if (
    typedSha256(await readFile(cloudInitPath)) !== prepared.cloudInitSha256
    || typedSha256(Buffer.from(
      (await readFile(path.join(boundary, 'operator.pub'), 'utf8')).trim(),
      'utf8',
    )) !== prepared.sshPublicKeySha256
  ) {
    throw new Error('P5 SSH or cloud-init digest drift');
  }
  const existing = parseDoctlList(
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
  );
  if (existing.length !== 0) {
    throw new Error('approved P5 E1 Droplet already exists');
  }
  await writeFile(
    pendingStatePath,
    JSON.stringify(pendingDropletState(prepared)),
    { mode: 0o600, flag: 'wx' },
  );
  let id;
  try {
    const idOutput = run(
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
      'approved P5 E1 Droplet creation',
    );
    if (/^\d+$/u.test(idOutput)) {
      id = Number(idOutput);
    }
  } catch (error) {
    const discovered = exactTaggedDroplets(
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
      prepared.dropletName,
      'failed-create Droplet discovery',
    );
    if (discovered.length === 1) {
      await writeFile(
        pendingStatePath,
        JSON.stringify(pendingDropletState(prepared, discovered[0].id)),
        { mode: 0o600 },
      );
    }
    throw error;
  }
  if (!Number.isSafeInteger(id)) {
    const discovered = exactTaggedDroplets(
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
        'invalid-create Droplet discovery',
      ),
      prepared.dropletName,
      'invalid-create Droplet discovery',
    );
    if (discovered.length === 1) {
      id = discovered[0].id;
    } else {
      throw new Error('Droplet creation returned an invalid identifier');
    }
  }
  const pendingState = pendingDropletState(prepared, id);
  await writeFile(
    pendingStatePath,
    JSON.stringify(pendingState),
    { mode: 0o600 },
  );
  const details = parseDoctlList(
    run(
      'doctl',
      ['compute', 'droplet', 'get', String(id), '--output', 'json'],
      'created Droplet inspection',
    ),
    'created Droplet inspection',
  );
  if (details.length !== 1) {
    throw new Error('created Droplet inspection returned an invalid count');
  }
  const droplet = validateDropletObject(details[0], prepared);
  const live = {
    ...pendingState,
    executionStatus: 'droplet_active',
    executorCommit,
    droplet,
    suffix: prepared.suffix,
    hostname: prepared.hostname,
    region: EXPECTED_REGION,
    size: EXPECTED_SIZE,
    image: EXPECTED_IMAGE,
    spacesBucketCount: 2,
    dnsRecordCount: 1,
    backupsEnabled: false,
    monitoringEnabled: false,
    automaticDestroyNoLaterThan,
    createdAt: new Date().toISOString(),
  };
  await writeFile(
    liveStatePath,
    JSON.stringify(live),
    { mode: 0o600, flag: 'wx' },
  );
  await unlink(pendingStatePath);
  return live;
}

function validateCloudflareState(value, live) {
  const keys = [
    'hostname',
    'ipv4',
    'proxied',
    'recordId',
    'ttlSeconds',
    'zoneId',
  ];
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join('\n') !== keys.join('\n')
    || value.hostname !== live.hostname
    || value.ipv4 !== live.droplet?.publicIpv4
    || value.proxied !== false
    || value.ttlSeconds !== 60
    || !/^[0-9a-f]{32}$/u.test(value.zoneId)
    || !/^[0-9a-f]{32}$/u.test(value.recordId)
  ) {
    throw new Error('Cloudflare state differs from the P5 DNS-only boundary');
  }
  return value;
}

async function recordDns(executorCommit) {
  const boundary = await assertExistingBoundary();
  await assertP5ExecutionAuthority(executorCommit);
  const [live, cloudflare] = await Promise.all([
    readMode0600Json(
      path.join(boundary, 'live-state.json'),
      'live P5 infrastructure state',
    ),
    readMode0600Json(CLOUDFLARE_STATE_PATH, 'Cloudflare P5 state'),
  ]);
  if (
    live.authorizationId !== AUTHORIZATION_ID
    || live.executionStatus !== 'droplet_active'
    || live.executorCommit !== executorCommit
  ) {
    throw new Error('live P5 infrastructure state is not ready for DNS');
  }
  validateCloudflareState(cloudflare, live);
  const state = {
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    executionStatus: 'dns_recorded',
    executorCommit: live.executorCommit,
    infrastructure: {
      dropletCount: 1,
      spacesBucketCount: 2,
      cloudflareDnsRecordCount: 1,
    },
    droplet: live.droplet,
    dns: cloudflare,
    automaticDestroyNoLaterThan: live.automaticDestroyNoLaterThan,
    cleanupRequired: true,
    recordedAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(boundary, 'dns-state.json'),
    JSON.stringify(state),
    { mode: 0o600, flag: 'wx' },
  );
  return state;
}

async function destroyDroplet() {
  const boundary = await assertExistingBoundary();
  const prepared = await readMode0600Json(
    path.join(boundary, 'prepared-state.json'),
    'prepared P5 infrastructure cleanup state',
  );
  if (
    prepared.authorizationId !== AUTHORIZATION_ID
    || prepared.tag !== DROPLET_TAG
    || !/^am360-p5-e1-[0-9a-f]{8}$/u.test(prepared.dropletName ?? '')
  ) {
    throw new Error('prepared P5 infrastructure cleanup state is invalid');
  }
  let recordedId = null;
  for (const fileName of ['live-state.json', 'pending-live-state.json']) {
    try {
      const state = await readMode0600Json(
        path.join(boundary, fileName),
        'P5 Droplet cleanup state',
      );
      if (
        state.authorizationId === AUTHORIZATION_ID
        && state.dropletName === prepared.dropletName
        && (
          state.dropletId === null
          || Number.isSafeInteger(state.dropletId)
        )
      ) {
        recordedId = state.dropletId;
        break;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        recordedId = null;
        break;
      }
    }
  }
  const matching = exactTaggedDroplets(
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
      'pre-destroy Droplet inspection',
    ),
    prepared.dropletName,
    'pre-destroy Droplet inspection',
  );
  if (matching.length > 1) {
    throw new Error('P5 Droplet cleanup discovery is ambiguous');
  }
  if (
    recordedId !== null
    && matching.length === 1
    && matching[0].id !== recordedId
  ) {
    throw new Error('P5 Droplet cleanup identifier drift');
  }
  if (matching.length === 1) {
    run(
      'doctl',
      ['compute', 'droplet', 'delete', String(matching[0].id), '--force'],
      'P5 E1 Droplet destruction',
    );
  }
  const remaining = parseDoctlList(
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
  );
  if (remaining.length !== 0) {
    throw new Error('P5 E1 Droplet still exists after destruction');
  }
  await overwriteAndUnlink(path.join(boundary, 'operator'));
  return {
    destroyed: true,
    ephemeralSshPrivateMaterialDestroyed: true,
  };
}

function parseArguments(argv) {
  const [action, flag, value, extra] = argv;
  if (extra) throw new Error('P5 infrastructure action is invalid');
  if (
    ['probe-spaces', 'prepare', 'create', 'record-dns'].includes(action)
    && flag === '--executor-commit'
    && /^[0-9a-f]{40}$/u.test(value ?? '')
  ) {
    return { action, executorCommit: value };
  }
  if (action === 'destroy' && flag == null) {
    return { action };
  }
  throw new Error(
    'usage: infrastructure-boundary.mjs '
    + '<destroy> OR '
    + '<probe-spaces|prepare|create|record-dns> '
    + '--executor-commit <commit>',
  );
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
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
  if (options) {
    const task = options.action === 'probe-spaces'
      ? probeSpaces(options.executorCommit)
      : options.action === 'prepare'
        ? prepareBoundary(options.executorCommit)
        : options.action === 'create'
          ? createDroplet(options.executorCommit)
          : options.action === 'record-dns'
            ? recordDns(options.executorCommit)
            : destroyDroplet();
    task
      .then(() => {
        process.stdout.write(
          `P5 E1 infrastructure action ${options.action} passed\n`,
        );
      })
      .catch(() => {
        process.stderr.write(
          `P5 E1 infrastructure action ${options.action} failed\n`,
        );
        process.exitCode = 1;
      });
  }
}

export {
  AUTHORIZATION_ID,
  BOUNDARY,
  CLOUDFLARE_STATE_PATH,
  CREDENTIAL_PATH,
  assertP5ExecutionAuthority,
  cloudInit,
  exactTaggedDroplets,
  parseArguments,
  pendingDropletState,
  sanitizedDiagnostic,
  suffixFromCredentials,
  validateCloudflareState,
  validateDropletObject,
};
