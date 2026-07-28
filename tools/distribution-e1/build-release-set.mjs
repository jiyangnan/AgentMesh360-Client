#!/usr/bin/env node

import {
  chmod,
  lstat,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  CANDIDATE_COMMIT,
  runRehearsal,
} from '../release-provenance/run-e0-release-provenance.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const AUTHORIZATION_ID = 'distribution_service_e1_20260728_0001';
const PUBLISHER_KEY_ID = 'agentmesh360-publisher-e1-p4-20260728-01';

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value == null || values.has(key)) {
      throw new Error('invalid or duplicate argument');
    }
    values.set(key, value);
  }
  const allowed = new Set([
    '--deploy-source',
    '--executor-commit',
    '--job-source',
    '--lecturecast-source',
    '--origin-state',
    '--output-state',
  ]);
  if (
    values.size !== allowed.size
    || [...values.keys()].some((key) => !allowed.has(key))
    || [...allowed].some((key) => !values.has(key))
  ) {
    throw new Error(
      'usage: build-release-set.mjs --executor-commit <commit> '
      + '--origin-state <absolute> --output-state <absolute> '
      + '--deploy-source <absolute> --job-source <absolute> '
      + '--lecturecast-source <absolute>',
    );
  }
  const executorCommit = values.get('--executor-commit');
  if (!/^[0-9a-f]{40}$/u.test(executorCommit)) {
    throw new Error('executor commit is invalid');
  }
  for (const key of [
    '--origin-state',
    '--output-state',
    '--deploy-source',
    '--job-source',
    '--lecturecast-source',
  ]) {
    if (!path.isAbsolute(values.get(key))) {
      throw new Error(`${key} must be absolute`);
    }
  }
  return {
    deploySource: values.get('--deploy-source'),
    executorCommit,
    jobSource: values.get('--job-source'),
    lecturecastSource: values.get('--lecturecast-source'),
    originState: values.get('--origin-state'),
    outputState: values.get('--output-state'),
  };
}

async function readMode0600Json(filePath, label) {
  const resolved = await realpath(filePath);
  const stat = await lstat(resolved);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size <= 0
    || stat.size > 64 * 1024
    || (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error(`${label} must be a bounded mode-0600 regular file`);
  }
  try {
    return JSON.parse(await readFile(resolved, 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function releaseOriginFromState(state) {
  if (
    state?.authorizationId !== AUTHORIZATION_ID
    || state?.origin?.deployed !== true
    || !/^[0-9a-f]{40}$/u.test(state.origin?.executorCommit)
    || state.origin?.tls !== 'caddy_managed_lets_encrypt'
    || !/^packages-e1-[0-9a-f]{8}\.agentmesh360\.com$/u.test(
      state.dns?.hostname,
    )
    || state.dns?.proxied !== false
  ) {
    throw new Error('origin state is not an approved deployed E1 boundary');
  }
  return `https://${state.dns.hostname}`;
}

async function buildReleaseSet(options) {
  const originState = await readMode0600Json(
    options.originState,
    'origin state',
  );
  const result = await runRehearsal({
    approvalReceipt: 'approval_p4_e1_distribution_20260728_0001',
    candidateCommit: CANDIDATE_COMMIT,
    deploySource: options.deploySource,
    executorCommit: options.executorCommit,
    jobSource: options.jobSource,
    lecturecastSource: options.lecturecastSource,
    publisherKeyId: PUBLISHER_KEY_ID,
    releaseOrigin: releaseOriginFromState(originState),
    retainBoundary: true,
  });
  const state = {
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    candidateCommit: CANDIDATE_COMMIT,
    executorCommit: options.executorCommit,
    publisherKeyId: PUBLISHER_KEY_ID,
    releaseOrigin: releaseOriginFromState(originState),
    ...result,
    createdAt: new Date().toISOString(),
  };
  await writeFile(options.outputState, JSON.stringify(state), {
    mode: 0o600,
    flag: 'wx',
  });
  await chmod(options.outputState, 0o600);
  return state;
}

function isMainModule() {
  return process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
  if (options) {
    buildReleaseSet(options)
      .then((state) => {
        if (state.agentResults.length !== 4) {
          throw new Error('E1 Release Set agent count is invalid');
        }
        console.log(
          'E1 four-Agent dual-build Release Set retained in local temporary boundary',
        );
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}

export {
  buildReleaseSet,
  parseArguments,
  releaseOriginFromState,
};
