import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
import { promisify } from 'node:util';

import {
  loadSeedDownloadPreflightSchema,
  validateSeedDownloadPreflight,
  validateSeedDownloadPreflightFile,
} from './validate-desktop-seed-download-preflight.mjs';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIRECTORY, '../..');
const PREFLIGHT_PATH = path.join(
  REPOSITORY_ROOT,
  'docs/templates/desktop-seed-download-preflight-v1.json',
);
const ACCEPTANCE_PATH = path.join(
  REPOSITORY_ROOT,
  'docs/operations/tabletops/2026-07-30-p6-unsigned-internal-acceptance.json',
);
const VALIDATOR_PATH = path.join(
  TEST_DIRECTORY,
  'validate-desktop-seed-download-preflight.mjs',
);
const execFileAsync = promisify(execFile);

async function fixture() {
  return JSON.parse(await readFile(PREFLIGHT_PATH, 'utf8'));
}

test('accepts the zero-authority seed download preflight', async () => {
  assert.deepEqual(await validateSeedDownloadPreflightFile(), {
    status: 'passed',
    preflightId: 'desktop_seed_download_p6_e0_20260730_0001',
    authority: 'none',
    approvalStatus: 'not_approved',
    executionStatus: 'blocked',
    scenarioCount: 9,
    networkRequests: 0,
    nextAction: 'obtain_separate_seed_download_canary_approval',
  });
});

test('binds the preflight to retained acceptance bytes and artifact provenance', async () => {
  const schema = await loadSeedDownloadPreflightSchema();
  const value = await fixture();
  assert.deepEqual(validateSeedDownloadPreflight(value, schema), []);
  for (const mutate of [
    (copy) => { copy.evidenceInput.acceptanceSha256 = `sha256:${'f'.repeat(64)}`; },
    (copy) => { copy.evidenceInput.artifactCommit = 'f'.repeat(40); },
    (copy) => { copy.evidenceInput.buildReceiptSha256 = `sha256:${'f'.repeat(64)}`; },
    (copy) => { copy.evidenceInput.zipSha256 = `sha256:${'f'.repeat(64)}`; },
    (copy) => { copy.evidenceInput.dmgSha256 = `sha256:${'f'.repeat(64)}`; },
  ]) {
    const copy = structuredClone(value);
    mutate(copy);
    assert.ok(validateSeedDownloadPreflight(copy, schema).length > 0);
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), 'am360-seed-bind-'));
  try {
    const driftedAcceptance = path.join(directory, 'acceptance.json');
    const acceptance = await readFile(ACCEPTANCE_PATH, 'utf8');
    await writeFile(driftedAcceptance, acceptance.replace(
      '"recordedAt": "2026-07-30T02:22:28.000Z"',
      '"recordedAt": "2026-07-30T02:22:29.000Z"',
    ));
    await assert.rejects(
      () => validateSeedDownloadPreflightFile(PREFLIGHT_PATH, {
        acceptancePath: driftedAcceptance,
      }),
      /not bound to the retained acceptance bytes/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects authority, channel, cohort, usage, and production drift', async () => {
  const schema = await loadSeedDownloadPreflightSchema();
  const value = await fixture();
  for (const mutate of [
    (copy) => { copy.authority = 'approved'; },
    (copy) => { copy.approvalStatus = 'approved'; },
    (copy) => { copy.executionStatus = 'passed'; },
    (copy) => { copy.channel.configured = true; },
    (copy) => { copy.channel.provider = 'digitalocean'; },
    (copy) => { copy.channel.artifactUploaded = true; },
    (copy) => { copy.channel.publicVisible = true; },
    (copy) => { copy.cohort.accountCount = 1; },
    (copy) => { copy.cohort.deviceCount = 1; },
    (copy) => { copy.budget.providerRequests = 1; },
    (copy) => { copy.budget.agentMeshCredits = 1; },
    (copy) => { copy.budget.uploadRequests = 1; },
    (copy) => { copy.networkBoundary.uploadAuthorized = true; },
    (copy) => { copy.networkBoundary.productionMutationAuthorized = true; },
  ]) {
    const copy = structuredClone(value);
    mutate(copy);
    assert.ok(validateSeedDownloadPreflight(copy, schema).length > 0);
  }
});

test('rejects weakened Gatekeeper, signing, updater, or login safety', async () => {
  const schema = await loadSeedDownloadPreflightSchema();
  const value = await fixture();
  for (const key of Object.keys(value.safetyPolicy)) {
    const copy = structuredClone(value);
    copy.safetyPolicy[key] = !copy.safetyPolicy[key];
    assert.ok(
      validateSeedDownloadPreflight(copy, schema).length > 0,
      `${key} must remain fixed`,
    );
  }
});

test('pins the exact blocked scenarios, retained evidence, and stop conditions', async () => {
  const schema = await loadSeedDownloadPreflightSchema();
  const value = await fixture();
  for (const mutate of [
    (copy) => { copy.scenarioMatrix.reverse(); },
    (copy) => { copy.scenarioMatrix[0].status = 'passed'; },
    (copy) => { copy.scenarioMatrix[0].reason = 'channel_unapproved'; },
    (copy) => { copy.evidencePolicy.retainedFields.reverse(); },
    (copy) => { copy.evidencePolicy.retainSecrets = true; },
    (copy) => { copy.stopConditions.reverse(); },
    (copy) => { copy.stopConditions[0] = 'unknown_condition'; },
  ]) {
    const copy = structuredClone(value);
    mutate(copy);
    assert.ok(validateSeedDownloadPreflight(copy, schema).length > 0);
  }
});

test('validator has no network, subprocess, keychain, or upload capability', async () => {
  const source = await readFile(VALIDATOR_PATH, 'utf8');
  for (const forbidden of [
    /node:https/u,
    /node:http/u,
    /node:net/u,
    /child_process/u,
    /\bfetch\s*\(/u,
    /\bspawn\s*\(/u,
    /\bexecFile\s*\(/u,
    /\bsecurity\b/u,
    /\bkeychain\b/iu,
    /\bupload\b.*\(/iu,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test('CLI succeeds safely and does not disclose a rejected input path', async () => {
  const success = await execFileAsync(process.execPath, [VALIDATOR_PATH], {
    cwd: REPOSITORY_ROOT,
  });
  assert.deepEqual(JSON.parse(success.stdout), {
    status: 'passed',
    preflightId: 'desktop_seed_download_p6_e0_20260730_0001',
    authority: 'none',
    approvalStatus: 'not_approved',
    executionStatus: 'blocked',
    scenarioCount: 9,
    networkRequests: 0,
    nextAction: 'obtain_separate_seed_download_canary_approval',
  });

  const directory = await mkdtemp(path.join(os.tmpdir(), 'am360-seed-cli-'));
  try {
    const unsafePath = path.join(directory, 'sensitive-client-account.json');
    await writeFile(unsafePath, '{}\n', { mode: 0o600 });
    await assert.rejects(
      () => execFileAsync(process.execPath, [VALIDATOR_PATH, unsafePath], {
        cwd: REPOSITORY_ROOT,
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.doesNotMatch(error.stderr, new RegExp(unsafePath, 'u'));
        assert.match(error.stderr, /preflight is invalid/u);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects unknown fields, duplicate keys, symlinks, invalid UTF-8, and oversized input', async () => {
  const schema = await loadSeedDownloadPreflightSchema();
  const value = await fixture();
  const unknown = structuredClone(value);
  unknown.channel.uploadUrl = 'forbidden';
  assert.ok(validateSeedDownloadPreflight(unknown, schema).length > 0);

  const directory = await mkdtemp(path.join(os.tmpdir(), 'am360-seed-input-'));
  try {
    const duplicate = path.join(directory, 'duplicate.json');
    await writeFile(
      duplicate,
      '{"schemaVersion":1,"schemaVersion":1}\n',
      { mode: 0o600 },
    );
    await assert.rejects(
      () => validateSeedDownloadPreflightFile(duplicate),
      /duplicate JSON object keys/u,
    );

    const link = path.join(directory, 'link.json');
    await symlink(PREFLIGHT_PATH, link);
    await assert.rejects(
      () => validateSeedDownloadPreflightFile(link),
      /regular non-symlink/u,
    );

    const invalidUtf8 = path.join(directory, 'invalid-utf8.json');
    await writeFile(invalidUtf8, Buffer.from([0xc3, 0x28]), { mode: 0o600 });
    await assert.rejects(
      () => validateSeedDownloadPreflightFile(invalidUtf8),
      /valid UTF-8/u,
    );

    const oversized = path.join(directory, 'oversized.json');
    await writeFile(oversized, Buffer.alloc(256 * 1024 + 1, 0x20), {
      mode: 0o600,
    });
    assert.equal((await lstat(oversized)).size, 256 * 1024 + 1);
    await assert.rejects(
      () => validateSeedDownloadPreflightFile(oversized),
      /bounded regular non-symlink/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
