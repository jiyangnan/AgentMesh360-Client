import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  assertFrozenLifecycleExecutor,
  assertLoopbackDebugEndpoint,
  assertSafeInstallLocations,
  createLifecycleResult,
  validateLoginItemRoundTrip,
  validateSignedOutRuntime,
  verifyPackagedSpeechHelperCopies,
} from './run-isolated-lifecycle.mjs';

const COMMIT = 'a'.repeat(40);
const HELPER_EXECUTABLE =
  'Contents/Helpers/AgentMesh360SpeechHelper.app/Contents/MacOS/agentmesh360-speech-helper';
const HELPER_INFO =
  'Contents/Helpers/AgentMesh360SpeechHelper.app/Contents/Info.plist';

async function speechHelperCopiesFixture() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'am360-speech-helper-lifecycle-test-'),
  );
  const copies = {
    mountedApp: path.join(root, 'mounted/AgentMesh360.app'),
    installedApp: path.join(root, 'installed/AgentMesh360.app'),
    zipApp: path.join(root, 'zip/AgentMesh360.app'),
  };
  for (const appPath of Object.values(copies)) {
    const executable = path.join(appPath, HELPER_EXECUTABLE);
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, 'same-helper-executable');
    await chmod(executable, 0o755);
    await writeFile(path.join(appPath, HELPER_INFO), 'same-helper-info');
  }
  return { root, ...copies };
}

test('requires a clean lifecycle executor already pushed to origin/main', () => {
  assert.doesNotThrow(() => assertFrozenLifecycleExecutor({
    head: COMMIT,
    originMain: COMMIT,
    status: '',
  }));
  assert.throws(() => assertFrozenLifecycleExecutor({
    head: COMMIT,
    originMain: 'b'.repeat(40),
    status: '',
  }));
  assert.throws(() => assertFrozenLifecycleExecutor({
    head: COMMIT,
    originMain: COMMIT,
    status: ' M desktop/src/main.js',
  }));
});

test('refuses root and either existing AgentMesh360 installation', () => {
  assert.doesNotThrow(() => assertSafeInstallLocations({
    systemApplicationsPresent: false,
    userApplicationsPresent: false,
    runningAsRoot: false,
  }));
  for (const unsafe of [
    {
      systemApplicationsPresent: true,
      userApplicationsPresent: false,
      runningAsRoot: false,
    },
    {
      systemApplicationsPresent: false,
      userApplicationsPresent: true,
      runningAsRoot: false,
    },
    {
      systemApplicationsPresent: false,
      userApplicationsPresent: false,
      runningAsRoot: true,
    },
  ]) {
    assert.throws(() => assertSafeInstallLocations(unsafe));
  }
});

test('accepts only an explicit IPv4 loopback debug endpoint', () => {
  assert.doesNotThrow(
    () => assertLoopbackDebugEndpoint('http://127.0.0.1:43119/json/list'),
  );
  for (const unsafe of [
    'http://localhost:43119/json/list',
    'http://0.0.0.0:43119/json/list',
    'http://192.168.1.9:43119/json/list',
    'https://127.0.0.1:43119/json/list',
    'http://127.0.0.1/json/list',
  ]) {
    assert.throws(() => assertLoopbackDebugEndpoint(unsafe));
  }
});

test('pins signed-out packaged runtime before Host admission', () => {
  const value = {
    identity: { phase: 'signed_out' },
    background: {
      host: {
        mode: 'persistent_leader',
        ownership: 'grok_leader',
        transport: 'leader_stdio_bridge',
        bridgeState: 'detached',
        socketName: 'host.sock',
      },
      loginItem: {
        supported: true,
        openAtLogin: false,
        wasOpenedAtLogin: false,
        status: 'not-found',
        reason: null,
      },
    },
    expectedSocketName: 'host.sock',
  };
  assert.doesNotThrow(() => validateSignedOutRuntime(value));
  assert.throws(() => validateSignedOutRuntime({
    ...value,
    background: {
      ...value.background,
      host: { ...value.background.host, bridgeState: 'connected' },
    },
  }));
  assert.throws(() => validateSignedOutRuntime({
    ...value,
    identity: { phase: 'ready' },
  }));
});

test('requires Login Item enable followed by confirmed disable', () => {
  const roundTrip = {
    enabled: { supported: true, openAtLogin: true, status: 'enabled' },
    disabled: { supported: true, openAtLogin: false, status: 'not-registered' },
  };
  assert.doesNotThrow(() => validateLoginItemRoundTrip(roundTrip));
  assert.throws(() => validateLoginItemRoundTrip({
    ...roundTrip,
    disabled: { ...roundTrip.disabled, openAtLogin: true },
  }));
});

test('result cannot claim signing, notarization, upload, or production R4', () => {
  const result = createLifecycleResult({
    executorCommit: COMMIT,
    artifactCommit: 'b'.repeat(40),
    architecture: 'arm64',
    bundleVersion: '0.1.0',
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.distributionClass, 'unsigned_internal_only');
  assert.equal(result.automatedScenarioCount, 12);
  assert.equal(new Set(result.automatedScenarios).size, 12);
  assert.ok(result.automatedScenarios.includes('bundle_and_packaged_speech_helper'));
  assert.equal(result.manualGatekeeperActionRequired, true);
  assert.equal(result.globalGatekeeperDisableRequired, false);
  assert.equal(result.developerIdSigned, false);
  assert.equal(result.notarized, false);
  assert.equal(result.externalUploadPerformed, false);
  assert.equal(result.providerRequests, 0);
  assert.equal(result.agentMeshCredits, 0);
  assert.equal(result.appleServiceRequests, 0);
  assert.equal(result.productionR4Satisfied, false);
  assert.equal(result.loginItemRestoredDisabled, true);
  assert.equal(result.temporaryStateDestroyed, true);
});

test('requires byte-identical executable and Info.plist in DMG, installed, and ZIP helper copies', async () => {
  const value = await speechHelperCopiesFixture();
  try {
    await assert.doesNotReject(verifyPackagedSpeechHelperCopies(value));
    await writeFile(
      path.join(value.installedApp, HELPER_EXECUTABLE),
      'changed-installed-helper',
    );
    await assert.rejects(
      verifyPackagedSpeechHelperCopies(value),
      /speech helper executable differs/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('rejects changed helper privacy metadata and unsafe helper payloads', async () => {
  for (const mutation of ['info', 'symlink']) {
    const value = await speechHelperCopiesFixture();
    try {
      if (mutation === 'info') {
        await writeFile(
          path.join(value.zipApp, HELPER_INFO),
          'changed-helper-info',
        );
      } else {
        const executable = path.join(value.zipApp, HELPER_EXECUTABLE);
        await rm(executable);
        await symlink(
          path.join(value.mountedApp, HELPER_EXECUTABLE),
          executable,
        );
      }
      await assert.rejects(
        verifyPackagedSpeechHelperCopies(value),
        mutation === 'info'
          ? /speech helper Info\.plist differs/u
          : /ZIP speech helper executable must be an executable regular file/u,
      );
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});
