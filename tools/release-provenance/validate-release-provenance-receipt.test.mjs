import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertReleaseProvenanceReceiptSafeForRetention,
  loadReleaseProvenanceReceiptSchema,
  validateReleaseProvenanceReceipt,
  validateReleaseProvenanceReceiptFile,
} from './validate-release-provenance-receipt.mjs';
import {
  CANDIDATE_COMMIT as RUNNER_CANDIDATE_COMMIT,
  packageBuildArguments,
  parseArguments,
  sanitizedCommandDiagnostic,
  treeDigest,
} from './run-e0-release-provenance.mjs';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const VALIDATOR = path.join(
  TEST_DIRECTORY,
  'validate-release-provenance-receipt.mjs',
);
const RUNNER = path.join(TEST_DIRECTORY, 'run-e0-release-provenance.mjs');
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const CANDIDATE_COMMIT = 'e1ef8db19dc58a2c9cec19ac34f7e1966d741b7c';
const EXECUTOR_COMMIT = '1'.repeat(40);
const OUTPUTS = [
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
];
const AGENTS = [
  ['deploy-agent', 'com.agentmesh360.deploy-agent', '0.1.1', 'first_party', 0],
  ['future-agent', 'com.agentmesh360.future-agent', '1.0.0', 'dynamic_fixture', 2],
  ['job-agent', 'com.agentmesh360.job-agent', '0.4.7', 'first_party', 2],
  [
    'lecturecast-agent',
    'com.agentmesh360.lecturecast-agent',
    '0.4.0',
    'first_party',
    3,
  ],
];

function outputComparisons() {
  return OUTPUTS.map((outputClass, index) => ({
    outputClass,
    byteIdentical: true,
    sha256: index % 2 === 0 ? HASH_A : HASH_B,
    fileCount: outputClass === 'host_bundles' ? 2 : 1,
  }));
}

function validReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    rehearsalId: 'release_provenance_e0_20260728_0001',
    environment: 'e0',
    workPackage: 'p3_r2',
    authority: 'single_test_publisher',
    approvalStatus: 'approved',
    executionStatus: 'technical_rehearsal_passed',
    algorithm: 'ed25519',
    approvalReceipt: {
      receiptId: 'approval_p3_e0_20260728_0001',
      authorizedScope: 'p3_r2_e0_four_agent_dual_build_and_test_signing',
      authorizedCandidateCommit: CANDIDATE_COMMIT,
      authorizedPublisherKeyCount: 1,
      authorizedWindow: 'current_development_cycle_only',
      externalServicesUsed: false,
      providerRequests: 0,
      creditsConsumed: 0,
      currencyCost: 0,
    },
    candidateFreeze: {
      commit: CANDIDATE_COMMIT,
      cleanTree: true,
      cargoLockSha256: HASH_A,
      rustcVersion: 'rustc 1.92.0 (test)',
      cargoVersion: 'cargo 1.92.0 (test)',
    },
    executorFreeze: {
      commit: EXECUTOR_COMMIT,
      cleanTree: true,
      cargoLockSha256: HASH_A,
      executorSourceSha256: HASH_B,
    },
    sourceInputs: [
      {
        agentId: 'deploy-agent',
        sourceClass: 'first_party',
        sourceAlias: 'deploy_source',
        commit: '2'.repeat(40),
        cleanTree: true,
      },
      {
        agentId: 'future-agent',
        sourceClass: 'dynamic_fixture',
        sourceAlias: 'executor_fixture',
        commit: EXECUTOR_COMMIT,
        cleanTree: true,
      },
      {
        agentId: 'job-agent',
        sourceClass: 'first_party',
        sourceAlias: 'job_source',
        commit: '3'.repeat(40),
        cleanTree: true,
      },
      {
        agentId: 'lecturecast-agent',
        sourceClass: 'first_party',
        sourceAlias: 'lecturecast_source',
        commit: '4'.repeat(40),
        cleanTree: true,
      },
    ],
    roleAliases: [
      'build_operator',
      'independent_reviewer',
      'test_signer_operator',
    ],
    testPublisher: {
      keyId: 'agentmesh360-publisher-e0-p3-20260728-01',
      publicKeySha256: HASH_A,
      generationCount: 1,
      signatureOperationCount: 8,
      privateMaterialPersisted: false,
      destroyed: true,
    },
    agentResults: AGENTS.map(
      ([agentId, packageId, version, sourceClass, hostBundleCount]) => ({
        agentId,
        packageId,
        version,
        sourceClass,
        buildCount: 2,
        signingRequestCount: 2,
        signatureVerificationCount: 2,
        hostBundleCount,
        outputComparisons: outputComparisons().map((entry) => (
          entry.outputClass === 'host_bundles'
            ? { ...entry, fileCount: hostBundleCount }
            : entry
        )),
        status: 'passed',
      }),
    ),
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
    completedAt: '2026-07-28T12:00:00.000Z',
    ...overrides,
  };
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'agentmesh360-provenance-receipt-test-'),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('accepts a complete four-Agent E0 provenance receipt', () => {
  const receipt = validReceipt();
  assert.deepEqual(
    validateReleaseProvenanceReceipt(
      receipt,
      loadReleaseProvenanceReceiptSchema(),
    ),
    [],
  );
  assert.doesNotThrow(
    () => assertReleaseProvenanceReceiptSafeForRetention(receipt),
  );
});

test('requires the exact source and Agent matrices', () => {
  const sourceDrift = validReceipt();
  sourceDrift.sourceInputs[0].sourceAlias = 'substituted_source';
  assert.ok(
    validateReleaseProvenanceReceipt(sourceDrift)
      .some((error) => error.includes('four frozen sources')),
  );

  const agentDrift = validReceipt();
  agentDrift.agentResults[3].version = '0.4.1';
  assert.ok(
    validateReleaseProvenanceReceipt(agentDrift)
      .some((error) => error.includes('four-Agent matrix')),
  );
});

test('requires ten ordered byte-identical output classes per Agent', () => {
  const missing = validReceipt();
  missing.agentResults[1].outputComparisons.pop();
  assert.ok(
    validateReleaseProvenanceReceipt(missing)
      .some((error) => error.includes('all ten classes')),
  );

  const mismatch = validReceipt();
  mismatch.agentResults[2].outputComparisons[0].byteIdentical = false;
  assert.ok(
    validateReleaseProvenanceReceipt(mismatch)
      .some((error) => error.includes('byte-identical')),
  );
});

test('rejects multiple keys, retained material, or production claims', () => {
  for (const receipt of [
    validReceipt({
      testPublisher: {
        ...validReceipt().testPublisher,
        generationCount: 2,
      },
    }),
    validReceipt({
      testPublisher: {
        ...validReceipt().testPublisher,
        destroyed: false,
      },
    }),
    validReceipt({
      productionBoundary: {
        ...validReceipt().productionBoundary,
        productionR2Closed: true,
      },
    }),
  ]) {
    assert.ok(validateReleaseProvenanceReceipt(receipt).length > 0);
  }
});

test('retention scan rejects raw crypto, paths, and untyped digests', () => {
  for (const receipt of [
    { ...validReceipt(), publicKey: 'a'.repeat(43) + '=' },
    { ...validReceipt(), signature: 'a'.repeat(86) + '==' },
    { ...validReceipt(), temporaryDirectory: '/tmp/private-build' },
    { ...validReceipt(), digest: 'a'.repeat(64) },
  ]) {
    assert.throws(
      () => assertReleaseProvenanceReceiptSafeForRetention(receipt),
      /unsafe release provenance receipt/,
    );
  }
});

test('file validator rejects symlinks and duplicate object keys', async () => {
  await withTempDirectory(async (directory) => {
    const receiptPath = path.join(directory, 'receipt.json');
    const symlinkPath = path.join(directory, 'receipt-link.json');
    await writeFile(receiptPath, `${JSON.stringify(validReceipt())}\n`);
    await symlink(receiptPath, symlinkPath);
    await assert.rejects(
      validateReleaseProvenanceReceiptFile(symlinkPath),
      /regular file/,
    );

    const duplicate = JSON.stringify(validReceipt()).replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    );
    const duplicatePath = path.join(directory, 'duplicate.json');
    await writeFile(duplicatePath, duplicate);
    await assert.rejects(
      validateReleaseProvenanceReceiptFile(duplicatePath),
      /duplicate JSON object keys/,
    );
  });
});

test('CLI validates without printing retained evidence', async () => {
  await withTempDirectory(async (directory) => {
    const receiptPath = path.join(directory, 'receipt.json');
    await writeFile(
      receiptPath,
      `${JSON.stringify(validReceipt(), null, 2)}\n`,
    );
    const result = spawnSync(process.execPath, [VALIDATOR, receiptPath], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /valid and retention-safe/);
    assert.doesNotMatch(result.stdout, /publicKeySha256|executorSourceSha256/);
  });
});

test('runner refuses before the explicit P3 execution acknowledgement', () => {
  const result = spawnSync(process.execPath, [
    RUNNER,
    '--approval-receipt',
    'approval_p3_e0_20260728_0001',
  ], {
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--execute-approved-p3-e0/);
});

test('runner pins the candidate commit and tabletop output boundary', () => {
  const common = [
    '--execute-approved-p3-e0',
    '--approval-receipt',
    'approval_p3_e0_20260728_0001',
    '--rehearsal-id',
    'release_provenance_e0_20260728_0001',
    '--candidate-commit',
    RUNNER_CANDIDATE_COMMIT,
    '--executor-commit',
    EXECUTOR_COMMIT,
    '--publisher-key-id',
    'agentmesh360-publisher-e0-p3-20260728-01',
    '--deploy-source',
    '/tmp/deploy',
    '--job-source',
    '/tmp/job',
    '--lecturecast-source',
    '/tmp/lecturecast',
    '--output',
    path.resolve(
      TEST_DIRECTORY,
      '../../docs/operations/tabletops/test-only.json',
    ),
  ];
  assert.equal(parseArguments(common).candidateCommit, CANDIDATE_COMMIT);

  const drift = [...common];
  drift[drift.indexOf(RUNNER_CANDIDATE_COMMIT)] = 'f'.repeat(40);
  assert.throws(() => parseArguments(drift), /approved P3 commit/);

  const escaped = [...common];
  escaped[escaped.length - 1] = '/tmp/escaped-receipt.json';
  assert.throws(() => parseArguments(escaped), /tabletop directory/);
});

test('runner tree digest binds sorted relative names and bytes', () => {
  const first = treeDigest([
    { relative: 'a', bytes: Buffer.from('one') },
    { relative: 'b', bytes: Buffer.from('two') },
  ]);
  assert.match(first, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(
    first,
    treeDigest([
      { relative: 'a', bytes: Buffer.from('one') },
      { relative: 'b', bytes: Buffer.from('two') },
    ]),
  );
  assert.notEqual(
    first,
    treeDigest([
      { relative: 'a', bytes: Buffer.from('one') },
      { relative: 'c', bytes: Buffer.from('two') },
    ]),
  );
});

test('runner keeps failure diagnostics bounded and path-redacted', () => {
  const diagnostic = sanitizedCommandDiagnostic([
    'Error: Package build failed',
    'Caused by: read /Users/example/private/source.txt: invalid input',
  ].join('\n'));
  assert.equal(
    diagnostic,
    'Caused by: read <path>: invalid input',
  );
  assert.ok(
    sanitizedCommandDiagnostic(`Error: ${'x'.repeat(500)}`).length <= 320,
  );
});

test('runner uses the actual Package Author build CLI contract', () => {
  assert.deepEqual(
    packageBuildArguments(
      {
        definition: '/tmp/definition',
        source: '/tmp/source',
      },
      '/tmp/output',
      'publisher-e0',
    ),
    [
      'build',
      '--definition',
      '/tmp/definition',
      '--source',
      '/tmp/source',
      '--key-id',
      'publisher-e0',
      '--output',
      '/tmp/output',
    ],
  );
});
