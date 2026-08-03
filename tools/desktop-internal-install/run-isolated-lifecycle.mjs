#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  sha256File,
  verifyUnsignedInternalBuild,
} from '../desktop-internal-build/verify-unsigned-internal.mjs';
import { assertSafeInternalEnvironment } from '../desktop-internal-build/build-unsigned-internal.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const DESKTOP_ROOT = path.join(REPOSITORY_ROOT, 'desktop');
const TEMPORARY_PREFIX = 'agentmesh360-desktop-install-';
const PRODUCT_NAME = 'AgentMesh360';
const BUNDLE_ID = 'com.agentmesh360.client';
const MAX_OUTPUT_BYTES = 1024 * 1024;
const SPEECH_HELPER_BUNDLE_RELATIVE_PATH =
  'Contents/Helpers/AgentMesh360SpeechHelper.app';
const SPEECH_HELPER_EXECUTABLE_RELATIVE_PATH =
  `${SPEECH_HELPER_BUNDLE_RELATIVE_PATH}/Contents/MacOS/agentmesh360-speech-helper`;
const SPEECH_HELPER_INFO_RELATIVE_PATH =
  `${SPEECH_HELPER_BUNDLE_RELATIVE_PATH}/Contents/Info.plist`;
const SCENARIOS = Object.freeze([
  'artifact_boundary',
  'dmg_verify_and_isolated_copy',
  'zip_and_dmg_payload_match',
  'bundle_and_packaged_host',
  'bundle_and_packaged_speech_helper',
  'developer_id_absent_and_manual_gatekeeper',
  'signed_out_first_launch',
  'single_instance_window_restore',
  'login_item_enable_disable_restore',
  'signed_out_background_exit',
  'packaged_host_persistent_agent_recovery',
  'isolated_cleanup',
]);

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function boundedAppend(current, chunk) {
  return `${current}${chunk}`.slice(-MAX_OUTPUT_BYTES);
}

function runSync(command, args, {
  cwd = REPOSITORY_ROOT,
  env = process.env,
  expectedStatus = 0,
  errorMessage = `${command} failed`,
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (
    result.error
    || (
      expectedStatus === 'nonzero'
        ? !Number.isInteger(result.status) || result.status === 0
        : result.status !== expectedStatus
    )
  ) {
    throw new Error(errorMessage);
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function runGit(args) {
  return runSync('git', args, {
    errorMessage: 'internal install lifecycle git inspection failed',
  }).stdout.trim();
}

export function assertFrozenLifecycleExecutor({
  head,
  originMain,
  status,
}) {
  assertCondition(
    /^[0-9a-f]{40}$/u.test(head)
      && head === originMain
      && status === '',
    'internal install lifecycle requires a clean commit already pushed to origin/main',
  );
}

export function assertSafeInstallLocations({
  systemApplicationsPresent,
  userApplicationsPresent,
  runningAsRoot,
}) {
  assertCondition(!runningAsRoot, 'internal install lifecycle refuses root');
  assertCondition(
    !systemApplicationsPresent && !userApplicationsPresent,
    'internal install lifecycle refuses to overwrite an existing AgentMesh360 app',
  );
}

export function assertLoopbackDebugEndpoint(value) {
  const parsed = new URL(value);
  assertCondition(
    parsed.protocol === 'http:'
      && parsed.hostname === '127.0.0.1'
      && Number.isInteger(Number(parsed.port))
      && Number(parsed.port) > 0
      && Number(parsed.port) <= 65535,
    'debug endpoint must be an explicit IPv4 loopback port',
  );
}

export function validateSignedOutRuntime({
  identity,
  background,
  expectedSocketName,
}) {
  assertCondition(
    identity
      && Object.keys(identity).length === 1
      && identity.phase === 'signed_out',
    'packaged app must start signed out in the isolated boundary',
  );
  assertCondition(
    background?.host?.mode === 'persistent_leader'
      && background.host.ownership === 'grok_leader'
      && background.host.transport === 'leader_stdio_bridge'
      && background.host.bridgeState === 'detached'
      && background.host.socketName === expectedSocketName,
    'packaged app Host must remain detached before identity admission',
  );
  assertCondition(
    background?.loginItem?.supported === true
      && background.loginItem.openAtLogin === false,
    'packaged app Login Item must begin disabled',
  );
}

export function validateLoginItemRoundTrip(value) {
  assertCondition(
    value?.enabled?.supported === true
      && value.enabled.openAtLogin === true
      && value?.disabled?.supported === true
      && value.disabled.openAtLogin === false,
    'packaged Login Item enable/disable round trip failed',
  );
}

export function createLifecycleResult({
  executorCommit,
  artifactCommit,
  architecture,
  bundleVersion,
}) {
  assertCondition(/^[0-9a-f]{40}$/u.test(executorCommit), 'executor commit is invalid');
  assertCondition(/^[0-9a-f]{40}$/u.test(artifactCommit), 'artifact commit is invalid');
  assertCondition(['arm64', 'x64'].includes(architecture), 'architecture is invalid');
  assertCondition(
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(
      bundleVersion,
    ),
    'bundle version is invalid',
  );
  return Object.freeze({
    status: 'passed',
    receiptId:
      `desktop_internal_lifecycle_p6_${artifactCommit.slice(0, 12)}_${architecture}`,
    distributionClass: 'unsigned_internal_only',
    executorCommit,
    artifactCommit,
    architecture,
    bundleId: BUNDLE_ID,
    bundleVersion,
    automatedScenarioCount: SCENARIOS.length,
    automatedScenarios: [...SCENARIOS],
    manualGatekeeperActionRequired: true,
    globalGatekeeperDisableRequired: false,
    developerIdSigned: false,
    notarized: false,
    externalUploadPerformed: false,
    providerRequests: 0,
    agentMeshCredits: 0,
    appleServiceRequests: 0,
    productionR4Satisfied: false,
    loginItemRestoredDisabled: true,
    temporaryStateDestroyed: true,
  });
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function assertExpectedArtifactInventory(names, receipt) {
  const expected = [
    'SHA256SUMS',
    'unsigned-internal-build-v1.json',
    ...receipt.artifacts.map((artifact) => artifact.file),
  ].sort();
  assertCondition(
    [...names].sort().join('\n') === expected.join('\n'),
    'internal build boundary must contain exactly four distribution files',
  );
}

async function inspectExecutable(filePath, label) {
  const direct = await lstat(filePath);
  assertCondition(
    direct.isFile()
      && !direct.isSymbolicLink()
      && (direct.mode & 0o111) !== 0,
    `${label} must be an executable regular file`,
  );
  return direct;
}

async function inspectRegularFile(filePath, label) {
  const direct = await lstat(filePath);
  assertCondition(
    direct.isFile()
      && !direct.isSymbolicLink()
      && direct.size > 0,
    `${label} must be a non-empty regular file`,
  );
  return direct;
}

async function assertByteIdentical(filePaths, label) {
  const copies = await Promise.all(filePaths.map((filePath) => readFile(filePath)));
  assertCondition(
    copies.slice(1).every((copy) => copies[0].compare(copy) === 0),
    `${label} differs between the DMG, installed app, and ZIP`,
  );
}

export async function verifyPackagedSpeechHelperCopies({
  mountedApp,
  installedApp,
  zipApp,
}) {
  const appCopies = [mountedApp, installedApp, zipApp];
  assertCondition(
    appCopies.every(
      (appPath) => typeof appPath === 'string' && path.isAbsolute(appPath),
    ),
    'speech helper app copy paths must be absolute',
  );
  const helperExecutables = appCopies.map((appPath) => (
    path.join(appPath, SPEECH_HELPER_EXECUTABLE_RELATIVE_PATH)
  ));
  const helperInfoPlists = appCopies.map((appPath) => (
    path.join(appPath, SPEECH_HELPER_INFO_RELATIVE_PATH)
  ));
  await Promise.all([
    ...helperExecutables.map((filePath, index) => inspectExecutable(
      filePath,
      ['DMG', 'installed', 'ZIP'][index] + ' speech helper executable',
    )),
    ...helperInfoPlists.map((filePath, index) => inspectRegularFile(
      filePath,
      ['DMG', 'installed', 'ZIP'][index] + ' speech helper Info.plist',
    )),
  ]);
  await Promise.all([
    assertByteIdentical(helperExecutables, 'speech helper executable'),
    assertByteIdentical(helperInfoPlists, 'speech helper Info.plist'),
  ]);
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assertCondition(
    address && typeof address === 'object',
    'failed to reserve loopback port',
  );
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

function isolatedChildEnvironment({
  home,
  stateHome,
  socketPath,
  temporaryDirectory,
}) {
  return {
    HOME: home,
    USER: process.env.USER ?? 'agentmesh360-test',
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? 'agentmesh360-test',
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TMPDIR: temporaryDirectory,
    GROK_HOME: path.join(home, '.grok'),
    AGENTMESH360_HOME: stateHome,
    AGENTMESH360_HOST_SOCKET: socketPath,
    AGENTMESH360_CORE_URL: 'http://127.0.0.1:9',
    AGENTMESH360_ENABLE_DEVTOOLS: '1',
  };
}

function startProcess(command, args, {
  cwd = REPOSITORY_ROOT,
  env,
} = {}) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = {
    child,
    stdout: '',
    stderr: '',
    exit: null,
    error: null,
  };
  child.stdout.on('data', (chunk) => {
    state.stdout = boundedAppend(state.stdout, chunk.toString());
  });
  child.stderr.on('data', (chunk) => {
    state.stderr = boundedAppend(state.stderr, chunk.toString());
  });
  child.once('exit', (code, signal) => {
    state.exit = { code, signal };
  });
  child.once('error', (error) => {
    state.error = error;
  });
  return state;
}

async function waitForExit(state, timeoutMs) {
  if (state.error) throw state.error;
  if (state.exit) return state.exit;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.child.off('exit', onExit);
      state.child.off('error', onError);
      reject(new Error('child process did not exit within the lifecycle timeout'));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      state.child.off('error', onError);
      resolve({ code, signal });
    };
    const onError = (error) => {
      clearTimeout(timeout);
      state.child.off('exit', onExit);
      reject(error);
    };
    state.child.once('exit', onExit);
    state.child.once('error', onError);
  });
}

async function stopProcess(state) {
  if (!state || state.exit || state.error) return;
  state.child.kill('SIGTERM');
  try {
    await waitForExit(state, 10_000);
  } catch {
    state.child.kill('SIGKILL');
    await waitForExit(state, 5_000);
  }
}

async function fetchPages(port) {
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  assertLoopbackDebugEndpoint(endpoint);
  const response = await fetch(endpoint, { redirect: 'error' });
  assertCondition(response.ok, 'packaged app debug endpoint is unavailable');
  const pages = await response.json();
  assertCondition(Array.isArray(pages), 'packaged app debug response is invalid');
  return pages.filter(
    (page) =>
      page?.type === 'page'
      && typeof page.webSocketDebuggerUrl === 'string'
      && page.url?.includes('/AgentMesh360.app/Contents/Resources/app.asar/'),
  );
}

async function waitForPageCount(port, count, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const pages = await fetchPages(port);
      if (pages.length === count) return pages;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    count === 0
      ? 'packaged app window did not close'
      : `packaged app window did not appear${
        lastError ? `: ${lastError.message}` : ''
      }`,
  );
}

async function evaluatePage(webSocketUrl, expression) {
  const parsed = new URL(webSocketUrl);
  assertCondition(
    parsed.protocol === 'ws:'
      && parsed.hostname === '127.0.0.1',
    'debug WebSocket must remain on IPv4 loopback',
  );
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      socket.close();
      reject(new Error('packaged app debug evaluation timed out'));
    }, 10_000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression,
          awaitPromise: true,
          returnByValue: true,
        },
      }));
    });
    socket.addEventListener('message', (event) => {
      if (settled) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id !== 1) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (message.result?.exceptionDetails) {
        reject(new Error('packaged app debug evaluation failed'));
        return;
      }
      resolve(message.result?.result?.value);
    });
    socket.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error('packaged app debug WebSocket failed'));
    });
  });
}

async function runPackagedHostLifecycle(hostBinary, childEnv) {
  const lifecycleTest = path.join(
    DESKTOP_ROOT,
    'tests/real-host-lifecycle.test.js',
  );
  const state = startProcess(
    process.execPath,
    ['--test', lifecycleTest],
    {
      cwd: DESKTOP_ROOT,
      env: {
        ...childEnv,
        AGENTMESH360_REAL_HOST_BIN: hostBinary,
      },
    },
  );
  const exit = await waitForExit(state, 60_000);
  assertCondition(
    exit.code === 0
      && exit.signal === null
      && /pass 1/u.test(state.stdout)
      && /fail 0/u.test(state.stdout),
    'packaged Host persistent lifecycle test failed',
  );
}

async function run() {
  assertCondition(
    process.platform === 'darwin'
      && ['arm64', 'x64'].includes(process.arch),
    'internal install lifecycle supports macOS arm64 or x64 only',
  );
  assertCondition(
    typeof fetch === 'function' && typeof WebSocket === 'function',
    'internal install lifecycle requires Node with fetch and WebSocket support',
  );
  assertCondition(
    process.argv.length === 3
      && path.isAbsolute(process.argv[2] ?? '')
      && path.basename(process.argv[2]) === 'unsigned-internal-build-v1.json',
    'usage: node run-isolated-lifecycle.mjs <absolute-receipt-path>',
  );
  assertSafeInternalEnvironment();
  const executorCommit = runGit(['rev-parse', 'HEAD']);
  assertFrozenLifecycleExecutor({
    head: executorCommit,
    originMain: runGit(['rev-parse', 'origin/main']),
    status: runGit(['status', '--porcelain=v1', '--untracked-files=all']),
  });
  assertSafeInstallLocations({
    systemApplicationsPresent:
      await pathExists('/Applications/AgentMesh360.app'),
    userApplicationsPresent:
      await pathExists(path.join(os.homedir(), 'Applications/AgentMesh360.app')),
    runningAsRoot: typeof process.getuid === 'function' && process.getuid() === 0,
  });

  const receiptPath = await realpath(process.argv[2]);
  await verifyUnsignedInternalBuild(receiptPath);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const artifactBoundary = path.dirname(receiptPath);
  assertExpectedArtifactInventory(await readdir(artifactBoundary), receipt);
  const dmg = receipt.artifacts.find((artifact) => artifact.kind === 'dmg');
  const zip = receipt.artifacts.find((artifact) => artifact.kind === 'zip');
  assertCondition(dmg && zip, 'internal build receipt lacks DMG or ZIP');

  const temporaryRoot = await mkdtemp(
    path.join('/private/tmp', TEMPORARY_PREFIX),
  );
  const mountPoint = path.join(temporaryRoot, 'mount');
  const applications = path.join(temporaryRoot, 'Applications');
  const zipCopy = path.join(temporaryRoot, 'zip-copy');
  const home = path.join(temporaryRoot, 'home');
  const userData = path.join(temporaryRoot, 'user-data');
  const backgroundUserData = path.join(temporaryRoot, 'background-user-data');
  const stateHome = path.join(temporaryRoot, 'state');
  const backgroundStateHome = path.join(temporaryRoot, 'background-state');
  const temporaryDirectory = path.join(temporaryRoot, 'tmp');
  const socketPath = path.join(temporaryRoot, 'host.sock');
  const backgroundSocketPath = path.join(temporaryRoot, 'background.sock');
  const installedApp = path.join(applications, `${PRODUCT_NAME}.app`);
  const zipApp = path.join(zipCopy, `${PRODUCT_NAME}.app`);
  const mountedApp = path.join(mountPoint, `${PRODUCT_NAME}.app`);
  let mounted = false;
  let foreground = null;
  let secondInstance = null;
  let backgroundProcess = null;
  let loginItemRestored = true;
  let completed = false;
  let result = null;

  try {
    await Promise.all([
      mkdir(mountPoint),
      mkdir(applications),
      mkdir(zipCopy),
      mkdir(home),
      mkdir(userData),
      mkdir(backgroundUserData),
      mkdir(stateHome),
      mkdir(backgroundStateHome),
      mkdir(temporaryDirectory),
    ]);
    runSync('hdiutil', ['verify', path.join(artifactBoundary, dmg.file)], {
      errorMessage: 'internal DMG checksum verification failed',
    });
    runSync(
      'hdiutil',
      [
        'attach',
        '-readonly',
        '-nobrowse',
        '-mountpoint',
        mountPoint,
        path.join(artifactBoundary, dmg.file),
      ],
      { errorMessage: 'internal DMG read-only mount failed' },
    );
    mounted = true;
    runSync(
      'ditto',
      [mountedApp, installedApp],
      { errorMessage: 'isolated DMG app copy failed' },
    );
    runSync(
      'ditto',
      ['-x', '-k', path.join(artifactBoundary, zip.file), zipCopy],
      { errorMessage: 'isolated ZIP app extraction failed' },
    );

    const appExecutable = path.join(
      installedApp,
      'Contents/MacOS',
      PRODUCT_NAME,
    );
    const packagedHost = path.join(
      installedApp,
      'Contents/Resources/bin/agentmesh360-host',
    );
    const zipHost = path.join(
      zipApp,
      'Contents/Resources/bin/agentmesh360-host',
    );
    const appAsar = path.join(installedApp, 'Contents/Resources/app.asar');
    const zipAsar = path.join(zipApp, 'Contents/Resources/app.asar');
    await Promise.all([
      inspectExecutable(appExecutable, 'packaged app executable'),
      inspectExecutable(packagedHost, 'packaged Host'),
      inspectExecutable(zipHost, 'ZIP packaged Host'),
      verifyPackagedSpeechHelperCopies({ mountedApp, installedApp, zipApp }),
    ]);
    assertCondition(
      await sha256File(packagedHost) === await sha256File(zipHost)
        && await sha256File(appAsar) === await sha256File(zipAsar),
      'DMG and ZIP app payloads do not match',
    );
    const bundleId = runSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleIdentifier', path.join(installedApp, 'Contents/Info.plist')],
    ).stdout.trim();
    const bundleVersion = runSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleShortVersionString', path.join(installedApp, 'Contents/Info.plist')],
    ).stdout.trim();
    assertCondition(
      bundleId === BUNDLE_ID
        && bundleVersion === receipt.source.desktopVersion,
      'installed app bundle metadata does not match the build receipt',
    );
    const signature = runSync(
      'codesign',
      ['-dv', '--verbose=4', installedApp],
      { errorMessage: 'unable to inspect internal app signature boundary' },
    );
    const signatureText = `${signature.stdout}\n${signature.stderr}`;
    assertCondition(
      /Signature=adhoc/u.test(signatureText)
        && /TeamIdentifier=not set/u.test(signatureText)
        && !/Authority=Developer ID Application/u.test(signatureText),
      'internal app unexpectedly claims a Developer ID identity',
    );
    runSync(
      'codesign',
      ['--verify', '--deep', '--strict', '--verbose=4', installedApp],
      {
        expectedStatus: 'nonzero',
        errorMessage: 'unsigned internal app unexpectedly passed deep codesign',
      },
    );
    runSync(
      'spctl',
      ['--assess', '--type', 'execute', '--verbose=4', installedApp],
      {
        expectedStatus: 'nonzero',
        errorMessage: 'unsigned internal app unexpectedly passed Gatekeeper assessment',
      },
    );

    const port = await reserveLoopbackPort();
    const foregroundEnv = isolatedChildEnvironment({
      home,
      stateHome,
      socketPath,
      temporaryDirectory,
    });
    const foregroundArgs = [
      `--user-data-dir=${userData}`,
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
    ];
    foreground = startProcess(appExecutable, foregroundArgs, {
      env: foregroundEnv,
    });
    const [firstPage] = await waitForPageCount(port, 1);
    const [identity, background] = await evaluatePage(
      firstPage.webSocketDebuggerUrl,
      'Promise.all([window.agentmesh360.getState(),window.agentmesh360.getBackgroundSnapshot()])',
    );
    validateSignedOutRuntime({
      identity,
      background,
      expectedSocketName: path.basename(socketPath),
    });
    assertCondition(
      !await pathExists(socketPath)
        && !await pathExists(path.join(stateHome, 'run/host.lock')),
      'signed-out foreground launch must not start the Host',
    );

    loginItemRestored = false;
    const loginRoundTrip = await evaluatePage(
      firstPage.webSocketDebuggerUrl,
      '(async()=>{const enabled=await window.agentmesh360.setBackgroundStartup(true);const disabled=await window.agentmesh360.setBackgroundStartup(false);return {enabled:enabled.loginItem,disabled:disabled.loginItem};})()',
    );
    validateLoginItemRoundTrip(loginRoundTrip);
    loginItemRestored = true;

    await evaluatePage(
      firstPage.webSocketDebuggerUrl,
      'window.close(); true',
    );
    await waitForPageCount(port, 0);
    secondInstance = startProcess(appExecutable, foregroundArgs, {
      env: foregroundEnv,
    });
    const secondExit = await waitForExit(secondInstance, 5_000);
    assertCondition(
      secondExit.code === 0 && secondExit.signal === null,
      'second packaged app instance did not hand off cleanly',
    );
    secondInstance = null;
    const [restoredPage] = await waitForPageCount(port, 1);
    assertCondition(
      restoredPage.id !== firstPage.id,
      'second instance did not restore a new renderer window',
    );
    const restored = await evaluatePage(
      restoredPage.webSocketDebuggerUrl,
      'Promise.all([window.agentmesh360.getState(),window.agentmesh360.getBackgroundSnapshot()])',
    );
    validateSignedOutRuntime({
      identity: restored[0],
      background: restored[1],
      expectedSocketName: path.basename(socketPath),
    });

    await stopProcess(foreground);
    foreground = null;
    const backgroundEnv = isolatedChildEnvironment({
      home,
      stateHome: backgroundStateHome,
      socketPath: backgroundSocketPath,
      temporaryDirectory,
    });
    backgroundProcess = startProcess(
      appExecutable,
      [
        '--agentmesh360-background',
        `--user-data-dir=${backgroundUserData}`,
      ],
      { env: backgroundEnv },
    );
    const backgroundExit = await waitForExit(backgroundProcess, 10_000);
    assertCondition(
      backgroundExit.code === 0
        && backgroundExit.signal === null
        && !await pathExists(backgroundSocketPath)
        && !await pathExists(path.join(backgroundStateHome, 'run/host.lock')),
      'signed-out background launch must exit without starting a Host',
    );

    await runPackagedHostLifecycle(packagedHost, foregroundEnv);
    assertCondition(
      !await pathExists(socketPath),
      'packaged Host lifecycle left the isolated socket behind',
    );
    completed = true;
    result = createLifecycleResult({
      executorCommit,
      artifactCommit: receipt.source.commit,
      architecture: receipt.source.architecture,
      bundleVersion,
    });
  } finally {
    if (foreground && !foreground.exit) {
      try {
        const pages = await fetchPages(
          Number(
            foreground.child.spawnargs
              .find((arg) => arg.startsWith('--remote-debugging-port='))
              ?.split('=')[1],
          ),
        );
        if (pages.length === 1) {
          const disabled = await evaluatePage(
            pages[0].webSocketDebuggerUrl,
            'window.agentmesh360.setBackgroundStartup(false)',
          );
          loginItemRestored = disabled?.loginItem?.openAtLogin === false;
        }
      } catch {
        // The final cleanup assertion below fails closed.
      }
      await stopProcess(foreground);
    }
    await stopProcess(secondInstance);
    await stopProcess(backgroundProcess);
    if (mounted) {
      try {
        runSync('hdiutil', ['detach', mountPoint], {
          errorMessage: 'internal DMG detach failed',
        });
        mounted = false;
      } catch {
        // Preserve the boundary for operator recovery when detach fails.
      }
    }
    if (loginItemRestored && !mounted) {
      await rm(temporaryRoot, { recursive: true, force: false });
    }
    assertCondition(
      loginItemRestored && !mounted,
      'internal install lifecycle cleanup did not complete',
    );
  }
  assertCondition(completed && result, 'internal install lifecycle did not complete');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'internal install lifecycle failed'}\n`,
    );
    process.exitCode = 1;
  });
}
