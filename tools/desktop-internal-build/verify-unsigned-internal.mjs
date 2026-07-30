#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  lstat,
  open,
  readFile,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { TextDecoder } from 'node:util';
import { pathToFileURL } from 'node:url';

const MAX_RECEIPT_BYTES = 128 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExactKeys(value, expected, label) {
  assertCondition(
    value && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assertCondition(
    actual.join('\n') === wanted.join('\n'),
    `${label} fields are invalid`,
  );
}

function hasDuplicateJsonObjectKeys(document) {
  let offset = 0;
  let duplicate = false;

  function skipWhitespace() {
    while (/\s/u.test(document[offset] ?? '')) offset += 1;
  }

  function readString() {
    const start = offset;
    offset += 1;
    while (offset < document.length) {
      if (document[offset] === '\\') {
        offset += 2;
      } else if (document[offset] === '"') {
        offset += 1;
        return JSON.parse(document.slice(start, offset));
      } else {
        offset += 1;
      }
    }
    throw new Error('unterminated JSON string');
  }

  function readValue() {
    skipWhitespace();
    if (document[offset] === '{') return readObject();
    if (document[offset] === '[') return readArray();
    if (document[offset] === '"') return readString();
    while (
      offset < document.length
      && !/[\s,\]}]/u.test(document[offset])
    ) {
      offset += 1;
    }
    return undefined;
  }

  function readObject() {
    offset += 1;
    skipWhitespace();
    const keys = new Set();
    if (document[offset] === '}') {
      offset += 1;
      return;
    }
    while (offset < document.length) {
      skipWhitespace();
      const key = readString();
      if (keys.has(key)) duplicate = true;
      keys.add(key);
      skipWhitespace();
      assertCondition(document[offset] === ':', 'invalid JSON object');
      offset += 1;
      readValue();
      skipWhitespace();
      if (document[offset] === '}') {
        offset += 1;
        return;
      }
      assertCondition(document[offset] === ',', 'invalid JSON object');
      offset += 1;
    }
  }

  function readArray() {
    offset += 1;
    skipWhitespace();
    if (document[offset] === ']') {
      offset += 1;
      return;
    }
    while (offset < document.length) {
      readValue();
      skipWhitespace();
      if (document[offset] === ']') {
        offset += 1;
        return;
      }
      assertCondition(document[offset] === ',', 'invalid JSON array');
      offset += 1;
    }
  }

  readValue();
  skipWhitespace();
  assertCondition(offset === document.length, 'invalid trailing JSON');
  return duplicate;
}

function decodeStrictJson(bytes, label) {
  let document;
  try {
    document = UTF8_DECODER.decode(bytes);
    assertCondition(
      !hasDuplicateJsonObjectKeys(document),
      `${label} contains duplicate JSON object keys`,
    );
    return JSON.parse(document);
  } catch (error) {
    if (
      error instanceof Error
      && error.message.includes('duplicate JSON object keys')
    ) {
      throw error;
    }
    throw new Error(`${label} is not strict valid JSON`);
  }
}

async function readBoundedRegularFile(
  filePath,
  label,
  maximumBytes,
) {
  const inspected = await inspectBoundedRegularFile(
    filePath,
    label,
    maximumBytes,
  );
  return {
    bytes: await readFile(inspected.resolved),
    info: inspected.info,
  };
}

async function inspectBoundedRegularFile(
  filePath,
  label,
  maximumBytes,
) {
  const direct = await lstat(filePath);
  assertCondition(
    direct.isFile() && !direct.isSymbolicLink(),
    `${label} must be a regular non-symlink file`,
  );
  assertCondition(
    direct.size > 0 && direct.size <= maximumBytes,
    `${label} size is invalid`,
  );
  const resolved = await realpath(filePath);
  const resolvedInfo = await lstat(resolved);
  assertCondition(
    resolvedInfo.isFile()
      && !resolvedInfo.isSymbolicLink()
      && resolvedInfo.dev === direct.dev
      && resolvedInfo.ino === direct.ino,
    `${label} changed while being inspected`,
  );
  return {
    info: resolvedInfo,
    resolved,
  };
}

function validateReceipt(receipt) {
  assertExactKeys(
    receipt,
    [
      'schemaVersion',
      'receiptId',
      'distributionClass',
      'buildStatus',
      'source',
      'artifactPolicy',
      'artifacts',
      'instructions',
      'evidence',
      'createdAt',
    ],
    'receipt',
  );
  assertCondition(receipt.schemaVersion === 1, 'schemaVersion is invalid');
  assertCondition(
    /^desktop_internal_p6_[0-9a-f]{12}_(arm64|x64)$/u.test(
      receipt.receiptId,
    ),
    'receiptId is invalid',
  );
  assertCondition(
    receipt.distributionClass === 'unsigned_internal_only'
      && receipt.buildStatus === 'passed',
    'receipt is not a passed unsigned internal build',
  );

  assertExactKeys(
    receipt.source,
    [
      'commit',
      'desktopVersion',
      'bundleId',
      'productName',
      'architecture',
      'minimumMacOSVersion',
      'desktopPackageJsonSha256',
      'desktopPackageLockSha256',
    ],
    'source',
  );
  assertCondition(
    COMMIT_PATTERN.test(receipt.source.commit)
      && receipt.receiptId.includes(receipt.source.commit.slice(0, 12)),
    'source commit is invalid',
  );
  assertCondition(
    SEMVER_PATTERN.test(receipt.source.desktopVersion),
    'desktop version is invalid',
  );
  assertCondition(
    receipt.source.bundleId === 'com.agentmesh360.client'
      && receipt.source.productName === 'AgentMesh360'
      && ['arm64', 'x64'].includes(receipt.source.architecture)
      && receipt.receiptId.endsWith(`_${receipt.source.architecture}`)
      && receipt.source.minimumMacOSVersion === 'not_frozen_for_internal'
      && SHA256_PATTERN.test(receipt.source.desktopPackageJsonSha256)
      && SHA256_PATTERN.test(receipt.source.desktopPackageLockSha256),
    'source boundary is invalid',
  );

  assertExactKeys(
    receipt.artifactPolicy,
    [
      'developerIdSigned',
      'notarized',
      'appleCredentialsRead',
      'externalUploadPerformed',
      'publishProviderConfigured',
      'automaticUpdateEnabled',
      'packagedHostVerified',
      'manualGatekeeperReviewRequired',
      'sha256Required',
      'productionR4Satisfied',
    ],
    'artifactPolicy',
  );
  assertCondition(
    receipt.artifactPolicy.developerIdSigned === false
      && receipt.artifactPolicy.notarized === false
      && receipt.artifactPolicy.appleCredentialsRead === false
      && receipt.artifactPolicy.externalUploadPerformed === false
      && receipt.artifactPolicy.publishProviderConfigured === false
      && receipt.artifactPolicy.automaticUpdateEnabled === false
      && receipt.artifactPolicy.packagedHostVerified === true
      && receipt.artifactPolicy.manualGatekeeperReviewRequired === true
      && receipt.artifactPolicy.sha256Required === true
      && receipt.artifactPolicy.productionR4Satisfied === false,
    'artifact policy must remain internal and unsigned',
  );

  assertCondition(
    Array.isArray(receipt.artifacts) && receipt.artifacts.length === 2,
    'exactly one DMG and one ZIP are required',
  );
  const kinds = [];
  const files = new Set();
  for (const artifact of receipt.artifacts) {
    assertExactKeys(
      artifact,
      ['kind', 'file', 'sizeBytes', 'sha256'],
      'artifact',
    );
    assertCondition(
      ['dmg', 'zip'].includes(artifact.kind)
        && typeof artifact.file === 'string'
        && path.basename(artifact.file) === artifact.file
        && !artifact.file.includes('/')
        && !artifact.file.includes('\\')
        && artifact.file.endsWith(`.${artifact.kind}`)
        && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}\.(dmg|zip)$/u.test(
          artifact.file,
        )
        && Number.isSafeInteger(artifact.sizeBytes)
        && artifact.sizeBytes > 0
        && artifact.sizeBytes <= MAX_ARTIFACT_BYTES
        && SHA256_PATTERN.test(artifact.sha256),
      'artifact boundary is invalid',
    );
    assertCondition(!files.has(artifact.file), 'artifact file is duplicated');
    files.add(artifact.file);
    kinds.push(artifact.kind);
  }
  assertCondition(
    [...kinds].sort().join(',') === 'dmg,zip',
    'artifact kinds are invalid',
  );

  assertExactKeys(
    receipt.instructions,
    ['document', 'gatekeeperAction', 'globalGatekeeperDisableRequired'],
    'instructions',
  );
  assertCondition(
    receipt.instructions.document
      === 'docs/operations/P6_UNSIGNED_INTERNAL_DISTRIBUTION.md'
      && receipt.instructions.gatekeeperAction
        === 'privacy_and_security_open_anyway'
      && receipt.instructions.globalGatekeeperDisableRequired === false,
    'manual Gatekeeper instructions are invalid',
  );

  assertExactKeys(
    receipt.evidence,
    [
      'buildNetworkScope',
      'providerRequests',
      'agentMeshCredits',
      'appleServiceRequests',
      'currencyCostUsd',
    ],
    'evidence',
  );
  assertCondition(
    receipt.evidence.buildNetworkScope
      === 'dependency_and_build_tooling_only'
      && receipt.evidence.providerRequests === 0
      && receipt.evidence.agentMeshCredits === 0
      && receipt.evidence.appleServiceRequests === 0
      && receipt.evidence.currencyCostUsd === 0,
    'build evidence boundary is invalid',
  );
  assertCondition(
    typeof receipt.createdAt === 'string'
      && Number.isFinite(Date.parse(receipt.createdAt))
      && receipt.createdAt.endsWith('Z'),
    'createdAt is invalid',
  );
}

export async function sha256File(filePath) {
  const inspected = await inspectBoundedRegularFile(
    filePath,
    'artifact',
    MAX_ARTIFACT_BYTES,
  );
  const handle = await open(inspected.resolved, 'r');
  try {
    const before = await handle.stat();
    assertCondition(
      before.dev === inspected.info.dev
        && before.ino === inspected.info.ino
        && before.size === inspected.info.size,
      'artifact changed before hashing',
    );
    const hash = createHash('sha256');
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) hash.update(chunk);
    const after = await handle.stat();
    assertCondition(
      after.dev === before.dev
        && after.ino === before.ino
        && after.size === before.size
        && after.mtimeMs === before.mtimeMs,
      'artifact changed while being hashed',
    );
    return `sha256:${hash.digest('hex')}`;
  } finally {
    await handle.close();
  }
}

export async function verifyUnsignedInternalBuild(receiptPath) {
  assertCondition(path.isAbsolute(receiptPath), 'receipt path must be absolute');
  const { bytes } = await readBoundedRegularFile(
    receiptPath,
    'receipt',
    MAX_RECEIPT_BYTES,
  );
  const receipt = decodeStrictJson(bytes, 'receipt');
  validateReceipt(receipt);

  const boundary = path.dirname(await realpath(receiptPath));
  const checksumLines = [];
  for (const artifact of receipt.artifacts) {
    const artifactPath = path.join(boundary, artifact.file);
    const { info } = await inspectBoundedRegularFile(
      artifactPath,
      `artifact ${artifact.kind}`,
      MAX_ARTIFACT_BYTES,
    );
    const digest = await sha256File(artifactPath);
    assertCondition(
      info.size === artifact.sizeBytes && digest === artifact.sha256,
      `artifact ${artifact.kind} digest or size mismatch`,
    );
    checksumLines.push(`${digest.slice('sha256:'.length)}  ${artifact.file}`);
  }
  checksumLines.sort();

  const checksumPath = path.join(boundary, 'SHA256SUMS');
  const { bytes: checksumBytes } = await readBoundedRegularFile(
    checksumPath,
    'SHA256SUMS',
    16 * 1024,
  );
  const checksumText = UTF8_DECODER.decode(checksumBytes);
  assertCondition(
    checksumText === `${checksumLines.join('\n')}\n`,
    'SHA256SUMS does not exactly match receipt artifacts',
  );

  return Object.freeze({
    status: 'passed',
    receiptId: receipt.receiptId,
    distributionClass: receipt.distributionClass,
    commit: receipt.source.commit,
    architecture: receipt.source.architecture,
    artifactCount: receipt.artifacts.length,
  });
}

async function main() {
  if (
    process.argv.length !== 3
    || !path.isAbsolute(process.argv[2] ?? '')
  ) {
    throw new Error(
      'usage: node verify-unsigned-internal.mjs <absolute-receipt-path>',
    );
  }
  const result = await verifyUnsignedInternalBuild(process.argv[2]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'verification failed'}\n`,
    );
    process.exitCode = 1;
  });
}
