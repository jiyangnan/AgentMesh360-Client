import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertFrozenLifecycleExecutor,
  assertLoopbackDebugEndpoint,
  assertSafeInstallLocations,
  createLifecycleResult,
  validateLoginItemRoundTrip,
  validateSignedOutRuntime,
} from './run-isolated-lifecycle.mjs';

const COMMIT = 'a'.repeat(40);

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
  assert.equal(result.automatedScenarioCount, 11);
  assert.equal(new Set(result.automatedScenarios).size, 11);
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

