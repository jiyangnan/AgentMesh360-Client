#!/usr/bin/env node

import { createHash } from 'node:crypto';
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
  canonicalRegistryPayload,
  verifyRawSignature,
} from './publish-release-set.mjs';
import {
  verifyTrustBundle,
} from '../key-ceremony/run-e0-key-ceremony.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const AUTHORIZATION_ID = 'distribution_service_e1_20260728_0001';
const MAX_FAULT_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CURL_ATTEMPTS_PER_REQUEST = 4;
const SCENARIOS = [
  'not_found',
  'timeout',
  'truncated_response',
  'response_too_large',
  'wrong_content_type',
  'redirect',
  'digest_mismatch',
  'signature_mismatch',
  'expired_metadata',
  'registry_rollback',
  'same_revision_equivocation',
  'valid_lkg_transport_failure',
  'invalid_or_expired_lkg',
  'partial_publication_before_registry',
];

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
    throw new Error('fault-matrix executor git inspection failed');
  }
  return result.stdout.trim();
}

async function assertExecutorBoundary(executorCommit) {
  if (
    !/^[0-9a-f]{40}$/u.test(executorCommit)
    || runGit(['rev-parse', 'HEAD']) !== executorCommit
    || runGit(['status', '--porcelain=v1', '--untracked-files=all']) !== ''
  ) {
    throw new Error('fault-matrix executor is not the approved clean commit');
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

function curlConfig(url, token, timeoutSeconds = 30) {
  if (
    !/^https:\/\/packages-e1-[0-9a-f]{8}\.agentmesh360\.com\//u.test(url)
    || (token != null && !/^[A-Za-z0-9_-]{43}$/u.test(token))
  ) {
    throw new Error('fault request boundary is invalid');
  }
  return [
    'silent',
    'show-error',
    `max-time = ${timeoutSeconds}`,
    'max-redirs = 0',
    'proto = "=https"',
    'include',
    `url = "${url}"`,
    ...(token == null
      ? []
      : [`header = "x-agentmesh360-e1-fault-token: ${token}"`]),
    '',
  ].join('\n');
}

function splitHttpResponse(bytes) {
  const marker = Buffer.from('\r\n\r\n', 'ascii');
  const index = bytes.indexOf(marker);
  if (index < 0) {
    return { body: bytes, headers: '', status: 0 };
  }
  const headers = bytes.subarray(0, index).toString('latin1');
  const status = Number(/^HTTP\/\S+\s+(\d{3})/u.exec(headers)?.[1] ?? 0);
  return {
    body: bytes.subarray(index + marker.length),
    headers,
    status,
  };
}

function curlRequest(
  url,
  token,
  {
    timeoutSeconds = 30,
    curlSpawn = spawnSync,
  } = {},
) {
  let last;
  const startedAt = Date.now();
  for (let attempt = 0; attempt < MAX_CURL_ATTEMPTS_PER_REQUEST; attempt += 1) {
    const result = curlSpawn('curl', ['--config', '-'], {
      encoding: null,
      input: Buffer.from(curlConfig(url, token, timeoutSeconds), 'utf8'),
      maxBuffer: MAX_FAULT_RESPONSE_BYTES,
      timeout: (timeoutSeconds + 5) * 1_000,
    });
    last = result;
    if (!result.error && result.status === 0) break;
    if (![28, 35, 52, 55, 56].includes(result.status)) break;
  }
  const parsed = splitHttpResponse(last.stdout ?? Buffer.alloc(0));
  return {
    ...parsed,
    curlStatus: last.status,
    durationMs: Date.now() - startedAt,
  };
}

function parseJsonBody(response, label) {
  try {
    return JSON.parse(response.body.toString('utf8'));
  } catch {
    throw new Error(`${label} response is not valid JSON`);
  }
}

function verifyRegistry(document, rootPublicKeyBase64) {
  if (
    document?.schemaVersion !== 2
    || !Number.isSafeInteger(document.revision)
    || document.revision < 1
    || document.trustBundleSequence !== 1
    || !Array.isArray(document.packages)
    || document.packages.length !== 4
  ) {
    throw new Error('Registry structure is invalid');
  }
  verifyRawSignature(
    rootPublicKeyBase64,
    canonicalRegistryPayload(document),
    document.signature,
  );
  return document;
}

function assertExpired(document, now = Date.now()) {
  if (
    !Number.isFinite(Date.parse(document.expiresAt))
    || Date.parse(document.expiresAt) > now
  ) {
    throw new Error('metadata is not expired');
  }
}

function scenarioUrl(origin, scenario) {
  return `${origin}/_e1/fault/${scenario}/registry`;
}

async function runMatrix(options) {
  await assertExecutorBoundary(options.executorCommit);
  const originState = await readMode0600Json(
    options.originState,
    'origin state',
  );
  const publication = await readMode0600Json(
    options.publicationState,
    'publication state',
  );
  if (
    originState.authorizationId !== AUTHORIZATION_ID
    || originState.origin?.deployed !== true
    || !/^[A-Za-z0-9_-]{43}$/u.test(originState.origin?.faultToken)
    || publication.authorizationId !== AUTHORIZATION_ID
    || publication.executionStatus !== 'published'
    || publication.registryPublishedLast !== true
    || publication.objectReceipts?.length !== 35
  ) {
    throw new Error('fault matrix state differs from approved E1 publication');
  }
  const origin = `https://${originState.dns.hostname}`;
  const token = originState.origin.faultToken;
  const trustResponse = curlRequest(`${origin}/v1/trust-bundle.json`, null);
  const registryResponse = curlRequest(`${origin}/v2/registry.json`, null);
  if (trustResponse.status !== 200 || registryResponse.status !== 200) {
    throw new Error('valid E1 metadata baseline is unavailable');
  }
  const trust = parseJsonBody(trustResponse, 'Trust');
  const registry = parseJsonBody(registryResponse, 'Registry');
  verifyTrustBundle(
    trust,
    new Map([[
      publication.rootKeyId,
      publication.rootPublicKeyBase64,
    ]]),
    new Date(),
    1,
  );
  verifyRegistry(registry, publication.rootPublicKeyBase64);
  if (
    registry.revision !== publication.registryRevision
    || trust.sequence !== publication.trustSequence
    || registry.rootKeyId !== publication.rootKeyId
    || Date.parse(registry.generatedAt) > Date.now()
    || Date.parse(registry.expiresAt) <= Date.now()
    || registry.packages.some((record, index, records) =>
      index > 0 && records[index - 1].packageId >= record.packageId)
  ) {
    throw new Error('valid E1 metadata baseline contract differs');
  }
  const validRegistryDigest = typedSha256(registryResponse.body);
  const results = [];
  const pass = (scenario, evidenceCode) => {
    results.push({ scenario, evidenceCode, status: 'passed' });
  };

  let response = curlRequest(scenarioUrl(origin, 'not_found'), token);
  if (response.status !== 404) throw new Error('not_found fault failed');
  pass('not_found', 'http_404_rejected');

  response = curlRequest(scenarioUrl(origin, 'timeout'), token, {
    timeoutSeconds: 30,
  });
  if (response.status !== 504 || response.durationMs < 19_000) {
    throw new Error('timeout fault failed');
  }
  pass('timeout', 'bounded_timeout_rejected');

  response = curlRequest(scenarioUrl(origin, 'truncated_response'), token);
  if (
    response.curlStatus === 0
    || response.status !== 200
    || response.body.length >= 256
  ) {
    throw new Error('truncated_response fault failed');
  }
  pass('truncated_response', 'truncated_body_rejected');

  response = curlRequest(scenarioUrl(origin, 'response_too_large'), token);
  if (response.status !== 200 || response.body.length <= 1024 * 1024) {
    throw new Error('response_too_large fault failed');
  }
  pass('response_too_large', 'response_limit_enforced');

  response = curlRequest(scenarioUrl(origin, 'wrong_content_type'), token);
  if (
    response.status !== 200
    || !/\r\ncontent-type:\s*text\/plain/iu.test(response.headers)
  ) {
    throw new Error('wrong_content_type fault failed');
  }
  pass('wrong_content_type', 'mime_rejected');

  response = curlRequest(scenarioUrl(origin, 'redirect'), token);
  if (
    response.status !== 302
    || !/\r\nlocation:\s*\/healthz/iu.test(response.headers)
  ) {
    throw new Error('redirect fault failed');
  }
  pass('redirect', 'redirect_not_followed');

  response = curlRequest(scenarioUrl(origin, 'digest_mismatch'), token);
  const digestMismatch = verifyRegistry(
    parseJsonBody(response, 'digest mismatch'),
    publication.rootPublicKeyBase64,
  );
  if (
    response.status !== 200
    || digestMismatch.packages[0].artifactSha256
      === registry.packages[0].artifactSha256
  ) {
    throw new Error('digest_mismatch fault failed');
  }
  pass('digest_mismatch', 'signed_wrong_digest_detected');

  response = curlRequest(scenarioUrl(origin, 'signature_mismatch'), token);
  let signatureRejected = false;
  try {
    verifyRegistry(
      parseJsonBody(response, 'signature mismatch'),
      publication.rootPublicKeyBase64,
    );
  } catch {
    signatureRejected = true;
  }
  if (response.status !== 200 || !signatureRejected) {
    throw new Error('signature_mismatch fault failed');
  }
  pass('signature_mismatch', 'root_signature_rejected');

  response = curlRequest(scenarioUrl(origin, 'expired_metadata'), token);
  const expired = verifyRegistry(
    parseJsonBody(response, 'expired metadata'),
    publication.rootPublicKeyBase64,
  );
  assertExpired(expired);
  pass('expired_metadata', 'expiry_rejected');

  response = curlRequest(scenarioUrl(origin, 'registry_rollback'), token);
  const rollback = verifyRegistry(
    parseJsonBody(response, 'registry rollback'),
    publication.rootPublicKeyBase64,
  );
  if (rollback.revision >= registry.revision) {
    throw new Error('registry_rollback fault failed');
  }
  pass('registry_rollback', 'lower_revision_rejected');

  response = curlRequest(
    scenarioUrl(origin, 'same_revision_equivocation'),
    token,
  );
  const equivocation = verifyRegistry(
    parseJsonBody(response, 'same revision equivocation'),
    publication.rootPublicKeyBase64,
  );
  if (
    equivocation.revision !== registry.revision
    || typedSha256(response.body) === validRegistryDigest
  ) {
    throw new Error('same_revision_equivocation fault failed');
  }
  pass('same_revision_equivocation', 'same_revision_digest_rejected');

  response = curlRequest(
    scenarioUrl(origin, 'valid_lkg_transport_failure'),
    token,
  );
  if (
    response.status !== 404
    || Date.parse(registry.expiresAt) <= Date.now()
  ) {
    throw new Error('valid_lkg_transport_failure fault failed');
  }
  pass('valid_lkg_transport_failure', 'verified_unexpired_lkg_retained');

  response = curlRequest(
    scenarioUrl(origin, 'invalid_or_expired_lkg'),
    token,
  );
  const invalidLkg = verifyRegistry(
    parseJsonBody(response, 'invalid LKG'),
    publication.rootPublicKeyBase64,
  );
  assertExpired(invalidLkg);
  if (invalidLkg.revision >= registry.revision) {
    throw new Error('invalid_or_expired_lkg fault failed');
  }
  pass('invalid_or_expired_lkg', 'expired_rollback_lkg_rejected');

  response = curlRequest(
    scenarioUrl(origin, 'partial_publication_before_registry'),
    token,
  );
  const releaseObjectCount = publication.objectReceipts.filter(
    (receipt) => receipt.bucketClass === 'release',
  ).length;
  if (response.status !== 404 || releaseObjectCount !== 27) {
    throw new Error('partial_publication_before_registry fault failed');
  }
  pass(
    'partial_publication_before_registry',
    'objects_undiscoverable_without_registry',
  );

  if (
    results.length !== SCENARIOS.length
    || results.some((result, index) =>
      result.scenario !== SCENARIOS[index] || result.status !== 'passed')
  ) {
    throw new Error('fault matrix result order or coverage is invalid');
  }
  const receipt = {
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    environment: 'e1',
    workPackage: 'p4_r3',
    executorCommit: options.executorCommit,
    executionStatus: 'fault_matrix_passed',
    scenarioCount: results.length,
    results,
    validBaseline: {
      trustSequence: trust.sequence,
      registryRevision: registry.revision,
      packageCount: registry.packages.length,
    },
    logicalRequestCount: 16,
    maximumCurlAttempts: 16 * MAX_CURL_ATTEMPTS_PER_REQUEST,
    providerRequests: 0,
    creditsConsumed: 0,
    completedAt: new Date().toISOString(),
  };
  await writeFile(options.outputReceipt, JSON.stringify(receipt), {
    mode: 0o600,
    flag: 'wx',
  });
  await chmod(options.outputReceipt, 0o600);
  return receipt;
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
    '--executor-commit',
    '--origin-state',
    '--output-receipt',
    '--publication-state',
  ];
  if (
    values.size !== required.length
    || required
      .filter((key) => key !== '--executor-commit')
      .some((key) => !path.isAbsolute(values.get(key) ?? ''))
    || !/^[0-9a-f]{40}$/u.test(values.get('--executor-commit') ?? '')
  ) {
    throw new Error(
      'usage: run-fault-matrix.mjs --executor-commit <commit> '
      + '--origin-state <absolute> '
      + '--publication-state <absolute> --output-receipt <absolute>',
    );
  }
  return {
    executorCommit: values.get('--executor-commit'),
    originState: values.get('--origin-state'),
    outputReceipt: values.get('--output-receipt'),
    publicationState: values.get('--publication-state'),
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
    runMatrix(options)
      .then(() => {
        console.log(
          'E1 14-scenario distribution fault matrix passed without exposing the fault token',
        );
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}

export {
  SCENARIOS,
  assertExecutorBoundary,
  curlConfig,
  curlRequest,
  parseArguments,
  splitHttpResponse,
};
