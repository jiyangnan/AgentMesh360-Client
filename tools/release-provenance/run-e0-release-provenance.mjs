#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  assertReleaseProvenanceReceiptSafeForRetention,
  validateReleaseProvenanceReceipt,
} from './validate-release-provenance-receipt.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const WORKER = path.join(MODULE_DIRECTORY, 'e0-release-signer.mjs');
const RECEIPT_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  'docs/operations/tabletops',
);
const CANDIDATE_COMMIT = 'e1ef8db19dc58a2c9cec19ac34f7e1966d741b7c';
const CANDIDATE_LOCK_SHA256 =
  'sha256:2f71e6935920a35726095642d8a1a87067c6990f44685140b77ba19f9ee82a48';
const SOURCE_COMMITS = Object.freeze({
  deploy: '781599f9b8ab1374f8a9b018da553d425cd23e13',
  job: 'ed8f1c683d5d3bf8103de4c12f9f395e82251e9a',
  lecturecast: '688dd61ab1910fec03383f18bdfaee74ed67ecac',
});
const OUTPUT_CLASSES = Object.freeze([
  'artifact',
  'envelope',
  'finalize_receipt',
  'host_bundles',
  'host_projection',
  'package_file_manifest',
  'registry_record',
  'release_manifest',
  'signature_result',
  'signing_request',
]);
const EXECUTOR_EVIDENCE_PATHS = Object.freeze([
  'crates/codegen/xai-grok-shell/src/agentmesh360/mod.rs',
  'crates/codegen/xai-grok-shell/src/agentmesh360/package_release.rs',
  'crates/codegen/xai-grok-shell/src/agentmesh360/package_release_authoring.rs',
  'crates/codegen/xai-grok-shell/src/agentmesh360/package_trust.rs',
  'crates/codegen/xai-grok-shell/src/bin/agentmesh360-package-author.rs',
  'fixtures/release-provenance/future-agent',
  'schemas/agentmesh360-release-provenance-receipt-v1.schema.json',
  'tools/release-provenance/e0-release-signer.mjs',
  'tools/release-provenance/run-e0-release-provenance.mjs',
  'tools/release-provenance/validate-release-provenance-receipt.mjs',
]);
const PRIVATE_FILE_EXTENSIONS = new Set([
  '.key',
  '.p8',
  '.p12',
  '.pem',
  '.pfx',
  '.pk8',
]);
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;

function usage() {
  return [
    'usage: node run-e0-release-provenance.mjs',
    '  --execute-approved-p3-e0',
    '  --approval-receipt <approval_p3_e0_...>',
    '  --rehearsal-id <release_provenance_e0_...>',
    `  --candidate-commit ${CANDIDATE_COMMIT}`,
    '  --executor-commit <40 lowercase hex>',
    '  --publisher-key-id <agentmesh360-publisher-e0-p3-...>',
    '  --deploy-source <clean local source directory>',
    '  --job-source <clean local source directory>',
    '  --lecturecast-source <clean local source directory>',
    '  --output <docs/operations/tabletops/*.json>',
  ].join('\n');
}

function parseArguments(argv) {
  const values = new Map();
  let acknowledged = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute-approved-p3-e0') {
      acknowledged = true;
      continue;
    }
    if (!argument.startsWith('--') || index + 1 >= argv.length) {
      throw new Error(usage());
    }
    if (values.has(argument)) throw new Error('duplicate argument');
    values.set(argument, argv[index + 1]);
    index += 1;
  }
  if (!acknowledged) {
    throw new Error(
      'refusing to generate a test Publisher without --execute-approved-p3-e0\n'
      + usage(),
    );
  }
  const allowed = new Set([
    '--approval-receipt',
    '--candidate-commit',
    '--deploy-source',
    '--executor-commit',
    '--job-source',
    '--lecturecast-source',
    '--output',
    '--publisher-key-id',
    '--rehearsal-id',
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Error('unknown argument');
  }
  for (const key of allowed) {
    if (!values.has(key)) throw new Error(`missing required argument: ${key}`);
  }

  const approvalReceipt = values.get('--approval-receipt');
  const rehearsalId = values.get('--rehearsal-id');
  const candidateCommit = values.get('--candidate-commit');
  const executorCommit = values.get('--executor-commit');
  const publisherKeyId = values.get('--publisher-key-id');
  if (!/^approval_p3_e0_[a-z0-9][a-z0-9_-]{7,63}$/u.test(approvalReceipt)) {
    throw new Error('approval receipt identifier is invalid');
  }
  if (
    !/^release_provenance_e0_[a-z0-9][a-z0-9_-]{7,63}$/u.test(rehearsalId)
  ) {
    throw new Error('rehearsal identifier is invalid');
  }
  if (candidateCommit !== CANDIDATE_COMMIT) {
    throw new Error('candidate commit differs from the approved P3 commit');
  }
  if (!/^[0-9a-f]{40}$/u.test(executorCommit)) {
    throw new Error('executor commit is invalid');
  }
  if (
    !/^agentmesh360-publisher-e0-p3-[a-z0-9][a-z0-9_-]{7,63}$/u
      .test(publisherKeyId)
  ) {
    throw new Error('test Publisher key identifier is invalid');
  }

  const outputPath = path.resolve(values.get('--output'));
  if (
    path.dirname(outputPath) !== RECEIPT_DIRECTORY
    || path.extname(outputPath) !== '.json'
  ) {
    throw new Error('receipt output must be a JSON file in the tabletop directory');
  }
  return {
    approvalReceipt,
    candidateCommit,
    deploySource: path.resolve(values.get('--deploy-source')),
    executorCommit,
    jobSource: path.resolve(values.get('--job-source')),
    lecturecastSource: path.resolve(values.get('--lecturecast-source')),
    outputPath,
    publisherKeyId,
    rehearsalId,
  };
}

function run(command, args, options, label) {
  const result = spawnSync(command, args, {
    cwd: options?.cwd,
    encoding: 'utf8',
    env: options?.env,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
  });
  if (result.error || result.status !== 0) {
    const diagnostic = sanitizedCommandDiagnostic(result.stderr);
    throw new Error(
      diagnostic ? `${label} failed: ${diagnostic}` : `${label} failed`,
    );
  }
  return result.stdout.trim();
}

function sanitizedCommandDiagnostic(stderr) {
  if (typeof stderr !== 'string') return '';
  const lines = stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1) ?? '';
  return last
    .replace(/\/[^\s:]+/gu, '<path>')
    .replace(/[A-Za-z]:\\[^\s:]+/gu, '<path>')
    .slice(0, 320);
}

function git(args, cwd, label) {
  return run('git', args, { cwd }, label);
}

function typedSha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function readRegularFile(filePath, maximum = 256 * 1024 * 1024) {
  const stat = await lstat(filePath);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size < 0
    || stat.size > maximum
  ) {
    throw new Error('expected a bounded regular file');
  }
  return readFile(filePath);
}

async function assertNewOutput(filePath) {
  try {
    await lstat(filePath);
    throw new Error('receipt output already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function assertCleanRepository(root, expectedCommit, label) {
  const resolved = await realpath(root);
  const commit = git(['rev-parse', 'HEAD'], resolved, `${label} commit inspection`);
  if (commit !== expectedCommit) throw new Error(`${label} commit drift`);
  const status = git(
    ['status', '--porcelain=v1', '--untracked-files=all'],
    resolved,
    `${label} clean-tree inspection`,
  );
  if (status !== '') throw new Error(`${label} source tree is dirty`);
  return resolved;
}

async function assertSourceRepository(root, expectedCommit, label) {
  const resolved = await realpath(root);
  const status = git(
    ['status', '--porcelain=v1', '--untracked-files=all'],
    resolved,
    `${label} clean-tree inspection`,
  );
  if (status !== '') throw new Error(`${label} source tree is dirty`);
  git(
    ['cat-file', '-e', `${expectedCommit}^{commit}`],
    resolved,
    `${label} frozen commit inspection`,
  );
  return resolved;
}

async function assertRepositoryBoundary(options) {
  await assertCleanRepository(
    REPOSITORY_ROOT,
    options.executorCommit,
    'executor repository',
  );
  try {
    await lstat(path.join(REPOSITORY_ROOT, 'target'));
    throw new Error('repository target directory exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const tracked = git(
    ['ls-files', '-co', '--exclude-standard', '-z'],
    REPOSITORY_ROOT,
    'repository file inventory',
  );
  for (const entry of tracked.split('\0').filter(Boolean)) {
    if (PRIVATE_FILE_EXTENSIONS.has(path.extname(entry).toLowerCase())) {
      throw new Error('private-material extension exists in repository');
    }
  }
  const trustSource = await readFile(
    path.join(
      REPOSITORY_ROOT,
      'crates/codegen/xai-grok-shell/src/agentmesh360/package_trust.rs',
    ),
    'utf8',
  );
  const fetcherSource = await readFile(
    path.join(
      REPOSITORY_ROOT,
      'crates/codegen/xai-grok-shell/src/agentmesh360/package_registry_fetcher.rs',
    ),
    'utf8',
  );
  if (
    !trustSource.includes(
      'const EMBEDDED_PUBLISHER_TRUST_BUNDLE: Option<&str> = None;',
    )
    || !fetcherSource.includes(
      'const PRODUCTION_TRUST_BUNDLE_URL: Option<&str> = None;',
    )
    || !fetcherSource.includes(
      'const PRODUCTION_REGISTRY_URL: Option<&str> = None;',
    )
  ) {
    throw new Error('production Package constants are not empty');
  }
}

async function collectTreeFiles(root) {
  const files = [];
  async function walk(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('output tree contains a symlink');
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        files.push({
          bytes: await readRegularFile(absolute),
          relative,
        });
      } else {
        throw new Error('output tree contains a non-regular entry');
      }
    }
  }
  await walk(root, '');
  return files;
}

function treeDigest(files) {
  const hash = createHash('sha256');
  hash.update('agentmesh360-output-tree-v1\n');
  for (const file of files) {
    hash.update(file.relative);
    hash.update('\0');
    hash.update(String(file.bytes.length));
    hash.update('\0');
    hash.update(createHash('sha256').update(file.bytes).digest('hex'));
    hash.update('\n');
  }
  return `sha256:${hash.digest('hex')}`;
}

async function compareOutputClass(left, right, outputClass) {
  const leftFiles = left.kind === 'tree'
    ? await collectTreeFiles(left.path)
    : [{ relative: path.basename(left.path), bytes: await readRegularFile(left.path) }];
  const rightFiles = right.kind === 'tree'
    ? await collectTreeFiles(right.path)
    : [{ relative: path.basename(right.path), bytes: await readRegularFile(right.path) }];
  if (
    leftFiles.length !== rightFiles.length
    || leftFiles.some(
      (file, index) =>
        file.relative !== rightFiles[index]?.relative
        || !file.bytes.equals(rightFiles[index]?.bytes),
    )
  ) {
    throw new Error(`${outputClass} build output mismatch`);
  }
  return {
    outputClass,
    byteIdentical: true,
    sha256: treeDigest(leftFiles),
    fileCount: leftFiles.length,
  };
}

async function executorSourceDigest() {
  const files = [];
  for (const relative of EXECUTOR_EVIDENCE_PATHS) {
    const absolute = path.join(REPOSITORY_ROOT, relative);
    const stat = await lstat(absolute);
    if (stat.isDirectory()) {
      for (const file of await collectTreeFiles(absolute)) {
        files.push({
          relative: `${relative}/${file.relative}`,
          bytes: file.bytes,
        });
      }
    } else if (stat.isFile() && !stat.isSymbolicLink()) {
      files.push({ relative, bytes: await readRegularFile(absolute) });
    } else {
      throw new Error('executor evidence source is not a regular file tree');
    }
  }
  files.sort((left, right) =>
    Buffer.from(left.relative).compare(Buffer.from(right.relative)));
  return treeDigest(files);
}

function parseJsonOutput(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} returned an invalid receipt`);
  }
  return parsed;
}

function callWorker(boundary, request) {
  const result = spawnSync(process.execPath, [WORKER], {
    encoding: 'utf8',
    input: JSON.stringify({ ...request, boundary }),
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error('isolated release signer operation failed');
  }
  return parseJsonOutput(result.stdout, 'isolated release signer');
}

async function buildExecutorBinary(label, targetRoot, destination) {
  run(
    'cargo',
    [
      'build',
      '--offline',
      '--locked',
      '-p',
      'xai-grok-shell',
      '--bin',
      'agentmesh360-package-author',
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        CARGO_INCREMENTAL: '0',
        CARGO_TARGET_DIR: targetRoot,
      },
    },
    `${label} offline executor build`,
  );
  await copyFile(
    path.join(targetRoot, 'debug/agentmesh360-package-author'),
    destination,
  );
  await chmod(destination, 0o700);
}

function validateBuildReceipt(receipt, agent) {
  if (
    receipt.packageId !== agent.packageId
    || receipt.agentId !== agent.agentId
    || receipt.version !== agent.version
    || typeof receipt.artifactPath !== 'string'
    || typeof receipt.signingRequestPath !== 'string'
    || typeof receipt.hostProjectionPath !== 'string'
  ) {
    throw new Error('Package build receipt identity is invalid');
  }
}

async function buildAgent(binary, label, agent, outputRoot, keyId) {
  const output = path.join(outputRoot, agent.agentId);
  const stdout = run(
    binary,
    packageBuildArguments(agent, output, keyId),
    undefined,
    `${label} ${agent.agentId} Package build`,
  );
  const receipt = parseJsonOutput(stdout, 'Package build');
  validateBuildReceipt(receipt, agent);
  for (const filePath of [
    receipt.artifactPath,
    receipt.signingRequestPath,
    receipt.hostProjectionPath,
  ]) {
    const parent = await realpath(path.dirname(filePath));
    if (parent !== await realpath(output)) {
      throw new Error('Package build receipt escaped its output directory');
    }
  }
  return { output, receipt };
}

function packageBuildArguments(agent, output, keyId) {
  return [
    'build',
    '--definition',
    agent.definition,
    '--source',
    agent.source,
    '--key-id',
    keyId,
    '--output',
    output,
  ];
}

async function signBuild(boundary, privateKeyPath, build, keyId) {
  const request = parseJsonOutput(
    (await readRegularFile(build.receipt.signingRequestPath, 1024 * 1024))
      .toString('utf8'),
    'Package signing request',
  );
  if (
    request.keyId !== keyId
    || typeof request.payloadBase64 !== 'string'
  ) {
    throw new Error('Package signing request key binding is invalid');
  }
  const signed = callWorker(boundary, {
    action: 'sign',
    payloadBase64: request.payloadBase64,
    target: privateKeyPath,
  });
  if (
    typeof signed.signatureBase64 !== 'string'
    || !/^sha256:[0-9a-f]{64}$/u.test(signed.signatureSha256)
  ) {
    throw new Error('isolated release signer returned invalid signature evidence');
  }
  const signatureResultPath = path.join(
    build.output,
    'signature-result.v1.json',
  );
  await writeFile(
    signatureResultPath,
    JSON.stringify({
      schemaVersion: 1,
      algorithm: 'ed25519',
      keyId,
      signature: signed.signatureBase64,
    }),
    { flag: 'wx', mode: 0o600 },
  );
  return signatureResultPath;
}

function validateAssemblyReceipt(receipt, agent, keyId) {
  if (
    receipt.packageId !== agent.packageId
    || receipt.agentId !== agent.agentId
    || receipt.version !== agent.version
    || receipt.keyId !== keyId
    || !Array.isArray(receipt.hostBundles)
  ) {
    throw new Error('Release assembly receipt identity is invalid');
  }
}

async function assembleAgent(
  binary,
  label,
  agent,
  build,
  signatureResultPath,
  publicKeyPath,
  releaseRoot,
  keyId,
  releaseBaseUrl,
) {
  const output = path.join(releaseRoot, agent.agentId);
  const stdout = run(
    binary,
    [
      'assemble-release',
      '--request',
      build.receipt.signingRequestPath,
      '--artifact',
      build.receipt.artifactPath,
      '--signature-result',
      signatureResultPath,
      '--public-key',
      publicKeyPath,
      '--host-projection',
      build.receipt.hostProjectionPath,
      '--output',
      output,
      '--release-base-url',
      releaseBaseUrl,
    ],
    undefined,
    `${label} ${agent.agentId} Release assembly`,
  );
  const receipt = parseJsonOutput(stdout, 'Release assembly');
  validateAssemblyReceipt(receipt, agent, keyId);
  return { output, receipt, signatureResultPath };
}

function outputLocations(build, assembled) {
  return {
    artifact: { kind: 'file', path: build.receipt.artifactPath },
    envelope: {
      kind: 'file',
      path: path.join(assembled.output, assembled.receipt.envelope.fileName),
    },
    finalize_receipt: {
      kind: 'file',
      path: path.join(assembled.output, assembled.receipt.receiptFileName),
    },
    host_bundles: {
      kind: 'tree',
      path: path.join(assembled.output, 'host-bundles'),
    },
    host_projection: {
      kind: 'file',
      path: build.receipt.hostProjectionPath,
    },
    package_file_manifest: {
      kind: 'file',
      path: path.join(
        assembled.output,
        assembled.receipt.packageFileManifest.fileName,
      ),
    },
    registry_record: {
      kind: 'file',
      path: path.join(
        assembled.output,
        assembled.receipt.registryRecord.fileName,
      ),
    },
    release_manifest: {
      kind: 'file',
      path: path.join(
        assembled.output,
        'release-manifest',
        assembled.receipt.releaseManifest.fileName,
      ),
    },
    signature_result: {
      kind: 'file',
      path: assembled.signatureResultPath,
    },
    signing_request: {
      kind: 'file',
      path: build.receipt.signingRequestPath,
    },
  };
}

async function compareAgentOutputs(agent, leftBuild, rightBuild, left, right) {
  const leftLocations = outputLocations(leftBuild, left);
  const rightLocations = outputLocations(rightBuild, right);
  const outputComparisons = [];
  for (const outputClass of OUTPUT_CLASSES) {
    outputComparisons.push(
      await compareOutputClass(
        leftLocations[outputClass],
        rightLocations[outputClass],
        outputClass,
      ),
    );
  }
  const hostBundleCount = left.receipt.hostBundles.length;
  if (
    hostBundleCount !== agent.hostBundleCount
    || right.receipt.hostBundles.length !== agent.hostBundleCount
  ) {
    throw new Error(`${agent.agentId} Host bundle count is invalid`);
  }
  return {
    agentId: agent.agentId,
    packageId: agent.packageId,
    version: agent.version,
    sourceClass: agent.sourceClass,
    buildCount: 2,
    signingRequestCount: 2,
    signatureVerificationCount: 2,
    hostBundleCount,
    outputComparisons,
    status: 'passed',
  };
}

async function removeDetachedWorktree(repository, worktree, label) {
  const result = spawnSync(
    'git',
    ['worktree', 'remove', '--force', worktree],
    {
      cwd: repository,
      encoding: 'utf8',
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`${label} worktree cleanup failed`);
  }
}

async function runRehearsal(options) {
  await access(WORKER);
  if (!options.retainBoundary) await assertNewOutput(options.outputPath);
  await assertRepositoryBoundary(options);
  const sourceRepositories = {
    deploy: await assertSourceRepository(
      options.deploySource,
      SOURCE_COMMITS.deploy,
      'Deploy source repository',
    ),
    job: await assertSourceRepository(
      options.jobSource,
      SOURCE_COMMITS.job,
      'Job source repository',
    ),
    lecturecast: await assertSourceRepository(
      options.lecturecastSource,
      SOURCE_COMMITS.lecturecast,
      'LectureCast source repository',
    ),
  };

  const boundary = await mkdtemp(
    path.join(
      os.tmpdir(),
      options.retainBoundary
        ? 'agentmesh360-release-provenance-e1-'
        : 'agentmesh360-release-provenance-e0-',
    ),
  );
  await chmod(boundary, 0o700);
  const resolvedBoundary = await realpath(boundary);
  const candidateRoot = path.join(resolvedBoundary, 'candidate');
  const sourceWorktreeRoot = path.join(resolvedBoundary, 'source-worktrees');
  const sources = {
    deploy: path.join(sourceWorktreeRoot, 'deploy'),
    job: path.join(sourceWorktreeRoot, 'job'),
    lecturecast: path.join(sourceWorktreeRoot, 'lecturecast'),
  };
  const privateRoot = path.join(resolvedBoundary, 'private');
  const publicRoot = path.join(resolvedBoundary, 'public');
  const binaryRoot = path.join(resolvedBoundary, 'bin');
  const buildRoots = [
    path.join(resolvedBoundary, 'builder-a-target'),
    path.join(resolvedBoundary, 'builder-b-target'),
  ];
  const binaries = [
    path.join(binaryRoot, 'package-author-a'),
    path.join(binaryRoot, 'package-author-b'),
  ];
  const privateKeyPath = path.join(privateRoot, 'publisher.pk8');
  let worktreeAdded = false;
  const sourceWorktreesAdded = [];
  let generationAttempted = false;
  let keyGenerated = false;
  let keyDestroyed = false;
  let publicEvidence;
  let agentResults;
  let agents;
  let builds;
  let assembled;
  let publicKeyPath;
  let successfulBuild = false;
  let cleanupError;
  try {
    await mkdir(privateRoot, { mode: 0o700 });
    await mkdir(publicRoot, { mode: 0o700 });
    await mkdir(binaryRoot, { mode: 0o700 });
    await mkdir(sourceWorktreeRoot, { mode: 0o700 });
    git(
      ['worktree', 'add', '--detach', candidateRoot, options.candidateCommit],
      REPOSITORY_ROOT,
      'candidate worktree creation',
    );
    worktreeAdded = true;
    await assertCleanRepository(
      candidateRoot,
      options.candidateCommit,
      'candidate worktree',
    );
    for (const [source, expectedCommit, label] of [
      ['deploy', SOURCE_COMMITS.deploy, 'Deploy source'],
      ['job', SOURCE_COMMITS.job, 'Job source'],
      ['lecturecast', SOURCE_COMMITS.lecturecast, 'LectureCast source'],
    ]) {
      git(
        [
          'worktree',
          'add',
          '--detach',
          sources[source],
          expectedCommit,
        ],
        sourceRepositories[source],
        `${label} worktree creation`,
      );
      sourceWorktreesAdded.push(source);
      await assertCleanRepository(
        sources[source],
        expectedCommit,
        `${label} worktree`,
      );
    }
    const candidateLock = typedSha256(
      await readRegularFile(path.join(candidateRoot, 'Cargo.lock'), 16 * 1024 * 1024),
    );
    if (candidateLock !== CANDIDATE_LOCK_SHA256) {
      throw new Error('candidate Cargo.lock digest drift');
    }
    const executorLock = typedSha256(
      await readRegularFile(
        path.join(REPOSITORY_ROOT, 'Cargo.lock'),
        16 * 1024 * 1024,
      ),
    );
    if (executorLock !== candidateLock) {
      throw new Error('executor Cargo.lock differs from candidate');
    }

    await buildExecutorBinary('builder A', buildRoots[0], binaries[0]);
    await rm(buildRoots[0], { recursive: true, force: true });
    await buildExecutorBinary('builder B', buildRoots[1], binaries[1]);
    await rm(buildRoots[1], { recursive: true, force: true });

    const packageRoot = path.join(
      candidateRoot,
      'crates/codegen/xai-grok-shell/src/agentmesh360/packages',
    );
    agents = [
      {
        agentId: 'deploy-agent',
        packageId: 'com.agentmesh360.deploy-agent',
        version: '0.1.1',
        sourceClass: 'first_party',
        hostBundleCount: 0,
        definition: path.join(packageRoot, 'deploy-agent'),
        source: sources.deploy,
      },
      {
        agentId: 'future-agent',
        packageId: 'com.agentmesh360.future-agent',
        version: '1.0.0',
        sourceClass: 'dynamic_fixture',
        hostBundleCount: 2,
        definition: path.join(
          REPOSITORY_ROOT,
          'fixtures/release-provenance/future-agent',
        ),
        source: path.join(
          REPOSITORY_ROOT,
          'fixtures/release-provenance/future-agent',
        ),
      },
      {
        agentId: 'job-agent',
        packageId: 'com.agentmesh360.job-agent',
        version: '0.4.7',
        sourceClass: 'first_party',
        hostBundleCount: 2,
        definition: path.join(packageRoot, 'job-agent'),
        source: sources.job,
      },
      {
        agentId: 'lecturecast-agent',
        packageId: 'com.agentmesh360.lecturecast-agent',
        version: '0.4.0',
        sourceClass: 'first_party',
        hostBundleCount: 3,
        definition: path.join(packageRoot, 'lecturecast-agent'),
        source: sources.lecturecast,
      },
    ];
    const packageOutputs = [
      path.join(resolvedBoundary, 'packages-a'),
      path.join(resolvedBoundary, 'packages-b'),
    ];
    const releaseOutputs = [
      path.join(resolvedBoundary, 'releases-a'),
      path.join(resolvedBoundary, 'releases-b'),
    ];
    await mkdir(packageOutputs[0], { mode: 0o700 });
    await mkdir(packageOutputs[1], { mode: 0o700 });
    await mkdir(releaseOutputs[0], { mode: 0o700 });
    await mkdir(releaseOutputs[1], { mode: 0o700 });

    builds = [[], []];
    for (const agent of agents) {
      builds[0].push(
        await buildAgent(
          binaries[0],
          'builder A',
          agent,
          packageOutputs[0],
          options.publisherKeyId,
        ),
      );
      builds[1].push(
        await buildAgent(
          binaries[1],
          'builder B',
          agent,
          packageOutputs[1],
          options.publisherKeyId,
        ),
      );
    }
    for (let index = 0; index < agents.length; index += 1) {
      for (const key of [
        ['artifactPath', 'artifact'],
        ['hostProjectionPath', 'host_projection'],
        ['signingRequestPath', 'signing_request'],
      ]) {
        await compareOutputClass(
          { kind: 'file', path: builds[0][index].receipt[key[0]] },
          { kind: 'file', path: builds[1][index].receipt[key[0]] },
          key[1],
        );
      }
    }

    generationAttempted = true;
    publicEvidence = callWorker(resolvedBoundary, {
      action: 'generate',
      target: privateKeyPath,
    });
    keyGenerated = true;
    if (
      typeof publicEvidence.publicKeyBase64 !== 'string'
      || !/^sha256:[0-9a-f]{64}$/u.test(publicEvidence.publicKeySha256)
    ) {
      throw new Error('isolated signer returned invalid public evidence');
    }
    publicKeyPath = path.join(publicRoot, 'publisher-public-key.json');
    await writeFile(
      publicKeyPath,
      JSON.stringify({
        schemaVersion: 1,
        algorithm: 'ed25519',
        keyId: options.publisherKeyId,
        publicKey: publicEvidence.publicKeyBase64,
      }),
      { flag: 'wx', mode: 0o600 },
    );

    assembled = [[], []];
    let signatureOperations = 0;
    for (let builder = 0; builder < 2; builder += 1) {
      for (let index = 0; index < agents.length; index += 1) {
        const signatureResult = await signBuild(
          resolvedBoundary,
          privateKeyPath,
          builds[builder][index],
          options.publisherKeyId,
        );
        signatureOperations += 1;
        assembled[builder].push(
          await assembleAgent(
            binaries[builder],
            builder === 0 ? 'builder A' : 'builder B',
            agents[index],
            builds[builder][index],
            signatureResult,
            publicKeyPath,
            releaseOutputs[builder],
            options.publisherKeyId,
            options.releaseOrigin
              ? `${options.releaseOrigin}/objects/releases/${agents[index].packageId}/${agents[index].version}`
              : `https://packages.agentmesh360.invalid/e0/${agents[index].packageId}/${agents[index].version}`,
          ),
        );
      }
    }
    if (signatureOperations !== 8) {
      throw new Error('test Publisher signature operation count is invalid');
    }

    agentResults = [];
    for (let index = 0; index < agents.length; index += 1) {
      agentResults.push(
        await compareAgentOutputs(
          agents[index],
          builds[0][index],
          builds[1][index],
          assembled[0][index],
          assembled[1][index],
        ),
      );
    }
    successfulBuild = true;
  } finally {
    const retainSuccessfulBoundary =
      options.retainBoundary === true && successfulBuild;
    if (generationAttempted && !retainSuccessfulBoundary) {
      try {
        const destroyed = callWorker(resolvedBoundary, {
          action: 'destroy',
          target: privateKeyPath,
        });
        if (destroyed.destroyed !== true) {
          throw new Error('test Publisher destruction was not confirmed');
        }
        keyDestroyed = true;
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (worktreeAdded) {
      try {
        await removeDetachedWorktree(
          REPOSITORY_ROOT,
          candidateRoot,
          'candidate',
        );
      } catch (error) {
        cleanupError ??= error;
      }
    }
    for (const source of sourceWorktreesAdded.reverse()) {
      try {
        await removeDetachedWorktree(
          sourceRepositories[source],
          sources[source],
          `${source} source`,
        );
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (!retainSuccessfulBoundary) {
      try {
        await rm(resolvedBoundary, { recursive: true, force: true });
      } catch (error) {
        cleanupError ??= error;
      }
    }
  }
  if (cleanupError) throw cleanupError;
  if (options.retainBoundary) {
    if (
      !successfulBuild
      || !keyGenerated
      || !publicEvidence
      || !agentResults
      || !agents
      || !builds
      || !assembled
      || !publicKeyPath
    ) {
      throw new Error('E1 Release Set was not retained completely');
    }
    return {
      boundary: resolvedBoundary,
      privateKeyPath,
      publicEvidence,
      publicKeyPath,
      agents,
      builds: builds[0],
      assembled: assembled[0],
      agentResults,
      publisherKeyId: options.publisherKeyId,
    };
  }
  if (!keyGenerated || !keyDestroyed || !publicEvidence || !agentResults) {
    throw new Error('P3 rehearsal did not complete and retainable evidence was not produced');
  }
  try {
    await lstat(resolvedBoundary);
    throw new Error('temporary release-provenance boundary still exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await lstat(path.join(REPOSITORY_ROOT, 'target'));
    throw new Error('repository target directory was created');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const candidateLock = CANDIDATE_LOCK_SHA256;
  const executorLock = typedSha256(
    await readRegularFile(path.join(REPOSITORY_ROOT, 'Cargo.lock'), 16 * 1024 * 1024),
  );
  const receipt = {
    schemaVersion: 1,
    rehearsalId: options.rehearsalId,
    environment: 'e0',
    workPackage: 'p3_r2',
    authority: 'single_test_publisher',
    approvalStatus: 'approved',
    executionStatus: 'technical_rehearsal_passed',
    algorithm: 'ed25519',
    approvalReceipt: {
      receiptId: options.approvalReceipt,
      authorizedScope: 'p3_r2_e0_four_agent_dual_build_and_test_signing',
      authorizedCandidateCommit: options.candidateCommit,
      authorizedPublisherKeyCount: 1,
      authorizedWindow: 'current_development_cycle_only',
      externalServicesUsed: false,
      providerRequests: 0,
      creditsConsumed: 0,
      currencyCost: 0,
    },
    candidateFreeze: {
      commit: options.candidateCommit,
      cleanTree: true,
      cargoLockSha256: candidateLock,
      rustcVersion: run('rustc', ['--version'], undefined, 'rustc version capture'),
      cargoVersion: run('cargo', ['--version'], undefined, 'cargo version capture'),
    },
    executorFreeze: {
      commit: options.executorCommit,
      cleanTree: true,
      cargoLockSha256: executorLock,
      executorSourceSha256: await executorSourceDigest(),
    },
    sourceInputs: [
      {
        agentId: 'deploy-agent',
        sourceClass: 'first_party',
        sourceAlias: 'deploy_source',
        commit: SOURCE_COMMITS.deploy,
        cleanTree: true,
      },
      {
        agentId: 'future-agent',
        sourceClass: 'dynamic_fixture',
        sourceAlias: 'executor_fixture',
        commit: options.executorCommit,
        cleanTree: true,
      },
      {
        agentId: 'job-agent',
        sourceClass: 'first_party',
        sourceAlias: 'job_source',
        commit: SOURCE_COMMITS.job,
        cleanTree: true,
      },
      {
        agentId: 'lecturecast-agent',
        sourceClass: 'first_party',
        sourceAlias: 'lecturecast_source',
        commit: SOURCE_COMMITS.lecturecast,
        cleanTree: true,
      },
    ],
    roleAliases: [
      'build_operator',
      'independent_reviewer',
      'test_signer_operator',
    ],
    testPublisher: {
      keyId: options.publisherKeyId,
      publicKeySha256: publicEvidence.publicKeySha256,
      generationCount: 1,
      signatureOperationCount: 8,
      privateMaterialPersisted: false,
      destroyed: true,
    },
    agentResults,
    cleanup: {
      temporaryBoundaryRemoved: true,
      buildRootsRemoved: 2,
      candidateWorktreeRemoved: true,
      sourceWorktreesRemoved: 3,
      privateFilesRemaining: 0,
      repositoryPrivateMaterialDetected: false,
      repositoryTargetAbsent: true,
      restoredTrustState: 'empty',
      productionConstantsEmpty: true,
      forensicSecureEraseGuaranteed: false,
      cleanupMethod: 'overwrite_fsync_unlink_then_recursive_remove',
    },
    productionBoundary: {
      productionR2Closed: false,
      productionKeysCreated: false,
      productionRegistryPublished: false,
      externalAuthorityUsed: false,
      p4ThroughP8Opened: false,
    },
    evidencePolicy: {
      containsPrivateMaterial: false,
      containsRawPublicKeys: false,
      containsRawSignatures: false,
      containsAbsolutePaths: false,
      containsPersonalIdentity: false,
      containsRawCommands: false,
    },
    reviewLimitations: {
      digestInputsIndependentlyVerifiable: false,
      executionOccurrenceStandaloneProof: false,
      trustedProducer: 'audited_local_runner',
    },
    completedAt: new Date().toISOString(),
  };
  const errors = validateReleaseProvenanceReceipt(receipt);
  if (errors.length > 0) {
    throw new Error('generated release provenance receipt failed validation');
  }
  assertReleaseProvenanceReceiptSafeForRetention(receipt);
  await writeFile(
    options.outputPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
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
    process.exitCode = 1;
  }
  if (options) {
    runRehearsal(options)
      .then(() => {
        console.log(
          'P3 R2 E0 release-provenance rehearsal passed; private material and build roots removed',
        );
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}

export {
  CANDIDATE_COMMIT,
  OUTPUT_CLASSES,
  packageBuildArguments,
  parseArguments,
  runRehearsal,
  sanitizedCommandDiagnostic,
  treeDigest,
};
