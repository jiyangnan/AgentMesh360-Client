#!/usr/bin/env node

import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  chmod,
  lstat,
  realpath,
  writeFile,
} from 'node:fs/promises';

import {
  canonicalTrustPayload,
  verifyTrustBundle,
} from '../key-ceremony/run-e0-key-ceremony.mjs';
import {
  assertExecutorBoundary,
  canonicalRegistryPayload,
  invokeSigner,
  publicationWindow,
  putNewObject,
  readBoundedFile,
  readMode0600Json,
  releaseObjects,
  signDocument,
  strictRegistryRecord,
  typedSha256,
  verifyRawSignature,
} from '../distribution-e1/publish-release-set.mjs';
import {
  readCredentialFile,
} from '../distribution-e1/spaces-client.mjs';
import {
  AUTHORIZATION_ID,
  BOUNDARY,
  CREDENTIAL_PATH,
  assertP5ExecutionAuthority,
} from './infrastructure-boundary.mjs';
import {
  EXPECTED_GENERATIONS,
  OUTPUT_STATE_PATH as RELEASE_STATE_PATH,
  PUBLISHER_KEY_IDS,
  assertGeneration,
} from './build-release-chain.mjs';

const ORIGIN_STATE_PATH = path.join(BOUNDARY, 'origin-state.json');
const OUTPUT_STATE_PATH =
  '/private/tmp/agentmesh360-p5-e1-publication-state.json';
const ROOT_KEY_IDS = Object.freeze({
  a: 'agentmesh360-root-e1-p5-20260729-a',
  b: 'agentmesh360-root-e1-p5-20260729-b',
});
const MAX_STATE_BYTES = 8 * 1024 * 1024;

function sortedRecords(records) {
  return [...records].sort((left, right) =>
    Buffer.from(left.packageId).compare(Buffer.from(right.packageId)));
}

function assertUniquePackages(records) {
  const identities = records.map((record) => record.packageId);
  if (
    new Set(identities).size !== identities.length
    || identities.some((value, index) =>
      index > 0 && identities[index - 1] >= value)
  ) {
    throw new Error('P5 Registry packages are not unique and sorted');
  }
  return records;
}

async function generationRecords(generation, releaseOrigin) {
  const records = [];
  for (const assembled of generation.assembled) {
    const recordPath = path.join(
      assembled.output,
      assembled.receipt.registryRecord.fileName,
    );
    records.push(strictRegistryRecord(
      JSON.parse((await readBoundedFile(recordPath)).toString('utf8')),
      releaseOrigin,
    ));
  }
  return sortedRecords(records);
}

function publisherRecord({
  generation,
  publicKey,
  status,
  window,
}) {
  return {
    keyId: PUBLISHER_KEY_IDS[generation],
    publisher: 'agentmesh360',
    algorithm: 'ed25519',
    publicKey,
    status,
    notBefore: window.generatedAt,
    notAfter: window.expiresAt,
  };
}

function signedTrust({
  boundary,
  keys,
  rootEvidence,
  rootKeyId,
  rootKeyPath,
  sequence,
  window,
  verify = true,
}) {
  const trust = {
    schemaVersion: 1,
    sequence,
    rootKeyId,
    generatedAt: window.generatedAt,
    expiresAt: window.expiresAt,
    keys: [...keys].sort((left, right) =>
      Buffer.from(left.keyId).compare(Buffer.from(right.keyId))),
    signature: '',
  };
  trust.signature = signDocument(
    boundary,
    rootKeyPath,
    canonicalTrustPayload(trust),
  );
  if (verify) {
    verifyTrustBundle(
      trust,
      new Map([[rootKeyId, rootEvidence.publicKeyBase64]]),
      new Date(),
      sequence,
    );
  }
  return trust;
}

function signedRegistry({
  boundary,
  records,
  revision,
  rootEvidence,
  rootKeyId,
  rootKeyPath,
  trustSequence,
  window,
}) {
  const registry = {
    schemaVersion: 2,
    revision,
    rootKeyId,
    trustBundleSequence: trustSequence,
    generatedAt: window.generatedAt,
    expiresAt: window.expiresAt,
    packages: assertUniquePackages(sortedRecords(records)),
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
  return registry;
}

function metadataObject(objectKey, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  return {
    bytes,
    contentType: 'application/json',
    digest: typedSha256(bytes),
    objectKey,
  };
}

function mutateSignature(signature) {
  const bytes = Buffer.from(signature, 'base64');
  if (bytes.length !== 64) {
    throw new Error('P5 Registry signature is invalid');
  }
  bytes[0] ^= 1;
  return bytes.toString('base64');
}

function validateReleaseChainState(state, originState, executorCommit) {
  if (
    state.authorizationId !== AUTHORIZATION_ID
    || state.executionStatus !== 'release_chain_built'
    || state.executorCommit !== executorCommit
    || state.releaseOrigin !== `https://${originState.dns?.hostname}`
    || state.generations?.length !== 2
    || state.temporaryPublisherPrivateKeyCount !== 2
    || state.temporaryRootPrivateKeyCount !== 0
    || state.productionAuthorityGranted !== false
    || state.cleanupRequired !== true
    || originState.authorizationId !== AUTHORIZATION_ID
    || originState.origin?.deployed !== true
    || originState.origin?.executorCommit !== executorCommit
    || originState.origin?.tls !== 'caddy_managed_lets_encrypt'
    || originState.infrastructure?.dropletCount !== 1
    || originState.infrastructure?.spacesBucketCount !== 2
  ) {
    throw new Error(
      'P5 Release Chain differs from the approved publication boundary',
    );
  }
  const generations = {};
  for (const generationName of ['a', 'b']) {
    const generation = state.generations.find(
      (value) => value.generation === generationName,
    );
    assertGeneration(generation, generationName);
    if (
      generation.publisherKeyId !== PUBLISHER_KEY_IDS[generationName]
      || generation.agentResults.map(
        (value) => `${value.agentId}@${value.version}`,
      ).join('\n') !== EXPECTED_GENERATIONS[generationName].join('\n')
    ) {
      throw new Error('P5 publication generation identity drift');
    }
    generations[generationName] = generation;
  }
  return generations;
}

async function assertRetainedGenerationBoundary(generation) {
  const direct = await lstat(generation.boundary);
  const resolved = await realpath(generation.boundary);
  const privateKey = await lstat(generation.privateKeyPath);
  if (
    direct.isSymbolicLink()
    || !direct.isDirectory()
    || (direct.mode & 0o777) !== 0o700
    || generation.boundary !== resolved
    || path.dirname(resolved) !== await realpath(os.tmpdir())
    || !path.basename(resolved).startsWith(
      'agentmesh360-release-provenance-e1-',
    )
    || generation.privateKeyPath
      !== path.join(resolved, 'private/publisher.pk8')
    || privateKey.isSymbolicLink()
    || !privateKey.isFile()
    || (privateKey.mode & 0o777) !== 0o600
    || !/^sha256:[0-9a-f]{64}$/u.test(
      generation.publicEvidence?.publicKeySha256 ?? '',
    )
  ) {
    throw new Error('P5 retained generation boundary is invalid');
  }
  return resolved;
}

function transitionDocuments({
  expansionRegistry,
  registryA,
  registryB,
  registryRevoked,
  rootA,
  rootB,
  rootKeyPathA,
  rootKeyPathB,
  samePermissionRegistry,
  trustA,
  trustB,
  trustOverlap,
  trustRevoked,
  window,
  generationA,
  generationB,
}) {
  const digestMismatch = structuredClone(registryA);
  digestMismatch.packages[0].artifactSha256 = '0'.repeat(64);
  digestMismatch.signature = signDocument(
    generationA.boundary,
    rootKeyPathA,
    canonicalRegistryPayload(digestMismatch),
  );
  const signatureMismatch = structuredClone(registryA);
  signatureMismatch.signature =
    mutateSignature(signatureMismatch.signature);
  const equivocation = structuredClone(registryB);
  equivocation.packages[0].envelopeSha256 = 'f'.repeat(64);
  equivocation.signature = signDocument(
    generationB.boundary,
    rootKeyPathB,
    canonicalRegistryPayload(equivocation),
  );
  const expiredWindow = {
    generatedAt: '2026-07-27T00:00:00.000Z',
    expiresAt: '2026-07-27T01:00:00.000Z',
  };
  const expiredTrust = signedTrust({
    boundary: generationA.boundary,
    keys: trustA.keys.map((key) => ({
      ...key,
      notBefore: expiredWindow.generatedAt,
      notAfter: expiredWindow.expiresAt,
    })),
    rootEvidence: rootA,
    rootKeyId: ROOT_KEY_IDS.a,
    rootKeyPath: rootKeyPathA,
    sequence: 1,
    window: expiredWindow,
    verify: false,
  });
  const expiredRegistry = signedRegistry({
    boundary: generationA.boundary,
    records: registryA.packages,
    revision: 1,
    rootEvidence: rootA,
    rootKeyId: ROOT_KEY_IDS.a,
    rootKeyPath: rootKeyPathA,
    trustSequence: 1,
    window: expiredWindow,
  });
  const documents = [
    ['digest_mismatch', 'registry', digestMismatch],
    ['signature_mismatch', 'registry', signatureMismatch],
    ['expired_metadata', 'trust', expiredTrust],
    ['registry_rollback', 'registry', registryA],
    ['same_revision_equivocation', 'registry', equivocation],
    ['invalid_or_expired_lkg', 'registry', expiredRegistry],
    ['same_permission_update', 'trust', trustOverlap],
    ['same_permission_update', 'registry', samePermissionRegistry],
    ['permission_expansion_rejected', 'trust', trustOverlap],
    ['permission_expansion_rejected', 'registry', expansionRegistry],
    ['permission_expansion_approved', 'trust', trustOverlap],
    ['permission_expansion_approved', 'registry', expansionRegistry],
    ['root_rotation', 'trust', trustB],
    ['root_rotation', 'registry', registryB],
    ['publisher_rotation', 'trust', trustOverlap],
    ['publisher_rotation', 'registry', samePermissionRegistry],
    ['publisher_revocation', 'trust', trustRevoked],
    ['publisher_revocation', 'registry', registryRevoked],
  ];
  if (
    rootB.publicKeySha256 === rootA.publicKeySha256
    || trustOverlap.sequence <= trustA.sequence
    || trustRevoked.sequence <= trustOverlap.sequence
    || trustB.sequence <= trustRevoked.sequence
    || registryRevoked.revision <= expansionRegistry.revision
    || registryB.revision <= registryRevoked.revision
    || Date.parse(window.expiresAt) <= Date.now()
  ) {
    throw new Error('P5 transition metadata is not monotonic');
  }
  return documents.map(([scenario, target, value]) =>
    metadataObject(`faults/${scenario}/${target}.json`, value));
}

function parseArguments(argv) {
  if (
    argv.length !== 2
    || argv[0] !== '--executor-commit'
    || !/^[0-9a-f]{40}$/u.test(argv[1] ?? '')
  ) {
    throw new Error(
      'usage: publish-release-chain.mjs --executor-commit <commit>',
    );
  }
  return { executorCommit: argv[1] };
}

async function publishReleaseChain(executorCommit) {
  await assertP5ExecutionAuthority(executorCommit);
  await assertExecutorBoundary(executorCommit);
  try {
    await lstat(OUTPUT_STATE_PATH);
    throw new Error('P5 publication state already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const [state, originState, credentials] = await Promise.all([
    readMode0600Json(
      RELEASE_STATE_PATH,
      'P5 Release Chain state',
      MAX_STATE_BYTES,
    ),
    readMode0600Json(ORIGIN_STATE_PATH, 'P5 origin state'),
    readCredentialFile(CREDENTIAL_PATH),
  ]);
  if (
    !/^am360-p5-e1-releases-[0-9a-f]{8}$/u.test(
      credentials.releasesBucket,
    )
  ) {
    throw new Error('P5 publication credentials escaped the namespace');
  }
  const generations = validateReleaseChainState(
    state,
    originState,
    executorCommit,
  );
  await Promise.all([
    assertRetainedGenerationBoundary(generations.a),
    assertRetainedGenerationBoundary(generations.b),
  ]);
  const rootKeyPaths = {
    a: path.join(generations.a.boundary, 'private/root-a.pk8'),
    b: path.join(generations.b.boundary, 'private/root-b.pk8'),
  };
  const publicationState = {
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    executionStatus: 'preparing',
    executorCommit,
    releaseExecutorCommit: state.executorCommit,
    releaseState: RELEASE_STATE_PATH,
    originState: ORIGIN_STATE_PATH,
    publisherKeyIds: [PUBLISHER_KEY_IDS.a, PUBLISHER_KEY_IDS.b],
    rootKeyIds: [ROOT_KEY_IDS.a, ROOT_KEY_IDS.b],
    rootPrivateKeyPaths: [rootKeyPaths.a, rootKeyPaths.b],
    objectReceipts: [],
    registryPublishedLast: false,
    cleanupRequired: true,
    startedAt: new Date().toISOString(),
  };
  await writeFile(
    OUTPUT_STATE_PATH,
    JSON.stringify(publicationState),
    { mode: 0o600, flag: 'wx' },
  );
  await chmod(OUTPUT_STATE_PATH, 0o600);

  const rootEvidence = {
    a: invokeSigner(generations.a.boundary, {
      action: 'generate',
      target: rootKeyPaths.a,
    }),
    b: invokeSigner(generations.b.boundary, {
      action: 'generate',
      target: rootKeyPaths.b,
    }),
  };
  if (
    rootEvidence.a.publicKeySha256 === rootEvidence.b.publicKeySha256
    || !/^sha256:[0-9a-f]{64}$/u.test(rootEvidence.a.publicKeySha256)
    || !/^sha256:[0-9a-f]{64}$/u.test(rootEvidence.b.publicKeySha256)
  ) {
    throw new Error('P5 Root generation is invalid');
  }
  publicationState.rootPublicEvidence = {
    a: rootEvidence.a,
    b: rootEvidence.b,
  };
  publicationState.temporaryRootPrivateKeyCount = 2;
  publicationState.executionStatus = 'roots_generated';
  await writeFile(OUTPUT_STATE_PATH, JSON.stringify(publicationState), {
    mode: 0o600,
  });

  const window = publicationWindow(originState);
  const [recordsA, recordsB] = await Promise.all([
    generationRecords(generations.a, state.releaseOrigin),
    generationRecords(generations.b, state.releaseOrigin),
  ]);
  if (recordsA.length !== 4 || recordsB.length !== 2) {
    throw new Error('P5 publication Registry record count drift');
  }
  const nonJobRecords = recordsA.filter(
    (record) => record.packageId !== 'com.agentmesh360.job-agent',
  );
  const samePermissionRecord = recordsB.find(
    (record) => record.version === '0.4.8-e1.1',
  );
  const expansionRecord = recordsB.find(
    (record) => record.version === '0.4.9-e1.1',
  );
  if (
    nonJobRecords.length !== 3
    || !samePermissionRecord
    || !expansionRecord
  ) {
    throw new Error('P5 Job transition records are incomplete');
  }
  const trustA = signedTrust({
    boundary: generations.a.boundary,
    keys: [publisherRecord({
      generation: 'a',
      publicKey: generations.a.publicEvidence.publicKeyBase64,
      status: 'active',
      window,
    })],
    rootEvidence: rootEvidence.a,
    rootKeyId: ROOT_KEY_IDS.a,
    rootKeyPath: rootKeyPaths.a,
    sequence: 1,
    window,
  });
  const trustB = signedTrust({
    boundary: generations.b.boundary,
    keys: [
      publisherRecord({
        generation: 'a',
        publicKey: generations.a.publicEvidence.publicKeyBase64,
        status: 'revoked',
        window,
      }),
      publisherRecord({
        generation: 'b',
        publicKey: generations.b.publicEvidence.publicKeyBase64,
        status: 'active',
        window,
      }),
    ],
    rootEvidence: rootEvidence.b,
    rootKeyId: ROOT_KEY_IDS.b,
    rootKeyPath: rootKeyPaths.b,
    sequence: 4,
    window,
  });
  const trustOverlap = signedTrust({
    boundary: generations.a.boundary,
    keys: [
      publisherRecord({
        generation: 'a',
        publicKey: generations.a.publicEvidence.publicKeyBase64,
        status: 'active',
        window,
      }),
      publisherRecord({
        generation: 'b',
        publicKey: generations.b.publicEvidence.publicKeyBase64,
        status: 'active',
        window,
      }),
    ],
    rootEvidence: rootEvidence.a,
    rootKeyId: ROOT_KEY_IDS.a,
    rootKeyPath: rootKeyPaths.a,
    sequence: 2,
    window,
  });
  const trustRevoked = signedTrust({
    boundary: generations.a.boundary,
    keys: [
      publisherRecord({
        generation: 'a',
        publicKey: generations.a.publicEvidence.publicKeyBase64,
        status: 'revoked',
        window,
      }),
      publisherRecord({
        generation: 'b',
        publicKey: generations.b.publicEvidence.publicKeyBase64,
        status: 'active',
        window,
      }),
    ],
    rootEvidence: rootEvidence.a,
    rootKeyId: ROOT_KEY_IDS.a,
    rootKeyPath: rootKeyPaths.a,
    sequence: 3,
    window,
  });
  const registryA = signedRegistry({
    boundary: generations.a.boundary,
    records: recordsA,
    revision: 1,
    rootEvidence: rootEvidence.a,
    rootKeyId: ROOT_KEY_IDS.a,
    rootKeyPath: rootKeyPaths.a,
    trustSequence: 1,
    window,
  });
  const samePermissionRegistry = signedRegistry({
    boundary: generations.a.boundary,
    records: [...nonJobRecords, samePermissionRecord],
    revision: 2,
    rootEvidence: rootEvidence.a,
    rootKeyId: ROOT_KEY_IDS.a,
    rootKeyPath: rootKeyPaths.a,
    trustSequence: 2,
    window,
  });
  const expansionRegistry = signedRegistry({
    boundary: generations.a.boundary,
    records: [...nonJobRecords, expansionRecord],
    revision: 3,
    rootEvidence: rootEvidence.a,
    rootKeyId: ROOT_KEY_IDS.a,
    rootKeyPath: rootKeyPaths.a,
    trustSequence: 2,
    window,
  });
  const registryRevoked = signedRegistry({
    boundary: generations.a.boundary,
    records: [...nonJobRecords, samePermissionRecord],
    revision: 4,
    rootEvidence: rootEvidence.a,
    rootKeyId: ROOT_KEY_IDS.a,
    rootKeyPath: rootKeyPaths.a,
    trustSequence: 3,
    window,
  });
  const registryB = signedRegistry({
    boundary: generations.b.boundary,
    records: [...nonJobRecords, samePermissionRecord],
    revision: 5,
    rootEvidence: rootEvidence.b,
    rootKeyId: ROOT_KEY_IDS.b,
    rootKeyPath: rootKeyPaths.b,
    trustSequence: 4,
    window,
  });
  const releaseObjectLists = await Promise.all([
    releaseObjects(
      { ...generations.a, releaseOrigin: state.releaseOrigin },
      recordsA,
    ),
    releaseObjects(
      { ...generations.b, releaseOrigin: state.releaseOrigin },
      recordsB,
    ),
  ]);
  const releaseObjectKeys = releaseObjectLists.flat().map(
    (value) => value.objectKey,
  );
  if (new Set(releaseObjectKeys).size !== releaseObjectKeys.length) {
    throw new Error('P5 immutable Release object keys collide');
  }
  const transitionObjects = transitionDocuments({
    expansionRegistry,
    registryA,
    registryB,
    registryRevoked,
    rootA: rootEvidence.a,
    rootB: rootEvidence.b,
    rootKeyPathA: rootKeyPaths.a,
    rootKeyPathB: rootKeyPaths.b,
    samePermissionRegistry,
    trustA,
    trustB,
    trustOverlap,
    trustRevoked,
    window,
    generationA: generations.a,
    generationB: generations.b,
  });
  const uploads = [
    {
      bucket: credentials.metadataBucket,
      object: metadataObject('metadata/trust-bundle.v1.json', trustA),
    },
    ...releaseObjectLists.flat().map((object) => ({
      bucket: credentials.releasesBucket,
      object,
    })),
    ...transitionObjects.map((object) => ({
      bucket: credentials.metadataBucket,
      object,
    })),
    {
      bucket: credentials.metadataBucket,
      object: metadataObject('metadata/registry.v2.json', registryA),
    },
  ];
  const plannedKeys = uploads.map(({ object }) => object.objectKey);
  if (
    new Set(plannedKeys).size !== plannedKeys.length
    || plannedKeys.at(-1) !== 'metadata/registry.v2.json'
  ) {
    throw new Error('P5 publication plan is not unique Registry-last');
  }
  publicationState.executionStatus = 'publishing';
  publicationState.trustSequences = [1, 2, 3, 4];
  publicationState.registryRevisions = [1, 2, 3, 4, 5];
  publicationState.plannedObjects = uploads.map(({ bucket, object }) => ({
    bucketClass:
      bucket === credentials.releasesBucket ? 'release' : 'metadata',
    objectKey: object.objectKey,
    sha256: object.digest,
  }));
  await writeFile(OUTPUT_STATE_PATH, JSON.stringify(publicationState), {
    mode: 0o600,
  });
  for (const upload of uploads) {
    publicationState.objectReceipts.push(await putNewObject(
      credentials,
      upload.bucket,
      upload.object,
    ));
    publicationState.lastUpdatedAt = new Date().toISOString();
    await writeFile(OUTPUT_STATE_PATH, JSON.stringify(publicationState), {
      mode: 0o600,
    });
  }
  publicationState.executionStatus = 'published';
  publicationState.registryPublishedLast =
    publicationState.objectReceipts.at(-1)?.objectKey
      === 'metadata/registry.v2.json';
  publicationState.publishedAt = new Date().toISOString();
  await writeFile(OUTPUT_STATE_PATH, JSON.stringify(publicationState), {
    mode: 0o600,
  });
  return publicationState;
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
    publishReleaseChain(options.executorCommit)
      .then((state) => {
        if (!state.registryPublishedLast) {
          throw new Error('P5 Registry was not published last');
        }
        process.stdout.write(
          'P5 E1 two-generation Release Chain published Registry-last\n',
        );
      })
      .catch(() => {
        process.stderr.write('P5 E1 publication failed\n');
        process.exitCode = 1;
      });
  }
}

export {
  ORIGIN_STATE_PATH,
  OUTPUT_STATE_PATH,
  RELEASE_STATE_PATH,
  ROOT_KEY_IDS,
  assertRetainedGenerationBoundary,
  assertUniquePackages,
  metadataObject,
  parseArguments,
  publisherRecord,
  signedRegistry,
  signedTrust,
  validateReleaseChainState,
};
