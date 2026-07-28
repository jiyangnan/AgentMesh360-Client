'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CANARY_FLAG = 'AGENTMESH360_P5_E1_CANARY';
const CANARY_AUTHORIZATION_ID = 'package_canary_e1_20260729_0001';
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
  if (
    env.AGENTMESH360_HOME !== stateHome
    || env.AGENTMESH360_P5_USER_DATA !== userDataHome
  ) {
    throw new Error('P5 canary state or userData path is invalid');
  }
  assertPrivateDirectory(fsModule, CANARY_BOUNDARY, 'P5 canary boundary');
  assertPrivateDirectory(fsModule, stateHome, 'P5 canary state');
  assertPrivateDirectory(fsModule, userDataHome, 'P5 canary userData');

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
    marker?.schemaVersion !== 1
    || marker?.authorizationId !== CANARY_AUTHORIZATION_ID
    || marker?.boundaryId !== 'p5-e1-isolated-client-01'
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
    || (info.mode & 0o077) !== 0
  ) {
    throw new Error(`${label} must be a private real directory`);
  }
}

module.exports = {
  CANARY_AUTHORIZATION_ID,
  CANARY_BOUNDARY,
  CANARY_FLAG,
  MARKER_FILE,
  configureP5CanaryRuntime,
};
