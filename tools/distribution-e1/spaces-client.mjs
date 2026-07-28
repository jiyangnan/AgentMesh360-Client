#!/usr/bin/env node

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const EXPECTED_REGION = 'sgp1';
const EXPECTED_ENDPOINT = 'sgp1.digitaloceanspaces.com';
const KEY_ID_PATTERN = /^[A-Z0-9]{20}$/u;
const SECRET_PATTERN = /^[A-Za-z0-9/+]{40,50}$/u;
const BUCKET_PATTERN =
  /^am360-e1-(releases|metadata)-([0-9a-f]{8})$/u;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value).digest(encoding);
}

function awsEncode(value) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/gu, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function canonicalObjectPath(objectKey) {
  if (typeof objectKey !== 'string' || objectKey.length === 0) {
    throw new Error('Spaces object key is invalid');
  }
  if (
    objectKey.startsWith('/')
    || objectKey.endsWith('/')
    || objectKey.includes('\\')
    || objectKey.split('/').some((segment) =>
      segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('Spaces object key is not canonical');
  }
  return `/${objectKey.split('/').map(awsEncode).join('/')}`;
}

export function canonicalQuery(parameters = {}) {
  return Object.entries(parameters)
    .flatMap(([key, rawValue]) => {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      return values.map((value) => [awsEncode(key), awsEncode(String(value))]);
    })
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      Buffer.from(leftKey).compare(Buffer.from(rightKey))
      || Buffer.from(leftValue).compare(Buffer.from(rightValue)))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function amzTimestamp(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/gu, '');
}

function signingKey(secretAccessKey, dateStamp, region) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  return hmac(serviceKey, 'aws4_request');
}

export function createSignedSpacesRequest({
  method,
  endpoint,
  region,
  bucket,
  objectKey,
  query = {},
  accessKeyId,
  secretAccessKey,
  body = Buffer.alloc(0),
  contentType,
  now = new Date(),
}) {
  if (!['DELETE', 'GET', 'HEAD', 'PUT'].includes(method)) {
    throw new Error('Spaces method is not allowed');
  }
  if (
    endpoint !== EXPECTED_ENDPOINT
    || region !== EXPECTED_REGION
    || !BUCKET_PATTERN.test(bucket)
    || !KEY_ID_PATTERN.test(accessKeyId)
    || !SECRET_PATTERN.test(secretAccessKey)
    || !(body instanceof Uint8Array)
    || body.byteLength > MAX_OBJECT_BYTES
  ) {
    throw new Error('Spaces request boundary is invalid');
  }
  const host = `${bucket}.${endpoint}`;
  const canonicalUri = objectKey == null ? '/' : canonicalObjectPath(objectKey);
  const queryString = canonicalQuery(query);
  const payloadHash = sha256Hex(body);
  const timestamp = amzTimestamp(now);
  const dateStamp = timestamp.slice(0, 8);
  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': timestamp,
  };
  if (contentType) headers['content-type'] = contentType;
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${String(headers[name]).trim()}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    method,
    canonicalUri,
    queryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    credentialScope,
    sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
  ].join('\n');
  const signature = hmac(
    signingKey(secretAccessKey, dateStamp, region),
    stringToSign,
    'hex',
  );
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, `
    + `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `https://${host}${canonicalUri}${
    queryString ? `?${queryString}` : ''
  }`;
  return {
    url,
    method,
    headers,
    body: method === 'PUT' ? body : undefined,
    evidence: {
      canonicalRequestSha256:
        `sha256:${sha256Hex(Buffer.from(canonicalRequest, 'utf8'))}`,
      payloadSha256: `sha256:${payloadHash}`,
      signedHeaderNames,
    },
  };
}

async function readCredentialFile(filePath) {
  const stat = await lstat(filePath);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size <= 0
    || stat.size > MAX_CREDENTIAL_BYTES
    || (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      'Spaces credential file must be a bounded mode-0600 regular file',
    );
  }
  let document;
  try {
    document = UTF8_DECODER.decode(await readFile(filePath));
  } catch {
    throw new Error('Spaces credential file is not valid UTF-8');
  }
  let value;
  try {
    value = JSON.parse(document);
  } catch {
    throw new Error('Spaces credential file is not valid JSON');
  }
  const expectedKeys = [
    'endpoint',
    'metadataBucket',
    'originReader',
    'publisher',
    'region',
    'releasesBucket',
  ];
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join('\n') !== expectedKeys.join('\n')
    || value.region !== EXPECTED_REGION
    || value.endpoint !== EXPECTED_ENDPOINT
  ) {
    throw new Error('Spaces credential file has an invalid boundary');
  }
  const releasesMatch = BUCKET_PATTERN.exec(value.releasesBucket);
  const metadataMatch = BUCKET_PATTERN.exec(value.metadataBucket);
  if (
    releasesMatch?.[1] !== 'releases'
    || metadataMatch?.[1] !== 'metadata'
    || releasesMatch[2] !== metadataMatch[2]
  ) {
    throw new Error('Spaces bucket binding is invalid');
  }
  for (const [name, principal] of [
    ['publisher', value.publisher],
    ['originReader', value.originReader],
  ]) {
    const principalKeys = [
      'accessKeyId',
      'keyName',
      'secretAccessKey',
    ];
    if (
      !principal
      || typeof principal !== 'object'
      || Array.isArray(principal)
      || Object.keys(principal).sort().join('\n')
        !== principalKeys.join('\n')
      || !KEY_ID_PATTERN.test(principal.accessKeyId)
      || !SECRET_PATTERN.test(principal.secretAccessKey)
      || principal.keyName
        !== `am360-p4-e1-${name === 'publisher' ? 'publisher' : 'origin'}-${
          releasesMatch[2]
        }`
    ) {
      throw new Error('Spaces principal binding is invalid');
    }
  }
  if (value.publisher.accessKeyId === value.originReader.accessKeyId) {
    throw new Error('Spaces principals must use distinct access keys');
  }
  return value;
}

function principalCredentials(credentials, principal) {
  if (principal === 'publisher') return credentials.publisher;
  if (principal === 'origin-reader') return credentials.originReader;
  throw new Error('Spaces principal is invalid');
}

export async function requestSpaces({
  credentials,
  principal,
  bucket,
  method,
  objectKey,
  query,
  body = Buffer.alloc(0),
  contentType,
  expectedStatuses,
  fetchImpl = fetch,
}) {
  const key = principalCredentials(credentials, principal);
  const request = createSignedSpacesRequest({
    method,
    endpoint: credentials.endpoint,
    region: credentials.region,
    bucket,
    objectKey,
    query,
    accessKeyId: key.accessKeyId,
    secretAccessKey: key.secretAccessKey,
    body,
    contentType,
  });
  const response = await fetchImpl(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (!expectedStatuses.includes(response.status)) {
    const responseText = (await response.text()).slice(0, 4096);
    const code = /<Code>([A-Za-z0-9]+)<\/Code>/u.exec(responseText)?.[1];
    throw new Error(
      `Spaces request returned unexpected status ${response.status}${
        code ? ` (${code})` : ''
      }`,
    );
  }
  return { response, evidence: request.evidence };
}

async function runAccessProbe(credentials, fetchImpl = fetch) {
  const objectKey =
    `probes/access-${randomBytes(8).toString('hex')}.bin`;
  const body = randomBytes(32);
  try {
    try {
      await requestSpaces({
        credentials,
        principal: 'publisher',
        bucket: credentials.metadataBucket,
        method: 'PUT',
        objectKey,
        body,
        contentType: 'application/octet-stream',
        expectedStatuses: [200],
        fetchImpl,
      });
    } catch (error) {
      throw new Error(
        `Spaces publisher write probe failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    try {
      const publisherRead = await requestSpaces({
        credentials,
        principal: 'publisher',
        bucket: credentials.metadataBucket,
        method: 'GET',
        objectKey,
        expectedStatuses: [200],
        fetchImpl,
      });
      const publisherReturned =
        Buffer.from(await publisherRead.response.arrayBuffer());
      if (!publisherReturned.equals(body)) {
        throw new Error('read-after-write digest mismatch');
      }
    } catch (error) {
      throw new Error(
        `Spaces publisher read probe failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    let read;
    try {
      read = await requestSpaces({
        credentials,
        principal: 'origin-reader',
        bucket: credentials.metadataBucket,
        method: 'GET',
        objectKey,
        expectedStatuses: [200],
        fetchImpl,
      });
    } catch (error) {
      throw new Error(
        `Spaces origin-reader read probe failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const returned = Buffer.from(await read.response.arrayBuffer());
    if (!returned.equals(body)) {
      throw new Error('Spaces read-after-write probe digest mismatch');
    }
    let denied;
    try {
      denied = await requestSpaces({
        credentials,
        principal: 'origin-reader',
        bucket: credentials.metadataBucket,
        method: 'PUT',
        objectKey: `${objectKey}.denied`,
        body,
        contentType: 'application/octet-stream',
        expectedStatuses: [403],
        fetchImpl,
      });
    } catch (error) {
      throw new Error(
        `Spaces origin-reader deny-write probe failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await denied.response.body?.cancel();
  } finally {
    body.fill(0);
    let cleanupFailed = false;
    for (const cleanupObjectKey of [objectKey, `${objectKey}.denied`]) {
      try {
        await requestSpaces({
          credentials,
          principal: 'publisher',
          bucket: credentials.metadataBucket,
          method: 'DELETE',
          objectKey: cleanupObjectKey,
          expectedStatuses: [204],
          fetchImpl,
        });
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      throw new Error('Spaces access probe cleanup failed');
    }
  }
}

function parseArguments(argv) {
  if (
    argv.length !== 3
    || argv[0] !== 'probe'
    || argv[1] !== '--credentials'
  ) {
    throw new Error(
      'usage: node spaces-client.mjs probe --credentials <mode-0600.json>',
    );
  }
  return path.resolve(argv[2]);
}

function isMainModule() {
  return process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  let credentialPath;
  try {
    credentialPath = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
  if (credentialPath) {
    readCredentialFile(credentialPath)
      .then(runAccessProbe)
      .then(() => {
        console.log(
          'Spaces least-privilege access probe passed; probe object removed',
        );
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}

export {
  EXPECTED_ENDPOINT,
  EXPECTED_REGION,
  readCredentialFile,
  runAccessProbe,
};
