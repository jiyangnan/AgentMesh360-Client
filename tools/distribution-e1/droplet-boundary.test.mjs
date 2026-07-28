import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  cloudInit,
  parseArguments,
  prepareBoundary,
  sanitizedDiagnostic,
  validateDropletObject,
} from './droplet-boundary.mjs';

function credentials() {
  return {
    region: 'sgp1',
    endpoint: 'sgp1.digitaloceanspaces.com',
    releasesBucket: 'am360-e1-releases-1234abcd',
    metadataBucket: 'am360-e1-metadata-1234abcd',
    publisher: {
      keyName: 'am360-p4-e1-publisher-1234abcd',
      accessKeyId: 'A'.repeat(20),
      secretAccessKey: 'c'.repeat(43),
    },
    originReader: {
      keyName: 'am360-p4-e1-origin-1234abcd',
      accessKeyId: 'B'.repeat(20),
      secretAccessKey: 'd'.repeat(43),
    },
  };
}

test('cloud-init pins SSH-only boundary, required packages, and firewall', () => {
  const value = cloudInit(
    `ssh-ed25519 ${Buffer.alloc(32).toString('base64')} agentmesh360-p4-e1`,
  );
  assert.match(value, /ssh_pwauth: false/u);
  assert.match(value, /disable_root: false/u);
  assert.match(value, /agentmesh360-p4-e1/u);
  assert.match(value, /- nodejs/u);
  assert.match(value, /\[ufw, allow, 22\/tcp\]/u);
  assert.match(value, /\[ufw, allow, 80\/tcp\]/u);
  assert.match(value, /\[ufw, allow, 443\/tcp\]/u);
  assert.doesNotMatch(value, /password/u);
});

test('prepares a mode-0700 boundary with local ephemeral SSH material', async () => {
  const parent = await mkdtemp('/private/tmp/agentmesh360-droplet-parent-');
  const boundary = path.join(
    '/private/tmp',
    `agentmesh360-distribution-e1-${path.basename(parent).slice(-8)}`,
  );
  const credentialPath = path.join(parent, 'credentials.json');
  try {
    await writeFile(credentialPath, JSON.stringify(credentials()), {
      mode: 0o600,
      flag: 'wx',
    });
    const result = await prepareBoundary(boundary, credentialPath);
    assert.equal(result.dropletName, 'am360-p4-e1-1234abcd');
    assert.equal(result.region, 'sgp1');
    assert.equal(result.size, 's-1vcpu-1gb');
    assert.equal(result.backupsEnabled, false);
    assert.equal(result.monitoringEnabled, false);
    assert.equal((await lstat(boundary)).mode & 0o777, 0o700);
    assert.equal((await lstat(path.join(boundary, 'operator'))).mode & 0o777, 0o600);
    assert.equal(
      (await lstat(path.join(boundary, 'cloud-init.yaml'))).mode & 0o777,
      0o600,
    );
    const privateBytes = await readFile(path.join(boundary, 'operator'));
    const cloudBytes = await readFile(path.join(boundary, 'cloud-init.yaml'));
    assert.ok(privateBytes.length > 0);
    assert.ok(!cloudBytes.includes(privateBytes));
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(boundary, { recursive: true, force: true });
  }
});

test('rejects permissive credential files before preparing a boundary', async () => {
  const parent = await mkdtemp('/private/tmp/agentmesh360-droplet-parent-');
  const boundary = path.join(
    '/private/tmp',
    `agentmesh360-distribution-e1-${path.basename(parent).slice(-8)}`,
  );
  const credentialPath = path.join(parent, 'credentials.json');
  try {
    await writeFile(credentialPath, JSON.stringify(credentials()), {
      mode: 0o600,
      flag: 'wx',
    });
    await chmod(credentialPath, 0o644);
    await assert.rejects(
      prepareBoundary(boundary, credentialPath),
      /mode-0600/u,
    );
    await assert.rejects(lstat(boundary), { code: 'ENOENT' });
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(boundary, { recursive: true, force: true });
  }
});

test('validates only the approved active Droplet shape', () => {
  const prepared = { dropletName: 'am360-p4-e1-1234abcd' };
  const droplet = {
    id: 123,
    name: prepared.dropletName,
    region: { slug: 'sgp1' },
    size_slug: 's-1vcpu-1gb',
    memory: 1024,
    vcpus: 1,
    disk: 25,
    status: 'active',
    features: [],
    networks: {
      v4: [{ type: 'public', ip_address: '203.0.113.10' }],
    },
  };
  assert.equal(validateDropletObject(droplet, prepared).memoryMiB, 1024);
  for (const mutate of [
    (value) => {
      value.size_slug = 's-1vcpu-2gb';
    },
    (value) => {
      value.region = { slug: 'nyc3' };
    },
    (value) => {
      value.features = ['backups'];
    },
    (value) => {
      value.status = 'new';
    },
  ]) {
    const value = structuredClone(droplet);
    mutate(value);
    assert.throws(() => validateDropletObject(value, prepared));
  }
});

test('parses strict prepare, create, and destroy commands', () => {
  assert.deepEqual(
    parseArguments([
      'prepare',
      '--boundary',
      '/private/tmp/agentmesh360-distribution-e1-current',
      '--credentials',
      '/private/tmp/credentials.json',
    ]).action,
    'prepare',
  );
  assert.deepEqual(
    parseArguments([
      'create',
      '--boundary',
      '/private/tmp/agentmesh360-distribution-e1-current',
      '--executor-commit',
      'a'.repeat(40),
    ]).action,
    'create',
  );
  assert.deepEqual(
    parseArguments([
      'destroy',
      '--boundary',
      '/private/tmp/agentmesh360-distribution-e1-current',
    ]).action,
    'destroy',
  );
  assert.throws(() =>
    parseArguments([
      'create',
      '--boundary',
      'relative',
      '--executor-commit',
      'a'.repeat(40),
    ]));
});

test('sanitizes paths, IPs, and credential IDs from command diagnostics', () => {
  const diagnostic = sanitizedDiagnostic(
    'failed /Users/example/private 203.0.113.10 AAAAAAAAAAAAAAAAAAAA',
  );
  assert.doesNotMatch(diagnostic, /Users/u);
  assert.doesNotMatch(diagnostic, /203\.0\.113\.10/u);
  assert.doesNotMatch(diagnostic, /A{20}/u);
});
