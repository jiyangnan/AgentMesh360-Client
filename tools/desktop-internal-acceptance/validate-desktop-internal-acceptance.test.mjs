import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadAcceptanceSchema,
  validateDesktopInternalAcceptance,
  validateDesktopInternalAcceptanceFile,
} from './validate-desktop-internal-acceptance.mjs';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIRECTORY, '../..');
const ACCEPTANCE_PATH = path.join(
  REPOSITORY_ROOT,
  'docs/operations/tabletops/2026-07-30-p6-unsigned-internal-acceptance.json',
);

async function fixture() {
  return JSON.parse(await readFile(ACCEPTANCE_PATH, 'utf8'));
}

test('accepts the retained P6 unsigned internal acceptance', async () => {
  const result = await validateDesktopInternalAcceptanceFile();
  assert.deepEqual(result, {
    status: 'passed',
    acceptanceId: 'desktop_internal_p6_20260730_0001',
    distributionClass: 'unsigned_internal_only',
    scenarioCount: 11,
    productionR4Satisfied: false,
    seedDownloadCanaryAuthorized: false,
  });
});

test('schema and semantic validator pin exact artifact provenance', async () => {
  const schema = await loadAcceptanceSchema();
  const value = await fixture();
  assert.deepEqual(validateDesktopInternalAcceptance(value, schema), []);
  for (const mutate of [
    (copy) => { copy.artifact.commit = 'f'.repeat(40); },
    (copy) => { copy.artifact.buildReceiptSha256 = `sha256:${'f'.repeat(64)}`; },
    (copy) => { copy.artifact.zip.sha256 = `sha256:${'f'.repeat(64)}`; },
    (copy) => { copy.artifact.dmg.sha256 = `sha256:${'f'.repeat(64)}`; },
    (copy) => { copy.artifact.executorCommit = 'f'.repeat(40); },
    (copy) => { copy.artifact.version = '0.1.1'; },
    (copy) => { copy.artifact.architecture = 'x64'; },
    (copy) => { copy.artifact.zip.file = 'AgentMesh360-0.1.0-arm64-copy.zip'; },
    (copy) => { copy.artifact.zip.sizeBytes += 1; },
    (copy) => { copy.artifact.dmg.file = 'AgentMesh360-0.1.0-arm64-copy.dmg'; },
    (copy) => { copy.artifact.dmg.sizeBytes += 1; },
  ]) {
    const copy = structuredClone(value);
    mutate(copy);
    assert.ok(validateDesktopInternalAcceptance(copy, schema).length > 0);
  }
});

test('rejects matrix drift and fabricated Gatekeeper or production claims', async () => {
  const schema = await loadAcceptanceSchema();
  const value = await fixture();
  for (const mutate of [
    (copy) => { copy.matrix.scenarios.reverse(); },
    (copy) => { copy.matrix.passedCount = 10; },
    (copy) => { copy.gatekeeper.developerIdSigned = true; },
    (copy) => { copy.gatekeeper.quarantineDownloadUserFlowExecuted = true; },
    (copy) => { copy.gatekeeper.globalDisableRequired = true; },
    (copy) => { copy.productionBoundary.productionR4Satisfied = true; },
    (copy) => { copy.productionBoundary.p7Authorized = true; },
    (copy) => { copy.productionBoundary.seedDownloadCanaryAuthorized = true; },
  ]) {
    const copy = structuredClone(value);
    mutate(copy);
    assert.ok(validateDesktopInternalAcceptance(copy, schema).length > 0);
  }
});

test('rejects unknown fields, duplicate keys, symlinks, and oversized input', async () => {
  const schema = await loadAcceptanceSchema();
  const value = await fixture();
  const unknown = structuredClone(value);
  unknown.artifact.uploadUrl = 'forbidden';
  assert.ok(validateDesktopInternalAcceptance(unknown, schema).length > 0);

  const directory = await mkdtemp(path.join(os.tmpdir(), 'am360-p6-acceptance-'));
  try {
    const duplicate = path.join(directory, 'duplicate.json');
    await writeFile(
      duplicate,
      `{"schemaVersion":1,"schemaVersion":1}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      () => validateDesktopInternalAcceptanceFile(duplicate),
      /duplicate JSON object keys/u,
    );

    const link = path.join(directory, 'link.json');
    await symlink(ACCEPTANCE_PATH, link);
    await assert.rejects(
      () => validateDesktopInternalAcceptanceFile(link),
      /regular non-symlink/u,
    );

    const oversized = path.join(directory, 'oversized.json');
    await writeFile(oversized, Buffer.alloc(256 * 1024 + 1, 0x20), {
      mode: 0o600,
    });
    assert.equal((await lstat(oversized)).size, 256 * 1024 + 1);
    await assert.rejects(
      () => validateDesktopInternalAcceptanceFile(oversized),
      /bounded regular non-symlink/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
