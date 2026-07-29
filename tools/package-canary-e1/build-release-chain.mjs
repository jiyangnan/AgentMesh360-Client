#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
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
  AGENT_PLANS,
  CANDIDATE_COMMIT,
  destroyRetainedRehearsal,
  runRehearsal,
} from '../release-provenance/run-e0-release-provenance.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const PREFLIGHT_PATH = path.join(
  REPOSITORY_ROOT,
  'docs/operations/tabletops/2026-07-29-p5-release-chain-preflight.json',
);
const AUTHORIZATION_ID = 'package_canary_e1_20260729_0002';
const PUBLISHER_KEY_IDS = Object.freeze({
  a: 'agentmesh360-publisher-e1-p5-20260729-a',
  b: 'agentmesh360-publisher-e1-p5-20260729-b',
});
const ORIGIN_STATE_PATH =
  '/private/tmp/agentmesh360-p5-e1-infrastructure/origin-state.json';
const OUTPUT_STATE_PATH =
  '/private/tmp/agentmesh360-p5-e1-release-chain-state.json';
const EXPECTED_GENERATIONS = Object.freeze({
  a: Object.freeze([
    'deploy-agent@0.1.1',
    'future-agent@1.0.0',
    'job-agent@0.4.7',
    'lecturecast-agent@0.4.0',
  ]),
  b: Object.freeze([
    'job-agent@0.4.8-e1.1',
    'job-agent@0.4.9-e1.1',
  ]),
});
const MAX_FILE_BYTES = 256 * 1024;

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error('P5 build executor git inspection failed');
  }
  return result.stdout.trim();
}

function assertFrozenExecutor(executorCommit, preflightCommit) {
  if (
    !/^[0-9a-f]{40}$/u.test(executorCommit)
    || !/^[0-9a-f]{40}$/u.test(preflightCommit)
    || runGit(['rev-parse', 'HEAD']) !== executorCommit
    || runGit(['rev-parse', 'origin/main']) !== executorCommit
    || runGit(['status', '--porcelain=v1', '--untracked-files=all']) !== ''
  ) {
    throw new Error('P5 build executor is not the clean pushed commit');
  }
  const ancestor = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', preflightCommit, executorCommit],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8' },
  );
  if (ancestor.error || ancestor.status !== 0) {
    throw new Error('P5 release-chain preflight is not an executor ancestor');
  }
}

async function readBoundedJson(filePath, label, requireMode0600 = false) {
  const direct = await lstat(filePath);
  if (direct.isSymbolicLink()) {
    throw new Error(`${label} is not an approved bounded JSON file`);
  }
  const resolved = await realpath(filePath);
  const info = await lstat(resolved);
  if (
    !info.isFile()
    || info.size <= 0
    || info.size > MAX_FILE_BYTES
    || (requireMode0600 && (info.mode & 0o777) !== 0o600)
  ) {
    throw new Error(`${label} is not an approved bounded JSON file`);
  }
  try {
    return JSON.parse(await readFile(resolved, 'utf8'));
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
}

function releaseOriginFromState(state) {
  if (
    state?.authorizationId !== AUTHORIZATION_ID
    || state?.origin?.deployed !== true
    || !/^[0-9a-f]{40}$/u.test(state.origin?.executorCommit)
    || state.origin?.tls !== 'caddy_managed_lets_encrypt'
    || !/^packages-p5-e1-[0-9a-f]{8}\.agentmesh360\.com$/u.test(
      state.dns?.hostname,
    )
    || state.dns?.proxied !== false
    || state.infrastructure?.dropletCount !== 1
    || state.infrastructure?.spacesBucketCount !== 2
  ) {
    throw new Error('origin state is not the approved P5 E1 boundary');
  }
  return `https://${state.dns.hostname}`;
}

function validatePreflight(preflight) {
  if (
    preflight?.authorizationId !== AUTHORIZATION_ID
    || preflight.executionStatus !== 'release_chain_preflight_passed'
    || preflight.releaseChain?.candidateCommit !== CANDIDATE_COMMIT
    || preflight.releaseChain?.dualBuildRequired !== true
    || preflight.authority?.productionAuthorityGranted !== false
    || preflight.authority?.productionConstantsMutable !== false
    || preflight.gates?.releaseBuildAllowed !== true
    || preflight.gates?.p6Allowed !== false
    || preflight.infrastructure?.hardCapUsd !== 3
    || preflight.releaseChain?.generations?.length !== 2
  ) {
    throw new Error('P5 release-chain preflight does not permit this build');
  }
  for (const generation of ['a', 'b']) {
    const value = preflight.releaseChain.generations.find(
      (entry) => entry.generation === generation,
    );
    if (
      !value
      || value.publisherKeyAlias !== `p5-e1-publisher-${generation}`
      || value.releases?.join('\n')
        !== EXPECTED_GENERATIONS[generation].join('\n')
    ) {
      throw new Error('P5 release-chain generation plan drift');
    }
  }
  return preflight.executorCommit;
}

function assertGeneration(result, generation) {
  const expected = EXPECTED_GENERATIONS[generation];
  const actual = result.agentResults?.map(
    (agent) => `${agent.agentId}@${agent.version}`,
  );
  if (
    result.agentPlan !== (
      generation === 'a' ? AGENT_PLANS.baseline : AGENT_PLANS.p5JobVariants
    )
    || actual?.join('\n') !== expected.join('\n')
    || !result.agentResults.every(
      (agent) =>
        agent.status === 'passed'
        && agent.buildCount === 2
        && agent.signatureVerificationCount === 2
        && agent.outputComparisons?.length === 10
        && agent.outputComparisons.every(
          (comparison) => comparison.byteIdentical === true,
        ),
    )
  ) {
    throw new Error(`P5 Release generation ${generation} is incomplete`);
  }
}

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
  const required = [
    '--deploy-source',
    '--executor-commit',
    '--job-source',
    '--lecturecast-source',
    '--origin-state',
    '--output-state',
  ];
  if (
    values.size !== required.length
    || required.some((key) => !values.has(key))
    || required
      .filter((key) => key !== '--executor-commit')
      .some((key) => !path.isAbsolute(values.get(key)))
    || !/^[0-9a-f]{40}$/u.test(values.get('--executor-commit'))
    || values.get('--origin-state') !== ORIGIN_STATE_PATH
    || values.get('--output-state') !== OUTPUT_STATE_PATH
  ) {
    throw new Error(
      'usage: build-release-chain.mjs --executor-commit <commit> '
      + '--origin-state <absolute> --output-state <absolute> '
      + '--deploy-source <absolute> --job-source <absolute> '
      + '--lecturecast-source <absolute>',
    );
  }
  return {
    deploySource: values.get('--deploy-source'),
    executorCommit: values.get('--executor-commit'),
    jobSource: values.get('--job-source'),
    lecturecastSource: values.get('--lecturecast-source'),
    originState: values.get('--origin-state'),
    outputState: values.get('--output-state'),
  };
}

async function buildReleaseChain(options) {
  const [preflight, originState] = await Promise.all([
    readBoundedJson(PREFLIGHT_PATH, 'P5 release-chain preflight'),
    readBoundedJson(options.originState, 'P5 origin state', true),
  ]);
  const preflightCommit = validatePreflight(preflight);
  assertFrozenExecutor(options.executorCommit, preflightCommit);
  const releaseOrigin = releaseOriginFromState(originState);
  const completed = [];
  try {
    const generationA = await runRehearsal({
      agentPlan: AGENT_PLANS.baseline,
      approvalReceipt: 'approval_p5_e1_package_canary_20260729_0002',
      candidateCommit: CANDIDATE_COMMIT,
      deploySource: options.deploySource,
      executorCommit: options.executorCommit,
      jobSource: options.jobSource,
      lecturecastSource: options.lecturecastSource,
      publisherKeyId: PUBLISHER_KEY_IDS.a,
      releaseOrigin,
      retainBoundary: true,
    });
    completed.push(generationA);
    assertGeneration(generationA, 'a');
    const generationB = await runRehearsal({
      agentPlan: AGENT_PLANS.p5JobVariants,
      approvalReceipt: 'approval_p5_e1_package_canary_20260729_0002',
      candidateCommit: CANDIDATE_COMMIT,
      deploySource: options.deploySource,
      executorCommit: options.executorCommit,
      jobSource: options.jobSource,
      lecturecastSource: options.lecturecastSource,
      publisherKeyId: PUBLISHER_KEY_IDS.b,
      releaseOrigin,
      retainBoundary: true,
    });
    completed.push(generationB);
    assertGeneration(generationB, 'b');
    const state = {
      schemaVersion: 1,
      authorizationId: AUTHORIZATION_ID,
      executionStatus: 'release_chain_built',
      candidateCommit: CANDIDATE_COMMIT,
      preflightCommit,
      executorCommit: options.executorCommit,
      releaseOrigin,
      generations: [
        {
          generation: 'a',
          publisherKeyId: PUBLISHER_KEY_IDS.a,
          ...generationA,
        },
        {
          generation: 'b',
          publisherKeyId: PUBLISHER_KEY_IDS.b,
          ...generationB,
        },
      ],
      temporaryPublisherPrivateKeyCount: 2,
      temporaryRootPrivateKeyCount: 0,
      productionAuthorityGranted: false,
      cleanupRequired: true,
      createdAt: new Date().toISOString(),
    };
    await writeFile(options.outputState, JSON.stringify(state), {
      mode: 0o600,
      flag: 'wx',
    });
    await chmod(options.outputState, 0o600);
    return state;
  } catch (error) {
    let cleanupError;
    for (const result of completed.reverse()) {
      try {
        await destroyRetainedRehearsal(result);
      } catch (failure) {
        cleanupError ??= failure;
      }
    }
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'P5 build failed and retained Publisher cleanup also failed',
      );
    }
    throw error;
  }
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
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
  if (options) {
    buildReleaseChain(options)
      .then(() => {
        process.stdout.write(
          'P5 E1 two-generation Release Chain retained in isolated boundaries\n',
        );
      })
      .catch(() => {
        process.stderr.write(
          'P5 E1 Release Chain build failed; inspect bounded local state\n',
        );
        process.exitCode = 1;
      });
  }
}

export {
  AUTHORIZATION_ID,
  EXPECTED_GENERATIONS,
  ORIGIN_STATE_PATH,
  OUTPUT_STATE_PATH,
  PUBLISHER_KEY_IDS,
  assertGeneration,
  buildReleaseChain,
  parseArguments,
  releaseOriginFromState,
  validatePreflight,
};
