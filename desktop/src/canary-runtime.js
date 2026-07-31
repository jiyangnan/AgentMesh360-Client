'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CANARY_FLAG = 'AGENTMESH360_P5_E1_CANARY';
const CANARY_AUTHORIZATION_ID = 'package_canary_e1_20260729_0002';
const CANARY_BOUNDARY = '/private/tmp/agentmesh360-p5-e1-client';
const MARKER_FILE = 'canary-boundary.json';
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

function configureP5CanaryRuntime({
  app,
  env = process.env,
  fsModule = fs,
} = {}) {
  if (env[CANARY_FLAG] !== '1') {
    return Object.freeze({ enabled: false });
  }
  if (!app || typeof app.setPath !== 'function') {
    throw new Error('P5 canary requires an Electron app path controller');
  }
  if (env.AGENTMESH360_P5_AUTHORIZATION_ID !== CANARY_AUTHORIZATION_ID) {
    throw new Error('P5 canary authorization identity is invalid');
  }
  if (
    env.AGENTMESH360_P5_BOUNDARY !== CANARY_BOUNDARY
    || path.resolve(env.AGENTMESH360_P5_BOUNDARY || '') !== CANARY_BOUNDARY
  ) {
    throw new Error('P5 canary boundary is invalid');
  }

  const stateHome = path.join(CANARY_BOUNDARY, 'state');
  const userDataHome = path.join(CANARY_BOUNDARY, 'user-data');
  const grokHome = path.join(CANARY_BOUNDARY, 'grok-home');
  const cacheHome = path.join(CANARY_BOUNDARY, 'cache');
  const configHome = path.join(CANARY_BOUNDARY, 'config');
  const dataHome = path.join(CANARY_BOUNDARY, 'data');
  const xdgStateHome = path.join(CANARY_BOUNDARY, 'xdg-state');
  if (
    env.HOME !== CANARY_BOUNDARY
    || env.AGENTMESH360_HOME !== stateHome
    || env.AGENTMESH360_P5_USER_DATA !== userDataHome
    || env.GROK_HOME !== grokHome
  ) {
    throw new Error('P5 canary HOME, state, Grok, or userData path is invalid');
  }
  if (
    env.XDG_CACHE_HOME !== cacheHome
    || env.XDG_CONFIG_HOME !== configHome
    || env.XDG_DATA_HOME !== dataHome
    || env.XDG_STATE_HOME !== xdgStateHome
  ) {
    throw new Error(
      'P5 canary XDG cache, config, data, or state path is invalid',
    );
  }
  assertPrivateDirectory(fsModule, CANARY_BOUNDARY, 'P5 canary boundary');
  assertPrivateDirectory(fsModule, stateHome, 'P5 canary state');
  assertPrivateDirectory(fsModule, grokHome, 'P5 canary Grok home');
  assertPrivateDirectory(fsModule, userDataHome, 'P5 canary userData');
  assertPrivateDirectory(fsModule, cacheHome, 'P5 canary XDG cache');
  assertPrivateDirectory(fsModule, configHome, 'P5 canary XDG config');
  assertPrivateDirectory(fsModule, dataHome, 'P5 canary XDG data');
  assertPrivateDirectory(fsModule, xdgStateHome, 'P5 canary XDG state');

  const markerPath = path.join(CANARY_BOUNDARY, MARKER_FILE);
  const markerInfo = fsModule.lstatSync(markerPath);
  if (
    !markerInfo.isFile()
    || markerInfo.isSymbolicLink()
    || markerInfo.size <= 0
    || markerInfo.size > 4096
    || (markerInfo.mode & 0o077) !== 0
  ) {
    throw new Error('P5 canary marker is invalid');
  }
  let marker;
  try {
    marker = JSON.parse(fsModule.readFileSync(markerPath, 'utf8'));
  } catch {
    throw new Error('P5 canary marker cannot be read');
  }
  if (
    marker?.schemaVersion !== 2
    || marker?.authorizationId !== CANARY_AUTHORIZATION_ID
    || marker?.boundaryId !== 'p5-e1-isolated-client-02'
    || marker?.productionAuthorityGranted !== false
    || marker?.normalStateReadable !== false
    || marker?.keychainWritePerformed !== false
    || marker?.networkRequestPerformed !== false
    || marker?.packageMutationPerformed !== false
    || marker?.executorCommit !== env.AGENTMESH360_P5_EXECUTOR_COMMIT
    || !COMMIT_PATTERN.test(marker?.executorCommit || '')
  ) {
    throw new Error('P5 canary marker does not match the execution boundary');
  }

  app.setPath('userData', userDataHome);
  return Object.freeze({
    enabled: true,
    boundaryId: marker.boundaryId,
    authorizationId: marker.authorizationId,
    executorCommit: marker.executorCommit,
    normalStateReadable: false,
    productionAuthorityGranted: false,
  });
}

function assertPrivateDirectory(fsModule, directory, label) {
  const info = fsModule.lstatSync(directory);
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || (info.mode & 0o777) !== 0o700
  ) {
    throw new Error(`${label} must be a 0700 real directory`);
  }
}

module.exports = {
  CANARY_AUTHORIZATION_ID,
  CANARY_BOUNDARY,
  CANARY_FLAG,
  MARKER_FILE,
  configureP5CanaryRuntime,
};
