#!/usr/bin/env node

import {
  createHash,
  createPublicKey,
  verify,
} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  canonicalTrustPayload,
  verifyTrustBundle,
} from '../key-ceremony/run-e0-key-ceremony.mjs';
import {
  readCredentialFile,
  requestSpaces,
} from './spaces-client.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const SIGNER = path.join(
  REPOSITORY_ROOT,
  'tools/release-provenance/e0-release-signer.mjs',
);
const AUTHORIZATION_ID = 'distribution_service_e1_20260728_0001';
const ROOT_KEY_ID = 'agentmesh360-root-e1-p4-20260728-01';
const MAX_FILE_BYTES = 64 * 1024 * 1024;

function typedSha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error('publication executor git inspection failed');
  }
  return result.stdout.trim();
}

async function assertExecutorBoundary(executorCommit) {
  if (
    !/^[0-9a-f]{40}$/u.test(executorCommit)
    || runGit(['rev-parse', 'HEAD']) !== executorCommit
    || runGit(['status', '--porcelain=v1', '--untracked-files=all']) !== ''
  ) {
    throw new Error('publication executor is not the approved clean commit');
  }
  const trustSource = await readFile(path.join(
    REPOSITORY_ROOT,
    'crates/codegen/xai-grok-shell/src/agentmesh360/package_trust.rs',
  ), 'utf8');
  const fetcherSource = await readFile(path.join(
    REPOSITORY_ROOT,
    'crates/codegen/xai-grok-shell/src/agentmesh360/package_registry_fetcher.rs',
  ), 'utf8');
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

function plainSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readMode0600Json(filePath, label, maximum = 8 * 1024 * 1024) {
  const resolved = await realpath(filePath);
  const stat = await lstat(resolved);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size <= 0
    || stat.size > maximum
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

async function readBoundedFile(filePath) {
  const resolved = await realpath(filePath);
  const stat = await lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
    throw new Error('Release object is not a bounded regular file');
  }
  return readFile(resolved);
}

function invokeSigner(boundary, request) {
  const result = spawnSync(process.execPath, [SIGNER], {
    encoding: 'utf8',
    input: `${JSON.stringify({ ...request, boundary })}\n`,
    maxBuffer: 256 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error('isolated E1 signer operation failed');
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('isolated E1 signer returned invalid JSON');
  }
}

function publicKeyObject(publicKeyBase64) {
  const raw = Buffer.from(publicKeyBase64, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== publicKeyBase64) {
    throw new Error('Ed25519 public key is not canonical');
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

function verifyRawSignature(publicKeyBase64, payload, signatureBase64) {
  const signature = Buffer.from(signatureBase64, 'base64');
  if (
    signature.length !== 64
    || signature.toString('base64') !== signatureBase64
    || !verify(
      null,
      Buffer.from(payload, 'utf8'),
      publicKeyObject(publicKeyBase64),
      signature,
    )
  ) {
    throw new Error('E1 Root signature verification failed');
  }
}

function base64Text(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function canonicalRegistryPayload(snapshot) {
  let payload = [
    'agentmesh360-package-registry-v2',
    `schemaVersion=${snapshot.schemaVersion}`,
    `revision=${snapshot.revision}`,
    `rootKeyId=${snapshot.rootKeyId}`,
    `trustBundleSequence=${snapshot.trustBundleSequence}`,
    `generatedAt=${snapshot.generatedAt}`,
    `expiresAt=${snapshot.expiresAt}`,
    '',
  ].join('\n');
  for (const record of snapshot.packages) {
    payload += [
      'package=',
      base64Text(record.packageId),
      '|',
      base64Text(record.agentId),
      '|',
      base64Text(record.version),
      '|',
      base64Text(record.publisher),
      '|',
      base64Text(record.releaseManifestUrl),
      '|',
      record.releaseManifestSha256,
      '|',
      base64Text(record.artifactUrl),
      '|',
      record.artifactSha256,
      '|',
      base64Text(record.envelopeUrl),
      '|',
      record.envelopeSha256,
      '|',
      base64Text(record.hostProjectionUrl),
      '|',
      record.hostProjectionSha256,
      '|',
      record.hostBundles.length,
      '\n',
    ].join('');
    for (const bundle of record.hostBundles) {
      payload += [
        'host=',
        base64Text(record.packageId),
        '|',
        bundle.host,
        '|',
        base64Text(bundle.entrypoint),
        '|',
        base64Text(bundle.bundleUrl),
        '|',
        bundle.bundleSha256,
        '\n',
      ].join('');
    }
  }
  return payload;
}

function signDocument(boundary, privateKeyPath, payload) {
  const result = invokeSigner(boundary, {
    action: 'sign',
    payloadBase64: Buffer.from(payload, 'utf8').toString('base64'),
    target: privateKeyPath,
  });
  if (
    typeof result.signatureBase64 !== 'string'
    || !/^sha256:[0-9a-f]{64}$/u.test(result.signatureSha256)
  ) {
    throw new Error('isolated E1 signer returned invalid signature evidence');
  }
  return result.signatureBase64;
}

function strictRegistryRecord(record, releaseOrigin) {
  const keys = [
    'agentId',
    'artifactSha256',
    'artifactUrl',
    'envelopeSha256',
    'envelopeUrl',
    'hostBundles',
    'hostProjectionSha256',
    'hostProjectionUrl',
    'packageId',
    'publisher',
    'releaseManifestSha256',
    'releaseManifestUrl',
    'version',
  ];
  if (
    !record
    || typeof record !== 'object'
    || Array.isArray(record)
    || Object.keys(record).sort().join('\n') !== keys.join('\n')
    || record.publisher !== 'agentmesh360'
    || !Array.isArray(record.hostBundles)
  ) {
    throw new Error('Registry record fields are invalid');
  }
  for (const [field, value] of Object.entries(record)) {
    if (field.endsWith('Sha256') && !/^[0-9a-f]{64}$/u.test(value)) {
      throw new Error('Registry record digest is invalid');
    }
    if (field.endsWith('Url')) {
      const url = new URL(value);
      if (
        !value.startsWith(`${releaseOrigin}/objects/releases/`)
        || url.username
        || url.password
        || url.search
        || url.hash
      ) {
        throw new Error('Registry record URL escaped the E1 origin');
      }
    }
  }
  for (const bundle of record.hostBundles) {
    const bundleKeys = [
      'bundleSha256',
      'bundleUrl',
      'entrypoint',
      'host',
    ];
    if (
      !bundle
      || typeof bundle !== 'object'
      || Array.isArray(bundle)
      || Object.keys(bundle).sort().join('\n') !== bundleKeys.join('\n')
      || !/^[a-z0-9-]{1,64}$/u.test(bundle.host)
      || typeof bundle.entrypoint !== 'string'
      || !bundle.entrypoint.startsWith('skills/')
      || !/^[0-9a-f]{64}$/u.test(bundle.bundleSha256)
    ) {
      throw new Error('Registry Host bundle fields are invalid');
    }
    const bundleUrl = new URL(bundle.bundleUrl);
    if (
      !bundle.bundleUrl.startsWith(`${releaseOrigin}/objects/releases/`)
      || bundleUrl.username
      || bundleUrl.password
      || bundleUrl.search
      || bundleUrl.hash
    ) {
      throw new Error('Registry Host bundle URL escaped the E1 origin');
    }
  }
  record.hostBundles.sort((left, right) =>
    Buffer.from(left.host).compare(Buffer.from(right.host)));
  return record;
}

function objectKeyFromUrl(url, releaseOrigin) {
  if (!url.startsWith(`${releaseOrigin}/objects/`)) {
    throw new Error('Release object URL escaped the E1 origin');
  }
  const parsed = new URL(url);
  if (
    parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !parsed.pathname.startsWith('/objects/')
  ) {
    throw new Error('Release object URL is not canonical');
  }
  return decodeURIComponent(parsed.pathname.slice('/objects/'.length));
}

function objectContentType(fileName) {
  if (fileName.endsWith('.json')) return 'application/json';
  if (fileName.endsWith('.tar.zst')) return 'application/zstd';
  throw new Error('Release object MIME is not approved');
}

async function releaseObjects(state, records) {
  const objects = [];
  for (let index = 0; index < state.agents.length; index += 1) {
    const build = state.builds[index];
    const assembled = state.assembled[index];
    const record = records[index];
    const releaseManifestPath = path.join(
      assembled.output,
      'release-manifest',
      assembled.receipt.releaseManifest.fileName,
    );
    const envelopePath = path.join(
      assembled.output,
      assembled.receipt.envelope.fileName,
    );
    const mappings = [
      [record.artifactUrl, build.receipt.artifactPath, record.artifactSha256],
      [record.envelopeUrl, envelopePath, record.envelopeSha256],
      [
        record.hostProjectionUrl,
        build.receipt.hostProjectionPath,
        record.hostProjectionSha256,
      ],
      [
        record.releaseManifestUrl,
        releaseManifestPath,
        record.releaseManifestSha256,
      ],
    ];
    for (const bundle of record.hostBundles) {
      mappings.push([
        bundle.bundleUrl,
        path.join(
          assembled.output,
          'host-bundles',
          path.basename(new URL(bundle.bundleUrl).pathname),
        ),
        bundle.bundleSha256,
      ]);
    }
    const manifestName = assembled.receipt.packageFileManifest.fileName;
    mappings.push([
      `${state.releaseOrigin}/objects/releases/${record.packageId}/${record.version}/${manifestName}`,
      path.join(assembled.output, manifestName),
      assembled.receipt.packageFileManifest.sha256,
    ]);
    for (const [url, filePath, digest] of mappings) {
      const bytes = await readBoundedFile(filePath);
      if (plainSha256(bytes) !== digest) {
        throw new Error('Release object digest differs from signed metadata');
      }
      objects.push({
        bytes,
        contentType: objectContentType(path.basename(filePath)),
        digest: typedSha256(bytes),
        objectKey: objectKeyFromUrl(url, state.releaseOrigin),
      });
    }
  }
  const keys = objects.map((object) => object.objectKey);
  if (new Set(keys).size !== keys.length) {
    throw new Error('Release object keys are not unique');
  }
  return objects.sort((left, right) =>
    Buffer.from(left.objectKey).compare(Buffer.from(right.objectKey)));
}

function publicationWindow(originState) {
  const now = new Date();
  const destroyAt = new Date(originState.automaticDestroyNoLaterThan);
  if (!Number.isFinite(destroyAt.getTime()) || destroyAt <= now) {
    throw new Error('approved E1 execution window has expired');
  }
  return {
    generatedAt: new Date(now.getTime() - 60_000).toISOString(),
    expiresAt: new Date(
      Math.min(destroyAt.getTime() - 60_000, now.getTime() + 48 * 60 * 60_000),
    ).toISOString(),
  };
}

async function putNewObject(credentials, bucket, object) {
  const absent = await requestSpaces({
    credentials,
    principal: 'publisher',
    bucket,
    method: 'HEAD',
    objectKey: object.objectKey,
    expectedStatuses: [404],
  });
  await absent.response.body?.cancel();
  const put = await requestSpaces({
    credentials,
    principal: 'publisher',
    bucket,
    method: 'PUT',
    objectKey: object.objectKey,
    body: object.bytes,
    contentType: object.contentType,
    expectedStatuses: [200],
  });
  await put.response.body?.cancel();
  const readback = await requestSpaces({
    credentials,
    principal: 'origin-reader',
    bucket,
    method: 'GET',
    objectKey: object.objectKey,
    expectedStatuses: [200],
  });
  const returned = Buffer.from(await readback.response.arrayBuffer());
  if (typedSha256(returned) !== object.digest) {
    throw new Error('Spaces readback digest mismatch');
  }
  return {
    bucketClass: bucket === credentials.releasesBucket ? 'release' : 'metadata',
    objectKey: object.objectKey,
    sha256: object.digest,
  };
}

function mutateSignature(signature) {
  const bytes = Buffer.from(signature, 'base64');
  bytes[0] ^= 1;
  return bytes.toString('base64');
}

async function createMetadata(state, originState) {
  const boundary = await realpath(state.boundary);
  const records = [];
  for (const assembled of state.assembled) {
    const recordPath = path.join(
      assembled.output,
      assembled.receipt.registryRecord.fileName,
    );
    records.push(strictRegistryRecord(
      JSON.parse((await readBoundedFile(recordPath)).toString('utf8')),
      state.releaseOrigin,
    ));
  }
  records.sort((left, right) =>
    Buffer.from(left.packageId).compare(Buffer.from(right.packageId)));
  const rootKeyPath = path.join(boundary, 'private/root.pk8');
  const rootEvidence = invokeSigner(boundary, {
    action: 'generate',
    target: rootKeyPath,
  });
  const window = publicationWindow(originState);
  const trust = {
    schemaVersion: 1,
    sequence: 1,
    rootKeyId: ROOT_KEY_ID,
    generatedAt: window.generatedAt,
    expiresAt: window.expiresAt,
    keys: [{
      keyId: state.publisherKeyId,
      publisher: 'agentmesh360',
      algorithm: 'ed25519',
      publicKey: state.publicEvidence.publicKeyBase64,
      status: 'active',
      notBefore: window.generatedAt,
      notAfter: window.expiresAt,
    }],
    signature: '',
  };
  trust.signature = signDocument(
    boundary,
    rootKeyPath,
    canonicalTrustPayload(trust),
  );
  verifyRawSignature(
    rootEvidence.publicKeyBase64,
    canonicalTrustPayload(trust),
    trust.signature,
  );
  verifyTrustBundle(
    trust,
    new Map([[ROOT_KEY_ID, rootEvidence.publicKeyBase64]]),
    new Date(),
    1,
  );
  const registry = {
    schemaVersion: 2,
    revision: 2,
    rootKeyId: ROOT_KEY_ID,
    trustBundleSequence: 1,
    generatedAt: window.generatedAt,
    expiresAt: window.expiresAt,
    packages: records,
    signature: '',
  };
  registry.signature = signDocument(
    boundary,
    rootKeyPath,
    canonicalRegistryPayload(registry),
  );
  verifyRawSignature(
    rootEvidence.publicKeyBase64,
    canonicalRegistryPayload(registry),
    registry.signature,
  );
  return {
    records,
    registry,
    rootEvidence,
    rootKeyPath,
    trust,
    window,
  };
}

function faultDocuments(metadata) {
  const documents = [];
  const signedRegistry = (scenario, mutate) => {
    const value = structuredClone(metadata.registry);
    mutate(value);
    value.signature = signDocument(
      path.dirname(path.dirname(metadata.rootKeyPath)),
      metadata.rootKeyPath,
      canonicalRegistryPayload(value),
    );
    documents.push({
      scenario,
      target: 'registry',
      value,
    });
  };
  signedRegistry('digest_mismatch', (value) => {
    value.packages[0].artifactSha256 = '0'.repeat(64);
  });
  const badSignature = structuredClone(metadata.registry);
  badSignature.signature = mutateSignature(badSignature.signature);
  documents.push({
    scenario: 'signature_mismatch',
    target: 'registry',
    value: badSignature,
  });
  signedRegistry('expired_metadata', (value) => {
    value.generatedAt = '2026-07-27T00:00:00.000Z';
    value.expiresAt = '2026-07-27T01:00:00.000Z';
  });
  signedRegistry('registry_rollback', (value) => {
    value.revision = 1;
  });
  signedRegistry('same_revision_equivocation', (value) => {
    value.packages[0].envelopeSha256 = 'f'.repeat(64);
  });
  signedRegistry('invalid_or_expired_lkg', (value) => {
    value.generatedAt = '2026-07-27T00:00:00.000Z';
    value.expiresAt = '2026-07-27T01:00:00.000Z';
    value.revision = 1;
  });
  return documents;
}

async function publish(options) {
  await assertExecutorBoundary(options.executorCommit);
  const state = await readMode0600Json(
    options.releaseState,
    'Release Set state',
  );
  const originState = await readMode0600Json(
    options.originState,
    'origin state',
  );
  if (
    state.authorizationId !== AUTHORIZATION_ID
    || originState.authorizationId !== AUTHORIZATION_ID
    || state.releaseOrigin !== `https://${originState.dns?.hostname}`
    || state.agentResults?.length !== 4
    || !state.agentResults.every((result) =>
      result.status === 'passed'
      && result.buildCount === 2
      && result.outputComparisons?.length === 10)
  ) {
    throw new Error('Release Set state differs from the approved E1 boundary');
  }
  const credentials = await readCredentialFile(options.credentials);
  const metadata = await createMetadata(state, originState);
  const objects = await releaseObjects(state, metadata.records);
  const trustBytes = Buffer.from(`${JSON.stringify(metadata.trust)}\n`, 'utf8');
  const uploads = [{
    bucket: credentials.metadataBucket,
    object: {
      bytes: trustBytes,
      contentType: 'application/json',
      digest: typedSha256(trustBytes),
      objectKey: 'metadata/trust-bundle.v1.json',
    },
  }];
  for (const object of objects) {
    uploads.push({
      bucket: credentials.releasesBucket,
      object,
    });
  }
  for (const fault of faultDocuments(metadata)) {
    const bytes = Buffer.from(`${JSON.stringify(fault.value)}\n`, 'utf8');
    uploads.push({
      bucket: credentials.metadataBucket,
      object: {
        bytes,
        contentType: 'application/json',
        digest: typedSha256(bytes),
        objectKey: `faults/${fault.scenario}/${fault.target}.json`,
      },
    });
  }
  const registryBytes =
    Buffer.from(`${JSON.stringify(metadata.registry)}\n`, 'utf8');
  uploads.push({
    bucket: credentials.metadataBucket,
    object: {
      bytes: registryBytes,
      contentType: 'application/json',
      digest: typedSha256(registryBytes),
      objectKey: 'metadata/registry.v2.json',
    },
  });
  const publicationState = {
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    executionStatus: 'publishing',
    executorCommit: options.executorCommit,
    buildExecutorCommit: state.executorCommit,
    releaseState: options.releaseState,
    rootKeyId: ROOT_KEY_ID,
    rootPublicKeyBase64: metadata.rootEvidence.publicKeyBase64,
    rootPublicKeySha256: metadata.rootEvidence.publicKeySha256,
    rootPrivateKeyPath: metadata.rootKeyPath,
    publisherPrivateKeyPath: state.privateKeyPath,
    publisherKeyId: state.publisherKeyId,
    trustSequence: 1,
    registryRevision: 2,
    generatedAt: metadata.window.generatedAt,
    expiresAt: metadata.window.expiresAt,
    plannedObjects: uploads.map(({ bucket, object }) => ({
      bucketClass:
        bucket === credentials.releasesBucket ? 'release' : 'metadata',
      objectKey: object.objectKey,
      sha256: object.digest,
    })),
    objectReceipts: [],
    registryPublishedLast: false,
    startedAt: new Date().toISOString(),
  };
  await writeFile(options.outputState, JSON.stringify(publicationState), {
    mode: 0o600,
    flag: 'wx',
  });
  await chmod(options.outputState, 0o600);
  for (const upload of uploads) {
    publicationState.objectReceipts.push(await putNewObject(
      credentials,
      upload.bucket,
      upload.object,
    ));
    publicationState.lastUpdatedAt = new Date().toISOString();
    await writeFile(options.outputState, JSON.stringify(publicationState), {
      mode: 0o600,
      flag: 'w',
    });
    await chmod(options.outputState, 0o600);
  }
  publicationState.executionStatus = 'published';
  publicationState.registryPublishedLast =
    publicationState.objectReceipts.at(-1)?.objectKey
      === 'metadata/registry.v2.json';
  publicationState.publishedAt = new Date().toISOString();
  await writeFile(options.outputState, JSON.stringify(publicationState), {
    mode: 0o600,
    flag: 'w',
  });
  await chmod(options.outputState, 0o600);
  return publicationState;
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
    '--credentials',
    '--executor-commit',
    '--origin-state',
    '--output-state',
    '--release-state',
  ];
  if (
    values.size !== required.length
    || required
      .filter((key) => key !== '--executor-commit')
      .some((key) => !path.isAbsolute(values.get(key) ?? ''))
    || !/^[0-9a-f]{40}$/u.test(values.get('--executor-commit') ?? '')
  ) {
    throw new Error(
      'usage: publish-release-set.mjs --executor-commit <commit> '
      + '--credentials <absolute> '
      + '--origin-state <absolute> --release-state <absolute> '
      + '--output-state <absolute>',
    );
  }
  return {
    credentials: values.get('--credentials'),
    executorCommit: values.get('--executor-commit'),
    originState: values.get('--origin-state'),
    outputState: values.get('--output-state'),
    releaseState: values.get('--release-state'),
  };
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
    publish(options)
      .then((state) => {
        if (!state.registryPublishedLast) {
          throw new Error('E1 Registry was not published last');
        }
        console.log(
          'E1 Trust, immutable four-Agent Release Set, faults, and Registry published with readback verification',
        );
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}

export {
  canonicalRegistryPayload,
  objectKeyFromUrl,
  parseArguments,
  publicationWindow,
  strictRegistryRecord,
};
