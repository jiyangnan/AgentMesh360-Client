import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertReceiptSafeForRetention,
  loadKeyCeremonyReceiptSchema,
  validateKeyCeremonyReceipt,
  validateKeyCeremonyReceiptFile,
} from './validate-key-ceremony-receipt.mjs';
import {
  canonicalTrustPayload,
  compareCanonicalKeyId,
  containsPrivateKeyMarker,
  isValidEd25519CompressedPoint,
  verifyTrustBundle,
} from './run-e0-key-ceremony.mjs';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const VALIDATOR = path.join(TEST_DIRECTORY, 'validate-key-ceremony-receipt.mjs');
const RUNNER = path.join(TEST_DIRECTORY, 'run-e0-key-ceremony.mjs');
const WORKER = path.join(TEST_DIRECTORY, 'e0-key-worker.mjs');
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;
const HASH_D = `sha256:${'d'.repeat(64)}`;
const REQUIRED_SCENARIOS = [
  'bundle_expiry',
  'publisher_a_generation',
  'publisher_b_generation',
  'publisher_compromise',
  'publisher_expiry',
  'publisher_loss_recovery',
  'publisher_overlap_rotation',
  'publisher_retirement',
  'publisher_revocation',
  'root_compromise',
  'root_emergency_revocation',
  'root_generation',
  'root_loss_recovery',
  'root_overlap_rotation',
  'root_public_export',
  'test_material_destruction',
];

function validReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    ceremonyId: 'ceremony_e0_20260728_0001',
    environment: 'e0',
    ceremonyClass: 'test_key_rehearsal',
    authority: 'test_keys',
    approvalStatus: 'approved',
    executionStatus: 'technical_rehearsal_passed',
    algorithm: 'ed25519',
    approvalReceipt: {
      receiptId: 'approval_p2_e0_20260728_0001',
      authorizedScope: 'p2_e0_local_test_key_rehearsal',
      authorizedWindow: 'current_development_cycle_only',
      externalServicesUsed: false,
      providerRequests: 0,
      creditsConsumed: 0,
      currencyCost: 0,
    },
    sourceCommit: 'c68c2d133a8ab3fa30cc57f783fbaa8311eee5ec',
    roleAliases: [
      'independent_reviewer',
      'release_authorizer',
      'rehearsal_operator',
    ],
    keyInventory: [
      {
        alias: 'publisher_a',
        keyId: 'agentmesh360-publisher-e0-20260728-a',
        role: 'publisher',
        publicKeySha256: HASH_A,
        transientSuccessor: false,
        privateMaterialPersisted: false,
        destroyed: true,
      },
      {
        alias: 'publisher_b',
        keyId: 'agentmesh360-publisher-e0-20260728-b',
        role: 'publisher',
        publicKeySha256: HASH_B,
        transientSuccessor: false,
        privateMaterialPersisted: false,
        destroyed: true,
      },
      {
        alias: 'root_initial',
        keyId: 'agentmesh360-root-e0-20260728-a',
        role: 'root',
        publicKeySha256: HASH_C,
        transientSuccessor: false,
        privateMaterialPersisted: false,
        destroyed: true,
      },
      {
        alias: 'root_successor_transient',
        keyId: 'agentmesh360-root-e0-20260728-b',
        role: 'root',
        publicKeySha256: HASH_D,
        transientSuccessor: true,
        privateMaterialPersisted: false,
        destroyed: true,
      },
    ],
    trustSequenceEvidence: [1, 2, 3, 4, 5].map((sequence, index) => ({
      sequence,
      signerRootAlias: index === 4 ? 'root_successor_transient' : 'root_initial',
      documentSha256: `sha256:${`${index}`.repeat(64)}`,
      signatureVerified: true,
    })),
    scenarioResults: REQUIRED_SCENARIOS.map((scenario) => ({
      scenario,
      status: 'passed',
      evidenceCode: `${scenario}_verified`,
    })),
    negativeChecks: [
      { check: 'expired_active_publisher_rejected', status: 'passed' },
      { check: 'expired_bundle_rejected', status: 'passed' },
      { check: 'revoked_publisher_not_active', status: 'passed' },
      { check: 'rollback_sequence_rejected', status: 'passed' },
      { check: 'same_sequence_equivocation_rejected', status: 'passed' },
      { check: 'unknown_root_rejected', status: 'passed' },
    ],
    cleanup: {
      temporaryDirectoryRemoved: true,
      privateFilesRemaining: 0,
      repositoryPrivateMaterialDetected: false,
      restoredTrustState: 'empty',
      productionConstantsEmpty: true,
      forensicSecureEraseGuaranteed: false,
      cleanupMethod: 'overwrite_fsync_unlink_then_recursive_remove',
    },
    productionBoundary: {
      productionR1Closed: false,
      productionCustodyClaimed: false,
      productionKeysCreated: false,
      externalAuthorityUsed: false,
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
      scenarioOccurrenceStandaloneProof: false,
      trustedProducer: 'audited_local_runner',
    },
    completedAt: '2026-07-28T12:00:00.000Z',
    ...overrides,
  };
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'agentmesh360-receipt-test-'),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('accepts a complete non-secret E0 technical rehearsal receipt', () => {
  const receipt = validReceipt();
  assert.deepEqual(
    validateKeyCeremonyReceipt(receipt, loadKeyCeremonyReceiptSchema()),
    [],
  );
  assert.doesNotThrow(() => assertReceiptSafeForRetention(receipt));
});

test('requires every P2 scenario exactly once and passed', () => {
  const missing = validReceipt();
  missing.scenarioResults = missing.scenarioResults.slice(1);
  assert.ok(
    validateKeyCeremonyReceipt(missing).some((error) =>
      error.includes('scenarioResults'),
    ),
  );

  const failed = validReceipt();
  failed.scenarioResults[0].status = 'failed';
  assert.ok(
    validateKeyCeremonyReceipt(failed).some((error) =>
      error.includes('must pass'),
    ),
  );
});

test('requires destroyed test keys, empty trust, and an open production R1 gate', () => {
  const persisted = validReceipt();
  persisted.keyInventory[0].privateMaterialPersisted = true;
  assert.ok(validateKeyCeremonyReceipt(persisted).length > 0);

  const productionClaim = validReceipt();
  productionClaim.productionBoundary.productionR1Closed = true;
  assert.ok(validateKeyCeremonyReceipt(productionClaim).length > 0);

  const nonEmptyTrust = validReceipt();
  nonEmptyTrust.cleanup.restoredTrustState = 'test_keys';
  assert.ok(validateKeyCeremonyReceipt(nonEmptyTrust).length > 0);
});

test('retention scan rejects private fields, raw crypto values, and absolute paths', () => {
  for (const receipt of [
    { ...validReceipt(), privateKey: 'synthetic-sentinel' },
    { ...validReceipt(), signature: 'a'.repeat(88) },
    { ...validReceipt(), publicKey: 'b'.repeat(44) },
    { ...validReceipt(), temporaryDirectory: '/tmp/ceremony-secret' },
  ]) {
    assert.throws(
      () => assertReceiptSafeForRetention(receipt),
      /unsafe ceremony receipt/,
    );
  }
});

test('receipt file validator rejects symlinks and duplicate JSON keys', async () => {
  await withTempDirectory(async (directory) => {
    const receiptPath = path.join(directory, 'receipt.json');
    const symlinkPath = path.join(directory, 'receipt-link.json');
    await writeFile(receiptPath, `${JSON.stringify(validReceipt())}\n`);
    await symlink(receiptPath, symlinkPath);
    await assert.rejects(
      validateKeyCeremonyReceiptFile(symlinkPath),
      /regular file/,
    );

    const duplicate = JSON.stringify(validReceipt()).replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    );
    await writeFile(path.join(directory, 'duplicate.json'), duplicate);
    await assert.rejects(
      validateKeyCeremonyReceiptFile(path.join(directory, 'duplicate.json')),
      /duplicate JSON object keys/,
    );
  });
});

test('receipt validator CLI succeeds without printing retained evidence', async () => {
  await withTempDirectory(async (directory) => {
    const receiptPath = path.join(directory, 'receipt.json');
    await writeFile(receiptPath, `${JSON.stringify(validReceipt(), null, 2)}\n`);
    const result = spawnSync(process.execPath, [VALIDATOR, receiptPath], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /valid and retention-safe/);
    assert.doesNotMatch(result.stdout, /publicKeySha256|documentSha256/);
  });
});

test('runner refuses to generate keys without the explicit execution acknowledgement', () => {
  const result = spawnSync(process.execPath, [
    RUNNER,
    '--approval-receipt',
    'approval_p2_e0_20260728_0001',
    '--source-commit',
    'c68c2d133a8ab3fa30cc57f783fbaa8311eee5ec',
    '--output',
    'ignored.json',
  ], {
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--execute-approved-e0/);
});

test('runner mirrors the Rust trust-bundle canonical payload contract', () => {
  assert.equal(
    canonicalTrustPayload({
      schemaVersion: 1,
      sequence: 2,
      rootKeyId: 'root-a',
      generatedAt: '2026-07-28T00:00:00.000Z',
      expiresAt: '2026-07-29T00:00:00.000Z',
      keys: [
        {
          keyId: 'publisher-a',
          publisher: 'agentmesh360',
          algorithm: 'ed25519',
          publicKey: 'public-evidence',
          status: 'active',
          notBefore: '2026-07-28T00:00:00.000Z',
          notAfter: '2026-07-29T00:00:00.000Z',
        },
      ],
    }),
    [
      'agentmesh360-publisher-trust-v1',
      'schemaVersion=1',
      'sequence=2',
      'rootKeyId=root-a',
      'generatedAt=2026-07-28T00:00:00.000Z',
      'expiresAt=2026-07-29T00:00:00.000Z',
      'key=publisher-a|agentmesh360|ed25519|public-evidence|active'
        + '|2026-07-28T00:00:00.000Z|2026-07-29T00:00:00.000Z',
      '',
    ].join('\n'),
  );
});

test('runner rejects rollback and expired bundle state before signature use', () => {
  const now = new Date('2026-07-28T12:00:00.000Z');
  const base = {
    schemaVersion: 1,
    sequence: 1,
    rootKeyId: 'root-a',
    generatedAt: '2026-07-28T11:00:00.000Z',
    expiresAt: '2026-07-28T13:00:00.000Z',
    keys: [],
    signature: '',
  };
  assert.throws(
    () => verifyTrustBundle(base, new Map(), now, 2),
    /rollback_sequence/,
  );
  assert.throws(
    () =>
      verifyTrustBundle(
        {
          ...base,
          sequence: 2,
          expiresAt: '2026-07-28T11:59:59.000Z',
        },
        new Map(),
        now,
        2,
      ),
    /expired_bundle/,
  );
  assert.throws(
    () =>
      verifyTrustBundle(
        {
          ...base,
          sequence: 2,
          generatedAt: '2026-07-28',
        },
        new Map(),
        now,
        2,
      ),
    /expired_bundle/,
  );
});

test('runner uses canonical byte order and validates Ed25519 compressed points', () => {
  assert.deepEqual(
    ['key_1', 'key-1', 'key.1'].sort(compareCanonicalKeyId),
    ['key-1', 'key.1', 'key_1'],
  );
  assert.equal(
    isValidEd25519CompressedPoint(
      Buffer.from(
        'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
        'hex',
      ),
    ),
    true,
  );
  assert.equal(
    isValidEd25519CompressedPoint(Buffer.alloc(32, 0xff)),
    false,
  );
});

test('repository marker scan detects private PEM without flagging its own source', async () => {
  const runnerSource = await import('node:fs/promises').then(({ readFile }) =>
    readFile(RUNNER, 'utf8'),
  );
  assert.equal(containsPrivateKeyMarker(runnerSource), false);
  assert.equal(
    containsPrivateKeyMarker(
      ['-----BEGIN ', 'PRIVATE KEY-----', '\nsynthetic\n-----END'].join(''),
    ),
    true,
  );
  for (const label of ['RSA', 'DSA', 'EC', 'ENCRYPTED', 'OPENSSH']) {
    assert.equal(
      containsPrivateKeyMarker(
        [`-----BEGIN ${label} `, 'PRIVATE KEY-----'].join(''),
      ),
      true,
    );
  }
});

test('retention scan rejects ambiguous bare 64-hex values', () => {
  assert.throws(
    () => assertReceiptSafeForRetention({ digest: 'a'.repeat(64) }),
    /unsafe ceremony receipt/,
  );
  assert.doesNotThrow(() =>
    assertReceiptSafeForRetention({ digest: `sha256:${'a'.repeat(64)}` }),
  );
});

test('worker rejects direct and symlink-parent boundary escapes without mutation', async () => {
  const boundary = await mkdtemp(
    path.join(os.tmpdir(), 'agentmesh360-key-ceremony-e0-'),
  );
  const outside = await mkdtemp(
    path.join(os.tmpdir(), 'agentmesh360-worker-outside-'),
  );
  try {
    const sentinel = path.join(outside, 'sentinel.pk8');
    await writeFile(sentinel, 'synthetic-non-key-sentinel', { mode: 0o600 });
    await symlink(outside, path.join(boundary, 'private'));

    for (const target of [
      sentinel,
      path.join(boundary, 'private/sentinel.pk8'),
      path.join(boundary, 'not-private.txt'),
    ]) {
      const result = spawnSync(process.execPath, [WORKER], {
        encoding: 'utf8',
        input: `${JSON.stringify({
          action: 'destroy',
          boundary,
          target,
        })}\n`,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /isolated key worker rejected request/);
      assert.doesNotMatch(result.stderr, new RegExp(outside, 'u'));
    }
    assert.equal(await readFile(sentinel, 'utf8'), 'synthetic-non-key-sentinel');
  } finally {
    await rm(boundary, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
