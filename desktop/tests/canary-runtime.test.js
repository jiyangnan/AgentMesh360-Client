'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  CANARY_AUTHORIZATION_ID,
  CANARY_BOUNDARY,
  CANARY_FLAG,
  MARKER_FILE,
  configureP5CanaryRuntime,
} = require('../src/canary-runtime');

const EXECUTOR = '1'.repeat(40);

test('normal desktop startup remains outside the P5 boundary', () => {
  const paths = [];
  const result = configureP5CanaryRuntime({
    app: { setPath: (...args) => paths.push(args) },
    env: {},
  });

  assert.deepEqual(result, { enabled: false });
  assert.deepEqual(paths, []);
});

test('exact private P5 marker isolates Electron userData', () => {
  const paths = [];
  const fsModule = fixtureFs();
  const result = configureP5CanaryRuntime({
    app: { setPath: (...args) => paths.push(args) },
    env: canaryEnv(),
    fsModule,
  });

  assert.deepEqual(paths, [
    ['userData', path.join(CANARY_BOUNDARY, 'user-data')],
  ]);
  assert.deepEqual(result, {
    enabled: true,
    boundaryId: 'p5-e1-isolated-client-02',
    authorizationId: CANARY_AUTHORIZATION_ID,
    executorCommit: EXECUTOR,
    normalStateReadable: false,
    productionAuthorityGranted: false,
  });
});

test('P5 startup rejects path, commit, marker, or permission drift', () => {
  for (const mutate of [
    (env) => {
      env.AGENTMESH360_P5_BOUNDARY = '/private/tmp/other';
    },
    (env) => {
      env.AGENTMESH360_HOME = '/Users/normal/.agentmesh360';
    },
    (env) => {
      env.HOME = '/Users/normal';
    },
    (env) => {
      delete env.GROK_HOME;
    },
    (env) => {
      env.GROK_HOME = '/Users/normal/.grok';
    },
    (env) => {
      env.AGENTMESH360_P5_EXECUTOR_COMMIT = '2'.repeat(40);
    },
  ]) {
    const env = canaryEnv();
    mutate(env);
    assert.throws(
      () => configureP5CanaryRuntime({
        app: { setPath() {} },
        env,
        fsModule: fixtureFs(),
      }),
      /P5 canary/u,
    );
  }

  assert.throws(
    () => configureP5CanaryRuntime({
      app: { setPath() {} },
      env: canaryEnv(),
      fsModule: fixtureFs({ directoryMode: 0o755 }),
    }),
    /0700 real directory/u,
  );
});

test('P5 startup rejects every XDG path drift explicitly', () => {
  for (const [variable, invalidPath] of [
    ['XDG_CACHE_HOME', '/Users/normal/Library/Caches'],
    ['XDG_CONFIG_HOME', '/Users/normal/.config'],
    ['XDG_DATA_HOME', '/Users/normal/.local/share'],
    ['XDG_STATE_HOME', '/Users/normal/.local/state'],
  ]) {
    const env = canaryEnv();
    env[variable] = invalidPath;
    assert.throws(
      () => configureP5CanaryRuntime({
        app: { setPath() {} },
        env,
        fsModule: fixtureFs(),
      }),
      /P5 canary XDG cache, config, data, or state path is invalid/u,
    );
  }
});

test('P5 startup rejects a non-private XDG directory', () => {
  for (const directoryName of ['cache', 'config', 'data', 'xdg-state']) {
    const directory = path.join(CANARY_BOUNDARY, directoryName);
    assert.throws(
      () => configureP5CanaryRuntime({
        app: { setPath() {} },
        env: canaryEnv(),
        fsModule: fixtureFs({
          directoryModeByPath: {
            [directory]: 0o755,
          },
        }),
      }),
      /P5 canary XDG (?:cache|config|data|state) must be a 0700 real directory/u,
    );
  }
});

test('P5 startup requires every XDG directory to be exactly 0700', () => {
  for (const directoryName of ['cache', 'config', 'data', 'xdg-state']) {
    const directory = path.join(CANARY_BOUNDARY, directoryName);
    assert.throws(
      () => configureP5CanaryRuntime({
        app: { setPath() {} },
        env: canaryEnv(),
        fsModule: fixtureFs({
          directoryModeByPath: {
            [directory]: 0o600,
          },
        }),
      }),
      /P5 canary XDG (?:cache|config|data|state)/u,
    );
  }
});

test('P5 startup rejects a marker that claims mutation or production authority', () => {
  for (const markerPatch of [
    { productionAuthorityGranted: true },
    { normalStateReadable: true },
    { keychainWritePerformed: true },
    { networkRequestPerformed: true },
    { packageMutationPerformed: true },
  ]) {
    assert.throws(
      () => configureP5CanaryRuntime({
        app: { setPath() {} },
        env: canaryEnv(),
        fsModule: fixtureFs({ markerPatch }),
      }),
      /marker does not match/u,
    );
  }
});

function canaryEnv() {
  return {
    [CANARY_FLAG]: '1',
    AGENTMESH360_P5_AUTHORIZATION_ID: CANARY_AUTHORIZATION_ID,
    AGENTMESH360_P5_BOUNDARY: CANARY_BOUNDARY,
    AGENTMESH360_P5_EXECUTOR_COMMIT: EXECUTOR,
    AGENTMESH360_P5_USER_DATA: path.join(CANARY_BOUNDARY, 'user-data'),
    AGENTMESH360_HOME: path.join(CANARY_BOUNDARY, 'state'),
    HOME: CANARY_BOUNDARY,
    GROK_HOME: path.join(CANARY_BOUNDARY, 'grok-home'),
    XDG_CACHE_HOME: path.join(CANARY_BOUNDARY, 'cache'),
    XDG_CONFIG_HOME: path.join(CANARY_BOUNDARY, 'config'),
    XDG_DATA_HOME: path.join(CANARY_BOUNDARY, 'data'),
    XDG_STATE_HOME: path.join(CANARY_BOUNDARY, 'xdg-state'),
  };
}

function fixtureFs({
  directoryMode = 0o700,
  directoryModeByPath = {},
  markerPatch = {},
} = {}) {
  const markerPath = path.join(CANARY_BOUNDARY, MARKER_FILE);
  const marker = JSON.stringify({
    schemaVersion: 2,
    authorizationId: CANARY_AUTHORIZATION_ID,
    boundaryId: 'p5-e1-isolated-client-02',
    executorCommit: EXECUTOR,
    productionAuthorityGranted: false,
    normalStateReadable: false,
    keychainWritePerformed: false,
    networkRequestPerformed: false,
    packageMutationPerformed: false,
    ...markerPatch,
  });
  return {
    lstatSync(target) {
      if (target === markerPath) {
        return {
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
          mode: 0o100600,
          size: Buffer.byteLength(marker),
        };
      }
      if (
        target === CANARY_BOUNDARY
        || target === path.join(CANARY_BOUNDARY, 'state')
        || target === path.join(CANARY_BOUNDARY, 'user-data')
        || target === path.join(CANARY_BOUNDARY, 'grok-home')
        || target === path.join(CANARY_BOUNDARY, 'cache')
        || target === path.join(CANARY_BOUNDARY, 'config')
        || target === path.join(CANARY_BOUNDARY, 'data')
        || target === path.join(CANARY_BOUNDARY, 'xdg-state')
      ) {
        return {
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
          mode: 0o040000 | (directoryModeByPath[target] ?? directoryMode),
          size: 0,
        };
      }
      throw new Error('unexpected path');
    },
    readFileSync(target) {
      if (target !== markerPath) throw new Error('unexpected read');
      return marker;
    },
  };
}
