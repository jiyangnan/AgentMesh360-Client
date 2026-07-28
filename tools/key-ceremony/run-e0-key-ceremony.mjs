#!/usr/bin/env node

import {
  createHash,
  createPublicKey,
  verify,
} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  access,
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
  assertReceiptSafeForRetention,
  validateKeyCeremonyReceipt,
} from './validate-key-ceremony-receipt.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const WORKER = path.join(MODULE_DIRECTORY, 'e0-key-worker.mjs');
const RECEIPT_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  'docs/operations/tabletops',
);
const REQUIRED_SCENARIOS = Object.freeze([
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
]);
const NEGATIVE_CHECKS = Object.freeze([
  'expired_active_publisher_rejected',
  'expired_bundle_rejected',
  'revoked_publisher_not_active',
  'rollback_sequence_rejected',
  'same_sequence_equivocation_rejected',
  'unknown_root_rejected',
]);
const PRIVATE_KEY_MARKER =
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/u;
const STRICT_UTC_TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const ED25519_FIELD_PRIME = (1n << 255n) - 19n;
const ED25519_D = mod(
  -121665n * modInverse(121666n, ED25519_FIELD_PRIME),
  ED25519_FIELD_PRIME,
);
const ED25519_SQRT_M1 = modPow(
  2n,
  (ED25519_FIELD_PRIME - 1n) / 4n,
  ED25519_FIELD_PRIME,
);

function usage() {
  return [
    'usage: node run-e0-key-ceremony.mjs',
    '  --execute-approved-e0',
    '  --approval-receipt <approval_p2_e0_...>',
    '  --ceremony-id <ceremony_e0_...>',
    '  --source-commit <40 lowercase hex>',
    '  --output <docs/operations/tabletops/*.json>',
  ].join('\n');
}

function parseArguments(argv) {
  const values = new Map();
  let acknowledged = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute-approved-e0') {
      acknowledged = true;
      continue;
    }
    if (!argument.startsWith('--') || index + 1 >= argv.length) {
      throw new Error(usage());
    }
    if (values.has(argument)) throw new Error(`duplicate argument: ${argument}`);
    values.set(argument, argv[index + 1]);
    index += 1;
  }
  if (!acknowledged) {
    throw new Error(
      'refusing to generate test keys without --execute-approved-e0\n'
      + usage(),
    );
  }
  const allowed = new Set([
    '--approval-receipt',
    '--ceremony-id',
    '--source-commit',
    '--output',
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Error(`unknown argument: ${key}`);
  }
  for (const key of allowed) {
    if (!values.get(key)) throw new Error(`missing required argument: ${key}`);
  }
  const approvalReceipt = values.get('--approval-receipt');
  const ceremonyId = values.get('--ceremony-id');
  const sourceCommit = values.get('--source-commit');
  if (!/^approval_p2_e0_[a-z0-9][a-z0-9_-]{7,63}$/u.test(approvalReceipt)) {
    throw new Error('approval receipt ID is invalid');
  }
  if (!/^ceremony_e0_[a-z0-9][a-z0-9_-]{7,63}$/u.test(ceremonyId)) {
    throw new Error('ceremony ID is invalid');
  }
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error('source commit must be 40 lowercase hexadecimal characters');
  }
  const outputPath = path.resolve(REPOSITORY_ROOT, values.get('--output'));
  if (
    path.dirname(outputPath) !== RECEIPT_DIRECTORY
    || path.extname(outputPath) !== '.json'
  ) {
    throw new Error('receipt output must be a JSON file in docs/operations/tabletops');
  }
  return {
    approvalReceipt,
    ceremonyId,
    outputPath,
    sourceCommit,
  };
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalBase64(value, expectedBytes, subject) {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== expectedBytes || bytes.toString('base64') !== value) {
    throw new Error(`${subject} is not canonical base64`);
  }
  return bytes;
}

function publicKeyFromBase64(value) {
  const raw = canonicalBase64(value, 32, 'Ed25519 public key');
  if (!isValidEd25519CompressedPoint(raw)) {
    throw new Error('invalid_ed25519_point');
  }
  return createPublicKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: raw.toString('base64url'),
    },
    format: 'jwk',
  });
}

function mod(value, modulus) {
  const result = value % modulus;
  return result >= 0n ? result : result + modulus;
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  let factor = mod(base, modulus);
  let remaining = exponent;
  while (remaining > 0n) {
    if ((remaining & 1n) === 1n) result = mod(result * factor, modulus);
    factor = mod(factor * factor, modulus);
    remaining >>= 1n;
  }
  return result;
}

function modInverse(value, modulus) {
  return modPow(value, modulus - 2n, modulus);
}

function littleEndianInteger(bytes) {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[index]);
  }
  return value;
}

export function isValidEd25519CompressedPoint(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) return false;
  const encoded = Buffer.from(bytes);
  const xSign = (encoded[31] & 0x80) >>> 7;
  encoded[31] &= 0x7f;
  const y = littleEndianInteger(encoded);
  if (y >= ED25519_FIELD_PRIME) return false;
  const ySquared = mod(y * y, ED25519_FIELD_PRIME);
  const numerator = mod(ySquared - 1n, ED25519_FIELD_PRIME);
  const denominator = mod(ED25519_D * ySquared + 1n, ED25519_FIELD_PRIME);
  if (denominator === 0n) return false;
  const xSquared = mod(
    numerator * modInverse(denominator, ED25519_FIELD_PRIME),
    ED25519_FIELD_PRIME,
  );
  let x = modPow(
    xSquared,
    (ED25519_FIELD_PRIME + 3n) / 8n,
    ED25519_FIELD_PRIME,
  );
  if (mod(x * x - xSquared, ED25519_FIELD_PRIME) !== 0n) {
    x = mod(x * ED25519_SQRT_M1, ED25519_FIELD_PRIME);
  }
  if (mod(x * x - xSquared, ED25519_FIELD_PRIME) !== 0n) return false;
  if (x === 0n && xSign === 1) return false;
  return true;
}

function verifyRawSignature(publicKeyBase64, payload, signatureBase64) {
  const signature = canonicalBase64(signatureBase64, 64, 'Ed25519 signature');
  if (
    !verify(
      null,
      Buffer.from(payload, 'utf8'),
      publicKeyFromBase64(publicKeyBase64),
      signature,
    )
  ) {
    throw new Error('Ed25519 signature verification failed');
  }
}

export function canonicalTrustPayload(bundle) {
  let payload = [
    'agentmesh360-publisher-trust-v1',
    `schemaVersion=${bundle.schemaVersion}`,
    `sequence=${bundle.sequence}`,
    `rootKeyId=${bundle.rootKeyId}`,
    `generatedAt=${bundle.generatedAt}`,
    `expiresAt=${bundle.expiresAt}`,
  ].join('\n');
  payload += '\n';
  for (const key of bundle.keys) {
    payload += [
      'key=',
      key.keyId,
      '|',
      key.publisher,
      '|',
      key.algorithm,
      '|',
      key.publicKey,
      '|',
      key.status,
      '|',
      key.notBefore,
      '|',
      key.notAfter,
      '\n',
    ].join('');
  }
  return payload;
}

export function compareCanonicalKeyId(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validateIdentifier(value, subject) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 128
    || !/^[a-z0-9][a-z0-9._-]*[a-z0-9]$|^[a-z0-9]$/u.test(value)
  ) {
    throw new Error(`${subject} is invalid`);
  }
}

function strictObject(value, keys, subject) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${subject} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${subject} fields are invalid`);
  }
}

function parseStrictUtcTimestamp(value, errorCode) {
  if (
    typeof value !== 'string'
    || !STRICT_UTC_TIMESTAMP.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new Error(errorCode);
  }
  return Date.parse(value);
}

function documentDigest(bundle) {
  return sha256(Buffer.from(`${JSON.stringify(bundle)}\n`, 'utf8'));
}

export function verifyTrustBundle(
  bundle,
  roots,
  now,
  minimumSequence,
  current = null,
) {
  strictObject(
    bundle,
    [
      'schemaVersion',
      'sequence',
      'rootKeyId',
      'generatedAt',
      'expiresAt',
      'keys',
      'signature',
    ],
    'trust bundle',
  );
  if (bundle.schemaVersion !== 1) throw new Error('unsupported_schema');
  if (
    !Number.isSafeInteger(bundle.sequence)
    || bundle.sequence === 0
    || bundle.sequence < minimumSequence
  ) {
    throw new Error('rollback_sequence');
  }
  validateIdentifier(bundle.rootKeyId, 'rootKeyId');
  const generatedAt = parseStrictUtcTimestamp(bundle.generatedAt, 'expired_bundle');
  const expiresAt = parseStrictUtcTimestamp(bundle.expiresAt, 'expired_bundle');
  const nowValue = now.getTime();
  if (
    generatedAt >= expiresAt
    || nowValue < generatedAt
    || nowValue >= expiresAt
  ) {
    throw new Error('expired_bundle');
  }
  if (!Array.isArray(bundle.keys) || bundle.keys.length > 64) {
    throw new Error('invalid_keys');
  }
  let previousKeyId = null;
  const activeKeyIds = [];
  for (const key of bundle.keys) {
    strictObject(
      key,
      [
        'keyId',
        'publisher',
        'algorithm',
        'publicKey',
        'status',
        'notBefore',
        'notAfter',
      ],
      'publisher key record',
    );
    validateIdentifier(key.keyId, 'keyId');
    validateIdentifier(key.publisher, 'publisher');
    if (previousKeyId !== null && previousKeyId >= key.keyId) {
      throw new Error('unsorted_keys');
    }
    previousKeyId = key.keyId;
    if (key.algorithm !== 'ed25519') throw new Error('unsupported_algorithm');
    publicKeyFromBase64(key.publicKey);
    if (!['active', 'retired', 'revoked'].includes(key.status)) {
      throw new Error('invalid_key_status');
    }
    const notBefore = parseStrictUtcTimestamp(
      key.notBefore,
      'invalid_key_window',
    );
    const notAfter = parseStrictUtcTimestamp(
      key.notAfter,
      'invalid_key_window',
    );
    if (
      notBefore >= notAfter
    ) {
      throw new Error('invalid_key_window');
    }
    if (
      key.status === 'active'
      && (nowValue < notBefore || nowValue >= notAfter)
    ) {
      throw new Error('expired_active_publisher');
    }
    if (key.status === 'active') activeKeyIds.push(key.keyId);
  }
  const digest = documentDigest(bundle);
  if (current && bundle.sequence === current.sequence && digest !== current.digest) {
    throw new Error('same_sequence_equivocation');
  }
  const rootPublicKey = roots.get(bundle.rootKeyId);
  if (!rootPublicKey) throw new Error('unknown_root');
  verifyRawSignature(
    rootPublicKey,
    canonicalTrustPayload(bundle),
    bundle.signature,
  );
  return { activeKeyIds, digest, sequence: bundle.sequence };
}

function callWorker(boundary, request) {
  const result = spawnSync(process.execPath, [WORKER], {
    encoding: 'utf8',
    input: `${JSON.stringify({ ...request, boundary })}\n`,
    maxBuffer: 256 * 1024,
  });
  if (result.status !== 0) {
    throw new Error('isolated key worker failed; ceremony aborted');
  }
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new Error('isolated key worker returned invalid output');
  }
  return response;
}

function expectRejection(run, code) {
  try {
    run();
  } catch (error) {
    if (error instanceof Error && error.message === code) return;
    throw error;
  }
  throw new Error(`negative check unexpectedly succeeded: ${code}`);
}

async function assertProductionTrustEmpty() {
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
    || !trustSource.includes('Self::default()')
    || !fetcherSource.includes(
      'const PRODUCTION_TRUST_BUNDLE_URL: Option<&str> = None;',
    )
    || !fetcherSource.includes(
      'const PRODUCTION_REGISTRY_URL: Option<&str> = None;',
    )
  ) {
    throw new Error('production trust constants are not empty');
  }
}

async function assertNoPrivateMaterialInChangedFiles() {
  const result = spawnSync(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.status !== 0) throw new Error('cannot inspect changed repository files');
  const entries = result.stdout.split('\0').filter(Boolean);
  for (const entry of entries) {
    const relative = entry.slice(3);
    if (!relative || relative.includes(' -> ')) {
      throw new Error('changed repository path cannot be safely inspected');
    }
    const extension = path.extname(relative).toLowerCase();
    if (['.key', '.pem', '.pk8', '.p8', '.p12', '.pfx'].includes(extension)) {
      throw new Error('private-material file extension detected in repository changes');
    }
    const filePath = path.resolve(REPOSITORY_ROOT, relative);
    if (!filePath.startsWith(`${REPOSITORY_ROOT}${path.sep}`)) {
      throw new Error('changed repository path escapes repository');
    }
    let stat;
    try {
      stat = await lstat(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) {
      continue;
    }
    const value = await readFile(filePath, 'utf8');
    if (containsPrivateKeyMarker(value)) {
      throw new Error('private key marker detected in repository changes');
    }
  }
}

export function containsPrivateKeyMarker(value) {
  return PRIVATE_KEY_MARKER.test(value);
}

function timestamp(base, offsetMilliseconds) {
  return new Date(base.getTime() + offsetMilliseconds).toISOString();
}

async function runCeremony(options) {
  await access(WORKER);
  await assertProductionTrustEmpty();
  await assertNoPrivateMaterialInChangedFiles();
  try {
    await lstat(options.outputPath);
    throw new Error('receipt output already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const boundary = await mkdtemp(
    path.join(os.tmpdir(), 'agentmesh360-key-ceremony-e0-'),
  );
  await mkdir(path.join(boundary, 'private'), { mode: 0o700 });
  await mkdir(path.join(boundary, 'backup'), { mode: 0o700 });
  await mkdir(path.join(boundary, 'public'), { mode: 0o700 });
  const resolvedBoundary = await realpath(boundary);
  const privateFiles = {
    publisherA: path.join(resolvedBoundary, 'private/publisher-a.pk8'),
    publisherB: path.join(resolvedBoundary, 'private/publisher-b.pk8'),
    rootInitial: path.join(resolvedBoundary, 'private/root-initial.pk8'),
    rootSuccessor: path.join(resolvedBoundary, 'private/root-successor.pk8'),
  };
  const backupFiles = {
    publisherA: path.join(resolvedBoundary, 'backup/publisher-a-backup.pk8'),
    rootInitial: path.join(resolvedBoundary, 'backup/root-initial-backup.pk8'),
  };
  const allPrivateFiles = [
    ...Object.values(privateFiles),
    ...Object.values(backupFiles),
  ];
  let publicEvidence;
  let trustSequenceEvidence;
  let cleanupCompleted = false;
  let innerError;
  const passedScenarios = new Set();
  const passedNegativeChecks = new Set();

  function recordPassed(set, allowed, value, subject) {
    if (!allowed.includes(value) || set.has(value)) {
      throw new Error(`${subject} execution binding is invalid`);
    }
    set.add(value);
  }

  function passScenario(value) {
    recordPassed(passedScenarios, REQUIRED_SCENARIOS, value, 'scenario');
  }

  function passNegativeCheck(value) {
    recordPassed(
      passedNegativeChecks,
      NEGATIVE_CHECKS,
      value,
      'negative check',
    );
  }

  try {
    publicEvidence = {
      publisherA: callWorker(resolvedBoundary, {
        action: 'generate',
        target: privateFiles.publisherA,
      }),
      publisherB: callWorker(resolvedBoundary, {
        action: 'generate',
        target: privateFiles.publisherB,
      }),
      rootInitial: callWorker(resolvedBoundary, {
        action: 'generate',
        target: privateFiles.rootInitial,
      }),
      rootSuccessor: callWorker(resolvedBoundary, {
        action: 'generate',
        target: privateFiles.rootSuccessor,
      }),
    };
    for (const evidence of Object.values(publicEvidence)) {
      if (
        typeof evidence.publicKeyBase64 !== 'string'
        || !/^sha256:[0-9a-f]{64}$/u.test(evidence.publicKeySha256)
      ) {
        throw new Error('isolated key worker returned incomplete public evidence');
      }
    }
    passScenario('publisher_a_generation');
    passScenario('publisher_b_generation');
    passScenario('root_generation');

    const keyIds = {
      publisherA: 'agentmesh360-publisher-e0-20260728-a',
      publisherB: 'agentmesh360-publisher-e0-20260728-b',
      rootInitial: 'agentmesh360-root-e0-20260728-a',
      rootSuccessor: 'agentmesh360-root-e0-20260728-b',
    };
    const rootPublicDocument = {
      schemaVersion: 1,
      keyId: keyIds.rootInitial,
      algorithm: 'ed25519',
      publicKey: publicEvidence.rootInitial.publicKeyBase64,
    };
    await writeFile(
      path.join(resolvedBoundary, 'public/root-initial.json'),
      `${JSON.stringify(rootPublicDocument)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const exportedRoot = JSON.parse(
      await readFile(
        path.join(resolvedBoundary, 'public/root-initial.json'),
        'utf8',
      ),
    );
    if (
      exportedRoot.publicKey !== publicEvidence.rootInitial.publicKeyBase64
      || exportedRoot.keyId !== keyIds.rootInitial
    ) {
      throw new Error('Root public export verification failed');
    }
    passScenario('root_public_export');

    callWorker(resolvedBoundary, {
      action: 'copy',
      destination: backupFiles.publisherA,
      source: privateFiles.publisherA,
    });
    callWorker(resolvedBoundary, {
      action: 'destroy',
      target: privateFiles.publisherA,
    });
    callWorker(resolvedBoundary, {
      action: 'copy',
      destination: privateFiles.publisherA,
      source: backupFiles.publisherA,
    });
    const publisherRecoveryPayload =
      'agentmesh360-e0-publisher-loss-recovery-v1\n';
    const publisherRecoverySignature = callWorker(resolvedBoundary, {
      action: 'sign',
      payload: publisherRecoveryPayload,
      target: privateFiles.publisherA,
    }).signatureBase64;
    verifyRawSignature(
      publicEvidence.publisherA.publicKeyBase64,
      publisherRecoveryPayload,
      publisherRecoverySignature,
    );
    passScenario('publisher_loss_recovery');

    callWorker(resolvedBoundary, {
      action: 'copy',
      destination: backupFiles.rootInitial,
      source: privateFiles.rootInitial,
    });
    callWorker(resolvedBoundary, {
      action: 'destroy',
      target: privateFiles.rootInitial,
    });
    callWorker(resolvedBoundary, {
      action: 'copy',
      destination: privateFiles.rootInitial,
      source: backupFiles.rootInitial,
    });
    const rootRecoveryPayload = 'agentmesh360-e0-root-loss-recovery-v1\n';
    const rootRecoverySignature = callWorker(resolvedBoundary, {
      action: 'sign',
      payload: rootRecoveryPayload,
      target: privateFiles.rootInitial,
    }).signatureBase64;
    verifyRawSignature(
      publicEvidence.rootInitial.publicKeyBase64,
      rootRecoveryPayload,
      rootRecoverySignature,
    );
    passScenario('root_loss_recovery');

    const now = new Date();
    const generatedAt = timestamp(now, -5 * 60 * 1000);
    const expiresAt = timestamp(now, 2 * 60 * 60 * 1000);
    const notBefore = timestamp(now, -5 * 60 * 1000);
    const notAfter = timestamp(now, 60 * 60 * 1000);
    const rootsInitial = new Map([
      [keyIds.rootInitial, publicEvidence.rootInitial.publicKeyBase64],
    ]);
    const rootsOverlap = new Map([
      [keyIds.rootInitial, publicEvidence.rootInitial.publicKeyBase64],
      [keyIds.rootSuccessor, publicEvidence.rootSuccessor.publicKeyBase64],
    ]);
    const rootsSuccessorOnly = new Map([
      [keyIds.rootSuccessor, publicEvidence.rootSuccessor.publicKeyBase64],
    ]);

    function publisherRecord(alias, status, window = {}) {
      return {
        keyId: keyIds[alias],
        publisher: 'agentmesh360',
        algorithm: 'ed25519',
        publicKey: publicEvidence[alias].publicKeyBase64,
        status,
        notBefore: window.notBefore ?? notBefore,
        notAfter: window.notAfter ?? notAfter,
      };
    }

    function signedBundle(sequence, rootAlias, keys, window = {}) {
      const bundle = {
        schemaVersion: 1,
        sequence,
        rootKeyId: keyIds[rootAlias],
        generatedAt: window.generatedAt ?? generatedAt,
        expiresAt: window.expiresAt ?? expiresAt,
        keys: [...keys].sort((left, right) =>
          compareCanonicalKeyId(left.keyId, right.keyId),
        ),
        signature: '',
      };
      bundle.signature = callWorker(resolvedBoundary, {
        action: 'sign',
        payload: canonicalTrustPayload(bundle),
        target: privateFiles[rootAlias],
      }).signatureBase64;
      return bundle;
    }

    const bundle1 = signedBundle(1, 'rootInitial', [
      publisherRecord('publisherA', 'active'),
    ]);
    const verified1 = verifyTrustBundle(bundle1, rootsInitial, now, 1);
    const bundle2 = signedBundle(2, 'rootInitial', [
      publisherRecord('publisherA', 'active'),
      publisherRecord('publisherB', 'active'),
    ]);
    const verified2 = verifyTrustBundle(bundle2, rootsInitial, now, 2);
    passScenario('publisher_overlap_rotation');
    const bundle3 = signedBundle(3, 'rootInitial', [
      publisherRecord('publisherA', 'retired'),
      publisherRecord('publisherB', 'active'),
    ]);
    const verified3 = verifyTrustBundle(bundle3, rootsInitial, now, 3);
    passScenario('publisher_retirement');
    const bundle4 = signedBundle(4, 'rootInitial', [
      publisherRecord('publisherA', 'revoked'),
      publisherRecord('publisherB', 'active'),
    ]);
    const verified4 = verifyTrustBundle(bundle4, rootsInitial, now, 4);
    if (
      verified1.activeKeyIds.length !== 1
      || verified2.activeKeyIds.length !== 2
      || verified3.activeKeyIds.includes(keyIds.publisherA)
      || verified4.activeKeyIds.includes(keyIds.publisherA)
      || !verified4.activeKeyIds.includes(keyIds.publisherB)
    ) {
      throw new Error('publisher rotation state verification failed');
    }
    passScenario('publisher_compromise');
    passScenario('publisher_revocation');

    const rootHandoffPayload = [
      'agentmesh360-root-rotation-v1',
      `from=${keyIds.rootInitial}`,
      `to=${keyIds.rootSuccessor}`,
      `successorPublicKey=${publicEvidence.rootSuccessor.publicKeyBase64}`,
      `effectiveTrustSequence=5`,
      '',
    ].join('\n');
    const rootHandoffSignature = callWorker(resolvedBoundary, {
      action: 'sign',
      payload: rootHandoffPayload,
      target: privateFiles.rootInitial,
    }).signatureBase64;
    verifyRawSignature(
      publicEvidence.rootInitial.publicKeyBase64,
      rootHandoffPayload,
      rootHandoffSignature,
    );
    const bundle5 = signedBundle(5, 'rootSuccessor', [
      publisherRecord('publisherA', 'revoked'),
      publisherRecord('publisherB', 'active'),
    ]);
    const verified5 = verifyTrustBundle(bundle5, rootsOverlap, now, 5);
    verifyTrustBundle(bundle5, rootsSuccessorOnly, now, 5);
    passScenario('root_overlap_rotation');

    expectRejection(
      () => verifyTrustBundle(bundle3, rootsInitial, now, 4),
      'rollback_sequence',
    );
    passNegativeCheck('rollback_sequence_rejected');
    const equivocation = signedBundle(4, 'rootInitial', [
      publisherRecord('publisherA', 'retired'),
      publisherRecord('publisherB', 'active'),
    ]);
    expectRejection(
      () =>
        verifyTrustBundle(equivocation, rootsInitial, now, 4, {
          sequence: verified4.sequence,
          digest: verified4.digest,
        }),
      'same_sequence_equivocation',
    );
    passNegativeCheck('same_sequence_equivocation_rejected');
    expectRejection(
      () => verifyTrustBundle(bundle4, rootsSuccessorOnly, now, 4),
      'unknown_root',
    );
    passNegativeCheck('unknown_root_rejected');
    passScenario('root_compromise');
    passScenario('root_emergency_revocation');
    const expiredBundle = signedBundle(
      6,
      'rootSuccessor',
      [publisherRecord('publisherB', 'active')],
      {
        generatedAt: timestamp(now, -2 * 60 * 60 * 1000),
        expiresAt: timestamp(now, -60 * 1000),
      },
    );
    expectRejection(
      () => verifyTrustBundle(expiredBundle, rootsSuccessorOnly, now, 6),
      'expired_bundle',
    );
    passNegativeCheck('expired_bundle_rejected');
    passScenario('bundle_expiry');
    const expiredPublisher = signedBundle(6, 'rootSuccessor', [
      publisherRecord('publisherB', 'active', {
        notBefore: timestamp(now, -2 * 60 * 60 * 1000),
        notAfter: timestamp(now, -60 * 1000),
      }),
    ]);
    expectRejection(
      () => verifyTrustBundle(expiredPublisher, rootsSuccessorOnly, now, 6),
      'expired_active_publisher',
    );
    passNegativeCheck('expired_active_publisher_rejected');
    passScenario('publisher_expiry');
    if (verified5.activeKeyIds.includes(keyIds.publisherA)) {
      throw new Error('revoked publisher remained active after Root rotation');
    }
    passNegativeCheck('revoked_publisher_not_active');

    trustSequenceEvidence = [
      [bundle1, 'root_initial'],
      [bundle2, 'root_initial'],
      [bundle3, 'root_initial'],
      [bundle4, 'root_initial'],
      [bundle5, 'root_successor_transient'],
    ].map(([bundle, signerRootAlias]) => ({
      sequence: bundle.sequence,
      signerRootAlias,
      documentSha256: documentDigest(bundle),
      signatureVerified: true,
    }));
  } catch (error) {
    innerError = error;
  } finally {
    for (const privateFile of allPrivateFiles) {
      try {
        callWorker(resolvedBoundary, {
          action: 'destroy',
          target: privateFile,
        });
      } catch (error) {
        innerError ??= error;
      }
    }
    try {
      await rm(resolvedBoundary, { recursive: true, force: true });
      try {
        await access(resolvedBoundary);
        innerError ??= new Error('temporary ceremony directory still exists');
      } catch (error) {
        if (error?.code === 'ENOENT') cleanupCompleted = true;
        else innerError ??= error;
      }
    } catch (error) {
      innerError ??= error;
    }
  }
  if (innerError) throw innerError;
  if (!cleanupCompleted) throw new Error('ceremony cleanup could not be verified');
  passScenario('test_material_destruction');
  if (
    passedScenarios.size !== REQUIRED_SCENARIOS.length
    || passedNegativeChecks.size !== NEGATIVE_CHECKS.length
  ) {
    throw new Error('ceremony execution evidence is incomplete');
  }

  await assertProductionTrustEmpty();
  await assertNoPrivateMaterialInChangedFiles();
  const keyInventory = [
    {
      alias: 'publisher_a',
      keyId: 'agentmesh360-publisher-e0-20260728-a',
      role: 'publisher',
      publicKeySha256: publicEvidence.publisherA.publicKeySha256,
      transientSuccessor: false,
      privateMaterialPersisted: false,
      destroyed: true,
    },
    {
      alias: 'publisher_b',
      keyId: 'agentmesh360-publisher-e0-20260728-b',
      role: 'publisher',
      publicKeySha256: publicEvidence.publisherB.publicKeySha256,
      transientSuccessor: false,
      privateMaterialPersisted: false,
      destroyed: true,
    },
    {
      alias: 'root_initial',
      keyId: 'agentmesh360-root-e0-20260728-a',
      role: 'root',
      publicKeySha256: publicEvidence.rootInitial.publicKeySha256,
      transientSuccessor: false,
      privateMaterialPersisted: false,
      destroyed: true,
    },
    {
      alias: 'root_successor_transient',
      keyId: 'agentmesh360-root-e0-20260728-b',
      role: 'root',
      publicKeySha256: publicEvidence.rootSuccessor.publicKeySha256,
      transientSuccessor: true,
      privateMaterialPersisted: false,
      destroyed: true,
    },
  ];
  const receipt = {
    schemaVersion: 1,
    ceremonyId: options.ceremonyId,
    environment: 'e0',
    ceremonyClass: 'test_key_rehearsal',
    authority: 'test_keys',
    approvalStatus: 'approved',
    executionStatus: 'technical_rehearsal_passed',
    algorithm: 'ed25519',
    approvalReceipt: {
      receiptId: options.approvalReceipt,
      authorizedScope: 'p2_e0_local_test_key_rehearsal',
      authorizedWindow: 'current_development_cycle_only',
      externalServicesUsed: false,
      providerRequests: 0,
      creditsConsumed: 0,
      currencyCost: 0,
    },
    sourceCommit: options.sourceCommit,
    roleAliases: [
      'independent_reviewer',
      'release_authorizer',
      'rehearsal_operator',
    ],
    keyInventory,
    trustSequenceEvidence,
    scenarioResults: REQUIRED_SCENARIOS.map((scenario) => {
      if (!passedScenarios.has(scenario)) {
        throw new Error(`scenario execution was not bound: ${scenario}`);
      }
      return {
        scenario,
        status: 'passed',
        evidenceCode: `${scenario}_verified`,
      };
    }),
    negativeChecks: NEGATIVE_CHECKS.map((check) => {
      if (!passedNegativeChecks.has(check)) {
        throw new Error(`negative check execution was not bound: ${check}`);
      }
      return { check, status: 'passed' };
    }),
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
    completedAt: new Date().toISOString(),
  };
  const errors = validateKeyCeremonyReceipt(receipt);
  if (errors.length > 0) {
    throw new Error(`generated receipt is invalid:\n- ${errors.join('\n- ')}`);
  }
  assertReceiptSafeForRetention(receipt);
  await writeFile(
    options.outputPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return path.relative(REPOSITORY_ROOT, options.outputPath);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const output = await runCeremony(options);
  console.log(`E0 technical key rehearsal completed; retained receipt: ${output}`);
}

function isMainModule() {
  return process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
