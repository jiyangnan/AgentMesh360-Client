#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  stat,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  validatePackageCanaryAuthorizationFile,
} from './validate-package-canary-authorization.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const APPROVED_OUTPUT_ROOT = '/private/tmp';
const EXPECTED_STATE_SCHEMA = 10;
const MAX_STATE_DB_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_TREE_BYTES = 64 * 1024 * 1024;
const KEYCHAIN_SERVICE = 'com.agentmesh360.client.provider';
const SHA256_PATTERN = /^[0-9a-f]{40}$/u;

function typedSha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(options.failureMessage ?? 'local baseline subprocess failed');
  }
  return result.stdout;
}

function gitOutput(args) {
  return run('git', args, {
    failureMessage: 'repository baseline check failed',
  }).trim();
}

function localRepositoryState() {
  return {
    head: gitOutput(['rev-parse', 'HEAD']),
    originMain: gitOutput(['rev-parse', 'origin/main']),
    clean: gitOutput(['status', '--porcelain']) === '',
  };
}

function sqliteOutput(databasePath, sql) {
  return run(
    'sqlite3',
    [
      '-readonly',
      '-json',
      `file:${databasePath}?immutable=1`,
      `PRAGMA query_only=ON; ${sql}`,
    ],
    { failureMessage: 'normal state baseline cannot be read immutably' },
  );
}

function parseSingleJsonArray(output, label) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`${label} returned an unexpected row count`);
  }
  return parsed[0];
}

async function inspectRegularFile(filePath, label, maximumBytes) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  if (info.size <= 0 || info.size > maximumBytes) {
    throw new Error(`${label} size is outside the approved bound`);
  }
  return info;
}

async function hashPackageTree(packageRoot) {
  let rootInfo;
  try {
    rootInfo = await lstat(packageRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        entryCount: 0,
        byteCount: 0,
        treeDigest: typedSha256(Buffer.from('absent-package-tree-v1')),
      };
    }
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('normal package root must be a real directory');
  }

  const digest = createHash('sha256');
  let entryCount = 0;
  let byteCount = 0;

  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const relativeName = path.posix.join(relativeDirectory, entry.name);
      const absoluteName = path.join(directory, entry.name);
      const info = await lstat(absoluteName);
      if (info.isSymbolicLink()) {
        throw new Error('normal package tree contains a symbolic link');
      }
      if (entry.isDirectory()) {
        digest.update(`d\0${relativeName}\0${info.mode & 0o777}\n`);
        entryCount += 1;
        await visit(absoluteName, relativeName);
      } else if (entry.isFile()) {
        byteCount += info.size;
        if (byteCount > MAX_PACKAGE_TREE_BYTES) {
          throw new Error('normal package tree exceeds the approved read bound');
        }
        const handle = await open(absoluteName, 'r');
        try {
          const bytes = await handle.readFile();
          digest.update(
            `f\0${relativeName}\0${info.mode & 0o777}\0${info.size}\0`,
          );
          digest.update(bytes);
          digest.update('\n');
        } finally {
          await handle.close();
        }
        entryCount += 1;
      } else {
        throw new Error('normal package tree contains a special file');
      }
    }
  }

  await visit(packageRoot, '');
  return {
    entryCount,
    byteCount,
    treeDigest: `sha256:${digest.digest('hex')}`,
  };
}

function validateSavedSecret(environment, variableName) {
  const secret = environment[variableName];
  if (
    typeof secret !== 'string'
    || secret.trim() !== secret
    || secret.includes('\0')
    || secret.length < 8
    || secret.length > 8192
  ) {
    throw new Error('approved saved Provider credential is unavailable');
  }
}

function keychainServicePresent() {
  const result = spawnSync(
    'security',
    ['find-generic-password', '-s', KEYCHAIN_SERVICE],
    { stdio: 'ignore' },
  );
  if (result.error) {
    throw new Error('Keychain baseline check is unavailable');
  }
  if (result.status === 0) return true;
  if (result.status === 44) return false;
  throw new Error('Keychain baseline check failed');
}

function exactInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

async function validateOutputPath(outputPath) {
  if (path.dirname(outputPath) !== APPROVED_OUTPUT_ROOT) {
    throw new Error('baseline output must be a direct child of the approved root');
  }
  const outputRoot = await realpath(APPROVED_OUTPUT_ROOT);
  if (outputRoot !== APPROVED_OUTPUT_ROOT) {
    throw new Error('approved output root is not canonical');
  }
  try {
    await lstat(outputPath);
    throw new Error('baseline output already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function captureLocalCanaryBaseline({
  authorizationPath,
  outputPath,
  stateHome = path.join(os.homedir(), '.agentmesh360'),
  now = new Date(),
  environment = process.env,
  expectedExecutorCommit,
  keychainProbe = keychainServicePresent,
  repositoryProbe = localRepositoryState,
} = {}) {
  const authorizationErrors =
    await validatePackageCanaryAuthorizationFile(authorizationPath);
  if (authorizationErrors.length > 0) {
    throw new Error('P5 E1 authorization is invalid');
  }
  const authorizationBytes = await readFile(authorizationPath);
  const authorization = JSON.parse(authorizationBytes.toString('utf8'));

  const currentTime = now.getTime();
  const startsAt = Date.parse(authorization.authorizationWindow.startsAt);
  const stopsAt = Date.parse(authorization.authorizationWindow.stopsAt);
  if (
    !Number.isFinite(currentTime)
    || currentTime < startsAt
    || currentTime >= stopsAt
  ) {
    throw new Error('P5 E1 authorization window is not active');
  }

  const repository = repositoryProbe();
  const { head, originMain } = repository;
  if (
    !SHA256_PATTERN.test(head)
    || head !== originMain
    || head !== expectedExecutorCommit
  ) {
    throw new Error('baseline executor is not the frozen pushed commit');
  }
  if (!repository.clean) {
    throw new Error('repository must be clean before baseline capture');
  }

  if (
    process.platform !== 'darwin'
    || authorization.cohort.deviceCount !== 1
    || authorization.cohort.accountCount !== 1
  ) {
    throw new Error('P5 E1 cohort does not match this single-Mac executor');
  }

  validateSavedSecret(
    environment,
    authorization.providerPlan.sourceEnvironmentVariable,
  );
  const preexistingProductKeychainCredential = keychainProbe();
  if (preexistingProductKeychainCredential) {
    throw new Error('product Keychain is not empty before canary assembly');
  }

  const stateHomeInfo = await lstat(stateHome);
  if (!stateHomeInfo.isDirectory() || stateHomeInfo.isSymbolicLink()) {
    throw new Error('normal AgentMesh360 state home is invalid');
  }
  const stateDb = path.join(stateHome, 'state.db');
  const before = await inspectRegularFile(
    stateDb,
    'normal AgentMesh360 state database',
    MAX_STATE_DB_BYTES,
  );

  const schemaRow = parseSingleJsonArray(
    sqliteOutput(stateDb, 'SELECT user_version AS schemaVersion FROM pragma_user_version;'),
    'normal state schema query',
  );
  if (schemaRow.schemaVersion !== EXPECTED_STATE_SCHEMA) {
    throw new Error('normal AgentMesh360 state schema is unexpected');
  }
  const summary = parseSingleJsonArray(
    sqliteOutput(
      stateDb,
      `SELECT
        (
          SELECT COUNT(DISTINCT owner_account_id)
          FROM (
            SELECT owner_account_id FROM provider_profiles
            UNION ALL
            SELECT owner_account_id FROM product_agents
              WHERE owner_account_id IS NOT NULL
            UNION ALL
            SELECT owner_account_id FROM model_assignments
          )
        ) AS ownerAccountCount,
        (SELECT COUNT(*) FROM provider_profiles) AS providerProfileCount,
        (SELECT COUNT(*) FROM agent_package_registry) AS packageRegistryCount,
        (SELECT COUNT(*) FROM package_trust_cache) AS trustCacheCount,
        (SELECT COUNT(*) FROM package_registry_fetch_state) AS registryFetchCount;`,
    ),
    'normal state summary query',
  );
  const packageStateBytes = sqliteOutput(
    stateDb,
    `SELECT * FROM agent_package_registry ORDER BY package_id;
     SELECT * FROM package_trust_cache ORDER BY singleton_id;
     SELECT * FROM package_registry_fetch_state ORDER BY singleton_id;`,
  );
  const packageTree = await hashPackageTree(path.join(stateHome, 'packages'));
  const after = await stat(stateDb);
  const normalStateUnchanged =
    before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs;
  if (!normalStateUnchanged) {
    throw new Error('normal AgentMesh360 state changed during baseline capture');
  }

  await validateOutputPath(outputPath);
  const receipt = {
    schemaVersion: 1,
    baselineId: authorization.schemaVersion === 2
      ? 'package_canary_e1_local_baseline_20260729_0002'
      : 'package_canary_e1_local_baseline_20260729_0001',
    authorizationId: authorization.authorizationId,
    capturedAt: now.toISOString(),
    executorCommit: head,
    authorizationSha256: typedSha256(authorizationBytes),
    cohort: {
      accountAlias: authorization.cohort.accountAlias,
      deviceAlias: authorization.cohort.deviceAlias,
      accountCount: 1,
      deviceCount: 1,
      platform: 'macos',
      architecture: process.arch,
      realIdentifiersRetained: false,
    },
    provider: {
      presetId: authorization.providerPlan.presetId,
      modelId: authorization.providerPlan.modelId,
      savedSourceCredentialPresent: true,
      preexistingProductKeychainCredentialPresent: false,
      inferenceRequestsUsed: 0,
      agentMeshCreditsUsed: 0,
      providerCostUsd: 0,
    },
    account: {
      subscriptionRevalidation: 'pending_live_client_bootstrap',
      subscriptionMutationPerformed: false,
      accountMutationPerformed: false,
    },
    normalState: {
      schemaVersion: schemaRow.schemaVersion,
      ownerAccountCount: exactInteger(
        summary.ownerAccountCount,
        'normal owner account count',
      ),
      providerProfileCount: exactInteger(
        summary.providerProfileCount,
        'normal Provider profile count',
      ),
      packageRegistryCount: exactInteger(
        summary.packageRegistryCount,
        'normal Package Registry count',
      ),
      trustCacheCount: exactInteger(
        summary.trustCacheCount,
        'normal Trust Cache count',
      ),
      registryFetchCount: exactInteger(
        summary.registryFetchCount,
        'normal Registry fetch count',
      ),
      packageStateDigest: typedSha256(packageStateBytes),
      packageTree,
      stateDirectoryModeRestricted: (stateHomeInfo.mode & 0o077) === 0,
      stateDatabaseModeRestricted: (before.mode & 0o077) === 0,
      unchangedDuringCapture: true,
    },
    execution: {
      externalNetworkRequestsUsed: 0,
      infrastructureResourcesCreated: 0,
      keychainWritesPerformed: 0,
      packageMutationsPerformed: 0,
      productionMutationsPerformed: 0,
    },
    retention: {
      credentialsRetained: false,
      credentialDigestsRetained: false,
      pathsRetained: false,
      personalIdentifiersRetained: false,
      rawPackageOrTrustDocumentsRetained: false,
    },
    gate: {
      localBaselinePassed: true,
      cloudAssemblyAllowed: false,
      nextRequiredGate: 'live_subscription_and_isolated_client_assembly',
    },
  };

  const handle = await open(outputPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return receipt;
}

function usage() {
  process.stderr.write(
    'usage: node capture-local-canary-baseline.mjs '
      + '<authorization.json> <executor-commit> <output.json>\n',
  );
}

async function main() {
  const [authorizationPath, expectedExecutorCommit, outputPath] =
    process.argv.slice(2);
  if (!authorizationPath || !expectedExecutorCommit || !outputPath) {
    usage();
    process.exitCode = 2;
    return;
  }
  try {
    await captureLocalCanaryBaseline({
      authorizationPath: path.resolve(authorizationPath),
      expectedExecutorCommit,
      outputPath: path.resolve(outputPath),
    });
    process.stdout.write('local canary baseline captured\n');
  } catch (error) {
    process.stderr.write(`local canary baseline blocked: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
