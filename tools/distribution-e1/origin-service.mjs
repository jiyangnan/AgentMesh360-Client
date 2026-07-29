#!/usr/bin/env node

import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { requestSpaces } from './spaces-client.mjs';

const MAX_CONFIG_BYTES = 32 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const LISTEN_HOST = '127.0.0.1';
const LISTEN_PORT = 8791;
const FAULT_SCENARIOS = new Set([
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
  'same_permission_update',
  'permission_expansion_rejected',
  'permission_expansion_approved',
  'root_rotation',
  'publisher_rotation',
  'publisher_revocation',
  'registry_withdrawal',
]);
const CONTENT_TYPES = new Set([
  'application/json',
  'application/octet-stream',
  'application/vnd.agentmesh.package',
  'application/zstd',
  'application/x-zstd',
]);

function safeEqual(left, right) {
  const leftBytes = Buffer.from(left ?? '', 'utf8');
  const rightBytes = Buffer.from(right ?? '', 'utf8');
  return (
    leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes)
  );
}

function strictConfig(value) {
  const keys = [
    'endpoint',
    'faultToken',
    'metadataBucket',
    'originReader',
    'region',
    'releasesBucket',
    'schemaVersion',
  ];
  const principalKeys = ['accessKeyId', 'keyName', 'secretAccessKey'];
  const metadataMatch =
    /^am360-(e1|p5-e1)-metadata-([0-9a-f]{8})$/u.exec(
      value?.metadataBucket,
    );
  const releasesMatch =
    /^am360-(e1|p5-e1)-releases-([0-9a-f]{8})$/u.exec(
      value?.releasesBucket,
    );
  const originMatch =
    /^am360-(p4-e1|p5-e1)-origin-([0-9a-f]{8})$/u.exec(
      value?.originReader?.keyName,
    );
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join('\n') !== keys.join('\n')
    || value.schemaVersion !== 1
    || value.region !== 'sgp1'
    || value.endpoint !== 'sgp1.digitaloceanspaces.com'
    || !metadataMatch
    || !releasesMatch
    || !/^[A-Za-z0-9_-]{43}$/u.test(value.faultToken)
    || !value.originReader
    || typeof value.originReader !== 'object'
    || Array.isArray(value.originReader)
    || Object.keys(value.originReader).sort().join('\n')
      !== principalKeys.join('\n')
    || !/^[A-Z0-9]{20}$/u.test(value.originReader.accessKeyId)
    || !/^[A-Za-z0-9/+]{40,50}$/u.test(
      value.originReader.secretAccessKey,
    )
    || !originMatch
  ) {
    throw new Error('origin configuration boundary is invalid');
  }
  if (
    metadataMatch[1] !== releasesMatch[1]
    || metadataMatch[2] !== releasesMatch[2]
    || metadataMatch[2] !== originMatch[2]
    || (
      metadataMatch[1] === 'e1'
        ? originMatch[1] !== 'p4-e1'
        : originMatch[1] !== 'p5-e1'
    )
  ) {
    throw new Error('origin configuration resources are not bound');
  }
  return value;
}

export async function readOriginConfig(filePath) {
  const stat = await lstat(filePath);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size <= 0
    || stat.size > MAX_CONFIG_BYTES
    || (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      'origin configuration must be a bounded mode-0600 regular file',
    );
  }
  let value;
  try {
    value = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new Error('origin configuration is not valid JSON');
  }
  return strictConfig(value);
}

function routeFor(pathname) {
  if (pathname === '/healthz') {
    return { routeClass: 'health', kind: 'health' };
  }
  if (pathname === '/v1/trust-bundle.json') {
    return {
      routeClass: 'trust',
      kind: 'metadata',
      objectKey: 'metadata/trust-bundle.v1.json',
      maximumBytes: 64 * 1024,
    };
  }
  if (pathname === '/v2/registry.json') {
    return {
      routeClass: 'registry',
      kind: 'metadata',
      objectKey: 'metadata/registry.v2.json',
      maximumBytes: MAX_METADATA_BYTES,
    };
  }
  if (pathname.startsWith('/objects/')) {
    const objectKey = pathname.slice('/objects/'.length);
    if (
      !objectKey
      || objectKey.startsWith('/')
      || objectKey.includes('\\')
      || objectKey.split('/').some((part) =>
        part === '' || part === '.' || part === '..')
    ) {
      return null;
    }
    return {
      routeClass: 'immutable_object',
      kind: 'release',
      objectKey,
      maximumBytes: MAX_ARTIFACT_BYTES,
    };
  }
  const faultMatch =
    /^\/_e1\/fault\/([a-z_]+)\/(trust|registry)$/u.exec(pathname);
  if (faultMatch && FAULT_SCENARIOS.has(faultMatch[1])) {
    return {
      routeClass: 'fault',
      kind: 'fault',
      scenario: faultMatch[1],
      target: faultMatch[2],
    };
  }
  return null;
}

function writeResponse(response, status, headers, body = Buffer.alloc(0)) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(body);
}

function reviewedContentType(value) {
  const contentType = (value ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!CONTENT_TYPES.has(contentType)) {
    throw new Error('Spaces object content type is not allowed');
  }
  return contentType;
}

async function fetchObject(config, route, spacesRequest) {
  const bucket = route.kind === 'release'
    ? config.releasesBucket
    : config.metadataBucket;
  const result = await spacesRequest({
    credentials: {
      region: config.region,
      endpoint: config.endpoint,
      releasesBucket: config.releasesBucket,
      metadataBucket: config.metadataBucket,
      publisher: config.originReader,
      originReader: config.originReader,
    },
    principal: 'origin-reader',
    bucket,
    method: 'GET',
    objectKey: route.objectKey,
    expectedStatuses: [200, 404],
  });
  if (result.response.status === 404) {
    await result.response.body?.cancel();
    return { status: 404 };
  }
  const declaredLength =
    Number(result.response.headers.get('content-length') ?? '0');
  if (
    !Number.isSafeInteger(declaredLength)
    || declaredLength < 0
    || declaredLength > route.maximumBytes
  ) {
    await result.response.body?.cancel();
    throw new Error('Spaces object declared length exceeds route limit');
  }
  const bytes = Buffer.from(await result.response.arrayBuffer());
  if (bytes.length > route.maximumBytes) {
    throw new Error('Spaces object exceeds route limit');
  }
  return {
    status: 200,
    body: bytes,
    contentType: reviewedContentType(
      result.response.headers.get('content-type'),
    ),
  };
}

function faultObjectKey(scenario, target) {
  return `faults/${scenario}/${target}.json`;
}

async function serveFault(
  request,
  response,
  config,
  route,
  spacesRequest,
  timeoutMilliseconds,
) {
  if (
    !safeEqual(
      request.headers['x-agentmesh360-e1-fault-token'],
      config.faultToken,
    )
  ) {
    writeResponse(response, 404, { 'content-type': 'application/json' });
    return 404;
  }
  if (
    route.scenario === 'not_found'
    || route.scenario === 'valid_lkg_transport_failure'
    || route.scenario === 'partial_publication_before_registry'
    || route.scenario === 'registry_withdrawal'
  ) {
    writeResponse(response, 404, { 'content-type': 'application/json' });
    return 404;
  }
  if (route.scenario === 'timeout') {
    await new Promise((resolve) => setTimeout(resolve, timeoutMilliseconds));
    writeResponse(response, 504, { 'content-type': 'application/json' });
    return 504;
  }
  if (route.scenario === 'truncated_response') {
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': '256',
      'cache-control': 'no-store',
    });
    response.end(Buffer.from('{"schemaVersion":', 'utf8'));
    return 200;
  }
  if (route.scenario === 'response_too_large') {
    const bytes = Buffer.alloc(MAX_METADATA_BYTES + 1, 0x20);
    writeResponse(
      response,
      200,
      { 'content-type': 'application/json' },
      bytes,
    );
    return 200;
  }
  if (route.scenario === 'wrong_content_type') {
    writeResponse(
      response,
      200,
      { 'content-type': 'text/plain' },
      Buffer.from('{}', 'utf8'),
    );
    return 200;
  }
  if (route.scenario === 'redirect') {
    writeResponse(response, 302, {
      location: '/healthz',
      'content-type': 'application/json',
    });
    return 302;
  }
  const objectRoute = {
    kind: 'metadata',
    objectKey: faultObjectKey(route.scenario, route.target),
    maximumBytes: MAX_METADATA_BYTES,
  };
  const result = await fetchObject(config, objectRoute, spacesRequest);
  if (result.status === 404) {
    writeResponse(response, 404, { 'content-type': 'application/json' });
    return 404;
  }
  writeResponse(
    response,
    200,
    { 'content-type': result.contentType },
    result.body,
  );
  return 200;
}

export function createOriginServer({
  config,
  spacesRequest = requestSpaces,
  logger = () => {},
  timeoutMilliseconds = 20_000,
}) {
  strictConfig(config);
  return createServer(async (request, response) => {
    let routeClass = 'unknown';
    let status = 500;
    try {
      if (!['GET', 'HEAD'].includes(request.method)) {
        status = 405;
        writeResponse(response, status, {
          allow: 'GET, HEAD',
          'content-type': 'application/json',
        });
        return;
      }
      const parsed = new URL(request.url, 'http://origin.invalid');
      if (parsed.search || parsed.hash) {
        status = 400;
        writeResponse(response, status, {
          'content-type': 'application/json',
        });
        return;
      }
      const route = routeFor(parsed.pathname);
      if (!route) {
        status = 404;
        writeResponse(response, status, {
          'content-type': 'application/json',
        });
        return;
      }
      routeClass = route.routeClass;
      if (route.kind === 'health') {
        status = 200;
        writeResponse(
          response,
          status,
          { 'content-type': 'application/json' },
          Buffer.from('{"environment":"e1","status":"ok"}', 'utf8'),
        );
        return;
      }
      if (route.kind === 'fault') {
        status = await serveFault(
          request,
          response,
          config,
          route,
          spacesRequest,
          timeoutMilliseconds,
        );
        return;
      }
      const result = await fetchObject(config, route, spacesRequest);
      status = result.status;
      if (status === 404) {
        writeResponse(response, status, {
          'content-type': 'application/json',
        });
        return;
      }
      writeResponse(
        response,
        200,
        {
          'content-type': result.contentType,
          ...(route.kind === 'release'
            ? { 'cache-control': 'public, max-age=31536000, immutable' }
            : {}),
        },
        request.method === 'HEAD' ? Buffer.alloc(0) : result.body,
      );
      status = 200;
    } catch {
      status = 502;
      if (!response.headersSent) {
        writeResponse(response, status, {
          'content-type': 'application/json',
        });
      } else {
        response.destroy();
      }
    } finally {
      logger({
        method: request.method,
        routeClass,
        status,
      });
    }
  });
}

function isMainModule() {
  return process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const configPath = process.argv[2];
  if (!configPath || process.argv.length !== 3) {
    console.error('usage: node origin-service.mjs <mode-0600-config.json>');
    process.exitCode = 2;
  } else {
    readOriginConfig(configPath)
      .then((config) => {
        const server = createOriginServer({
          config,
          logger: (event) => {
            console.log(JSON.stringify(event));
          },
        });
        server.listen(LISTEN_PORT, LISTEN_HOST, () => {
          console.log(
            JSON.stringify({
              event: 'origin_ready',
              environment: 'e1',
            }),
          );
        });
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}

export { FAULT_SCENARIOS, strictConfig };
