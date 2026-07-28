import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(
  new URL('./e0-release-signer.mjs', import.meta.url),
);

function invoke(request) {
  return spawnSync(process.execPath, [WORKER], {
    encoding: 'utf8',
    input: JSON.stringify(request),
  });
}

test('sign and destroy refuse a symlinked private-material target', async () => {
  const boundary = await mkdtemp(
    path.join(os.tmpdir(), 'agentmesh360-release-provenance-e0-'),
  );
  const outside = await mkdtemp(path.join(os.tmpdir(), 'signer-outside-'));
  try {
    const outsideTarget = path.join(outside, 'outside.pk8');
    const target = path.join(boundary, 'publisher.pk8');
    await writeFile(outsideTarget, Buffer.alloc(48), { mode: 0o600 });
    await symlink(outsideTarget, target);

    const signResult = invoke({
      action: 'sign',
      boundary,
      payloadBase64: Buffer.from('safe payload').toString('base64'),
      target,
    });
    assert.notEqual(signResult.status, 0);

    const destroyResult = invoke({
      action: 'destroy',
      boundary,
      target,
    });
    assert.notEqual(destroyResult.status, 0);
  } finally {
    await rm(boundary, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('sign refuses permissive or oversized private-material files', async () => {
  const boundary = await mkdtemp(
    path.join(os.tmpdir(), 'agentmesh360-release-provenance-e0-'),
  );
  try {
    const target = path.join(boundary, 'publisher.pk8');
    await writeFile(target, Buffer.alloc(48), { mode: 0o600 });
    await chmod(target, 0o644);
    const permissive = invoke({
      action: 'sign',
      boundary,
      payloadBase64: Buffer.from('safe payload').toString('base64'),
      target,
    });
    assert.notEqual(permissive.status, 0);

    await writeFile(target, Buffer.alloc(4097), { mode: 0o600, flag: 'w' });
    await chmod(target, 0o600);
    const oversized = invoke({
      action: 'sign',
      boundary,
      payloadBase64: Buffer.from('safe payload').toString('base64'),
      target,
    });
    assert.notEqual(oversized.status, 0);
  } finally {
    await rm(boundary, { recursive: true, force: true });
  }
});

test('destroy is idempotent when private material is already absent', async () => {
  const boundary = await mkdtemp(
    path.join(os.tmpdir(), 'agentmesh360-release-provenance-e0-'),
  );
  try {
    const result = invoke({
      action: 'destroy',
      boundary,
      target: path.join(boundary, 'publisher.pk8'),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      destroyed: true,
      alreadyAbsent: true,
    });
  } finally {
    await rm(boundary, { recursive: true, force: true });
  }
});

test('E1 retained Release Set boundary accepts one generated temporary key', async () => {
  const boundary = await mkdtemp(
    path.join(os.tmpdir(), 'agentmesh360-release-provenance-e1-'),
  );
  try {
    const target = path.join(boundary, 'publisher.pk8');
    const generated = invoke({
      action: 'generate',
      boundary,
      target,
    });
    assert.equal(generated.status, 0, generated.stderr);
    const publicEvidence = JSON.parse(generated.stdout);
    assert.match(publicEvidence.publicKeyBase64, /^[A-Za-z0-9+/]{43}=$/u);
    const destroyed = invoke({
      action: 'destroy',
      boundary,
      target,
    });
    assert.equal(destroyed.status, 0, destroyed.stderr);
  } finally {
    await rm(boundary, { recursive: true, force: true });
  }
});
