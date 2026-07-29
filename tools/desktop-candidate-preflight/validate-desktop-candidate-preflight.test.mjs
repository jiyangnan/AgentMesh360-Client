import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import {
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  validateDesktopCandidatePreflight,
  validateDesktopCandidatePreflightFile,
} from './validate-desktop-candidate-preflight.mjs';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIRECTORY, '../..');
const VALIDATOR = path.join(
  TEST_DIRECTORY,
  'validate-desktop-candidate-preflight.mjs',
);
const TEMPLATE = path.join(
  REPOSITORY_ROOT,
  'docs/templates/desktop-candidate-preflight-v1.json',
);
const P5_CLEANUP = path.join(
  REPOSITORY_ROOT,
  'docs/operations/tabletops/2026-07-29-p5-e1-local-cleanup.json',
);
const DESKTOP_PACKAGE = path.join(REPOSITORY_ROOT, 'desktop/package.json');
const DESKTOP_LOCK = path.join(REPOSITORY_ROOT, 'desktop/package-lock.json');
const TEMPLATE_VALUE = JSON.parse(readFileSync(TEMPLATE, 'utf8'));

function validPreflight() {
  return structuredClone(TEMPLATE_VALUE);
}

function sha256File(filePath) {
  return `sha256:${createHash('sha256')
    .update(readFileSync(filePath))
    .digest('hex')}`;
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'agentmesh360-p6-preflight-test-'),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('accepts the blocked no-authority P6 preflight template', async () => {
  assert.deepEqual(validateDesktopCandidatePreflight(validPreflight()), []);
  assert.deepEqual(
    await validateDesktopCandidatePreflightFile(TEMPLATE),
    [],
  );
});

test('validator has no network, Keychain, subprocess, or Apple capability', () => {
  const source = readFileSync(VALIDATOR, 'utf8');
  assert.doesNotMatch(
    source,
    /node:(?:child_process|http|https|net|tls)|\bfetch\s*\(|\bcurl\b|\bxcrun\b|\bcodesign\b|\bsecurity\b/u,
  );
});

test('binds the P5 cleanup and current desktop package bytes', () => {
  const preflight = validPreflight();
  const cleanup = JSON.parse(readFileSync(P5_CLEANUP, 'utf8'));
  assert.equal(
    preflight.evidenceInput.p5AuthorizationId,
    cleanup.authorizationId,
  );
  assert.equal(
    preflight.evidenceInput.p5LocalCleanupSha256,
    sha256File(P5_CLEANUP),
  );
  assert.equal(
    preflight.evidenceInput.p5ExecutionStatus,
    cleanup.executionStatus,
  );
  assert.equal(
    preflight.evidenceInput.p5TemporaryEntryCount,
    cleanup.remainingP5TempEntryCount,
  );
  assert.equal(
    preflight.evidenceInput.p5RetainedHostProcessCount,
    cleanup.retainedP5HostProcessCount,
  );
  assert.equal(
    preflight.evidenceInput.p5ProductionMutationCount,
    cleanup.productionMutationCount,
  );
  assert.equal(
    preflight.evidenceInput.p5ProductionPackageConstantsEmpty,
    cleanup.productionPackageConstantsEmpty,
  );
  assert.equal(
    preflight.evidenceInput.desktopPackageJsonSha256,
    sha256File(DESKTOP_PACKAGE),
  );
  assert.equal(
    preflight.evidenceInput.desktopPackageLockSha256,
    sha256File(DESKTOP_LOCK),
  );
});

test('audit matches the actual unsigned local desktop configuration', () => {
  const audit = validPreflight().currentDesktopAudit;
  const manifest = JSON.parse(readFileSync(DESKTOP_PACKAGE, 'utf8'));
  const lock = JSON.parse(readFileSync(DESKTOP_LOCK, 'utf8'));
  const main = readFileSync(
    path.join(REPOSITORY_ROOT, 'desktop/src/main.js'),
    'utf8',
  );
  const background = readFileSync(
    path.join(REPOSITORY_ROOT, 'desktop/src/background-startup.js'),
    'utf8',
  );
  const hostRuntime = readFileSync(
    path.join(REPOSITORY_ROOT, 'desktop/src/host/runtime.js'),
    'utf8',
  );

  assert.equal(audit.desktopVersion, manifest.version);
  assert.equal(audit.bundleId, manifest.build.appId);
  assert.equal(audit.productName, manifest.build.productName);
  assert.deepEqual(audit.packageTargets, manifest.build.mac.target);
  assert.equal(audit.electronVersion, lock.packages['node_modules/electron'].version);
  assert.equal(
    audit.electronBuilderVersion,
    lock.packages['node_modules/electron-builder'].version,
  );
  assert.equal(
    lock.packages['node_modules/electron-updater'],
    undefined,
  );
  assert.equal(manifest.build.mac.notarize, undefined);
  assert.equal(manifest.build.mac.entitlements, undefined);
  assert.equal(manifest.build.mac.entitlementsInherit, undefined);
  assert.equal(manifest.build.publish, undefined);
  assert.equal(manifest.dependencies?.['electron-updater'], undefined);
  assert.equal(
    existsSync(path.join(REPOSITORY_ROOT, '.github/workflows')),
    false,
  );
  assert.match(main, /app\.on\('before-quit'/u);
  assert.match(background, /setLoginItemSettings/u);
  assert.match(hostRuntime, /HOST_MODE_PERSISTENT/u);
});

test('keeps P6 and production gates blocked', () => {
  const preflight = validPreflight();
  assert.equal(preflight.authority, 'none');
  assert.equal(preflight.approvalStatus, 'not_approved');
  assert.equal(preflight.executionStatus, 'blocked');
  assert.equal(preflight.evidenceInput.p6Authorized, false);
  assert.equal(preflight.prerequisiteGates.p6ApprovalPresent, false);
  assert.equal(preflight.prerequisiteGates.productionGatesClosed, false);
  assert.equal(preflight.approvalCard.approvalReceipt, 'not_present');
});

test('pins the complete R4 safety contract', () => {
  const contract = validPreflight().requiredP6Contract;
  for (const [key, value] of Object.entries(contract)) {
    if (['unsignedUpdateAllowed', 'silentDowngradeAllowed'].includes(key)) {
      assert.equal(value, false);
    } else {
      assert.equal(value, true);
    }
  }
});

test('pins all 18 P6 scenarios in order and blocked', () => {
  const scenarios = validPreflight().scenarioMatrix;
  assert.equal(scenarios.length, 18);
  assert.deepEqual(
    scenarios.map((entry) => entry.scenario),
    [
      'reproducible_candidate_build',
      'architecture_matrix',
      'nested_code_signature',
      'hardened_runtime',
      'least_privilege_entitlements',
      'notarization_acceptance',
      'staple_and_offline_gatekeeper',
      'clean_install_and_first_launch',
      'second_launch_and_single_instance',
      'login_item_registration',
      'background_launch_and_window_restore',
      'persistent_host_crash_and_restart',
      'normal_and_forced_quit',
      'signed_update_check_and_download',
      'tampered_or_unsigned_update',
      'interrupted_update',
      'version_rollback_and_user_state',
      'uninstall_cleanup',
    ],
  );
  assert.ok(scenarios.every((entry) => entry.executionStatus === 'blocked'));
});

test('rejects authority, approval, execution, or candidate escalation', () => {
  for (const mutate of [
    (value) => {
      value.authority = 'release_owner';
    },
    (value) => {
      value.approvalStatus = 'approved';
    },
    (value) => {
      value.executionStatus = 'candidate_building';
    },
    (value) => {
      value.evidenceInput.p6Authorized = true;
    },
    (value) => {
      value.prerequisiteGates.p6ApprovalPresent = true;
    },
  ]) {
    const preflight = validPreflight();
    mutate(preflight);
    assert.ok(validateDesktopCandidatePreflight(preflight).length > 0);
  }
});

test('rejects fabricated Apple, signing, update, or build readiness', () => {
  for (const key of [
    'appleDeveloperProgramVerified',
    'developerIdIdentityInspected',
    'developerIdSigningConfigured',
    'notarizationConfigured',
    'hardenedRuntimeExplicitlyConfigured',
    'entitlementsConfigured',
    'publishProviderConfigured',
    'electronUpdaterDependencyPresent',
    'updateChannelConfigured',
    'updateRollbackImplemented',
    'repositoryReleaseWorkflowPresent',
    'candidateBuildExecuted',
    'appleCredentialRead',
    'preflightExecutionNetworkRequestPerformed',
  ]) {
    const preflight = validPreflight();
    preflight.currentDesktopAudit[key] = true;
    assert.ok(validateDesktopCandidatePreflight(preflight).length > 0);
  }
});

test('rejects weakened signing, update, rollback, or lifecycle policy', () => {
  for (const [key, value] of Object.entries(
    validPreflight().requiredP6Contract,
  )) {
    const preflight = validPreflight();
    preflight.requiredP6Contract[key] = !value;
    assert.ok(validateDesktopCandidatePreflight(preflight).length > 0);
  }
});

test('rejects network, credentials, artifacts, cost, or evidence escalation', () => {
  for (const mutate of [
    (value) => {
      value.networkBoundary.externalNetworkAllowed = true;
    },
    (value) => {
      value.networkBoundary.appleCredentialsMayBeRead = true;
    },
    (value) => {
      value.networkBoundary.signedArtifactsMayBeProduced = true;
    },
    (value) => {
      value.networkBoundary.candidateMayBeUploaded = true;
    },
    (value) => {
      value.approvalCard.maximumNetworkRequests = 1;
    },
    (value) => {
      value.approvalCard.maximumCurrencyCost = 1;
    },
    (value) => {
      value.evidencePolicy.recordCertificateIdentity = true;
    },
    (value) => {
      value.evidencePolicy.recordEndpointUrls = true;
    },
  ]) {
    const preflight = validPreflight();
    mutate(preflight);
    assert.ok(validateDesktopCandidatePreflight(preflight).length > 0);
  }
});

test('rejects missing, reordered, duplicate, or falsely executed scenarios', () => {
  for (const mutate of [
    (value) => value.scenarioMatrix.pop(),
    (value) => value.scenarioMatrix.reverse(),
    (value) => {
      value.scenarioMatrix[1] = structuredClone(value.scenarioMatrix[0]);
    },
    (value) => {
      value.scenarioMatrix[0].executionStatus = 'passed';
    },
  ]) {
    const preflight = validPreflight();
    mutate(preflight);
    assert.ok(validateDesktopCandidatePreflight(preflight).length > 0);
  }
});

test('rejects stop-condition drift, unknown fields, and unsafe content', () => {
  for (const mutate of [
    (value) => value.stopConditions.reverse(),
    (value) => {
      value.unreviewed = true;
    },
    (value) => {
      value.approvalCard.updateProvider = 'https://updates.example.test';
    },
    (value) => {
      value.approvalCard.notarizationCredential = 'owner@example.test';
    },
    (value) => {
      value.approvalCard.evidenceRetention = '/Users/example/evidence';
    },
    (value) => {
      value.approvalCard.sourceCommit = 'a'.repeat(64);
    },
  ]) {
    const preflight = validPreflight();
    mutate(preflight);
    assert.ok(validateDesktopCandidatePreflight(preflight).length > 0);
  }
});

test('rejects duplicate JSON keys, symlinks, invalid UTF-8, and oversize', async () => {
  await withTempDirectory(async (directory) => {
    const duplicatePath = path.join(directory, 'duplicate.json');
    await writeFile(
      duplicatePath,
      '{"schemaVersion":1,"schemaVersion":1}',
    );
    await assert.rejects(
      validateDesktopCandidatePreflightFile(duplicatePath),
      /duplicate JSON object keys/u,
    );

    const linkPath = path.join(directory, 'link.json');
    await symlink(TEMPLATE, linkPath);
    await assert.rejects(
      validateDesktopCandidatePreflightFile(linkPath),
      /regular file/u,
    );

    const invalidPath = path.join(directory, 'invalid.json');
    await writeFile(invalidPath, Buffer.from([0xff, 0xfe, 0xfd]));
    await assert.rejects(
      validateDesktopCandidatePreflightFile(invalidPath),
      /valid UTF-8/u,
    );

    const largePath = path.join(directory, 'large.json');
    await writeFile(largePath, Buffer.alloc(128 * 1024 + 1, 0x20));
    await assert.rejects(
      validateDesktopCandidatePreflightFile(largePath),
      /size is invalid/u,
    );
  });
});

test('CLI validates safely without printing input paths', async () => {
  const success = spawnSync(process.execPath, [VALIDATOR, TEMPLATE], {
    encoding: 'utf8',
  });
  assert.equal(success.status, 0);
  assert.match(success.stdout, /validation passed/u);
  assert.doesNotMatch(success.stdout, /Users|private|tmp/u);

  await withTempDirectory(async (directory) => {
    const invalidPath = path.join(directory, 'invalid.json');
    await writeFile(invalidPath, '{}');
    const failure = spawnSync(process.execPath, [VALIDATOR, invalidPath], {
      encoding: 'utf8',
    });
    assert.equal(failure.status, 1);
    assert.doesNotMatch(failure.stderr, /Users|private|tmp/u);
  });
});
