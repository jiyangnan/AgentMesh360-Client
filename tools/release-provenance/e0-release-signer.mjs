#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';
import {
  constants,
  lstat,
  open,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const TEMP_PREFIX = 'agentmesh360-release-provenance-e0-';
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_PAYLOAD_BYTES = 128 * 1024;
const MAX_PRIVATE_KEY_BYTES = 4 * 1024;

function fail(message) {
  throw new Error(`isolated release signer rejected request: ${message}`);
}

async function readRequest() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) fail('request is too large');
    chunks.push(chunk);
  }
  let request;
  try {
    request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('request is not valid JSON');
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    fail('request must be an object');
  }
  return request;
}

async function validateBoundary(boundary) {
  if (typeof boundary !== 'string' || !path.isAbsolute(boundary)) {
    fail('boundary must be absolute');
  }
  const resolved = await realpath(boundary);
  const temporaryRoot = await realpath(os.tmpdir());
  if (
    path.dirname(resolved) !== temporaryRoot
    || !path.basename(resolved).startsWith(TEMP_PREFIX)
  ) {
    fail('boundary is not a direct E0 release-provenance temporary directory');
  }
  const stat = await lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('boundary must be a real directory');
  }
  return resolved;
}

async function validateTarget(boundary, target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    fail('target must be absolute');
  }
  const resolved = path.resolve(target);
  if (path.extname(resolved) !== '.pk8') {
    fail('target escapes the E0 release-signer boundary');
  }
  let realParent;
  try {
    realParent = await realpath(path.dirname(resolved));
  } catch {
    fail('target parent cannot be resolved');
  }
  if (
    realParent !== boundary
    && !realParent.startsWith(`${boundary}${path.sep}`)
  ) {
    fail('target parent escapes the E0 release-signer boundary');
  }
  return path.join(realParent, path.basename(resolved));
}

async function openPrivateMaterial(target, flags, { allowAbsent = false } = {}) {
  if (!Number.isInteger(constants.O_NOFOLLOW)) {
    fail('platform does not provide O_NOFOLLOW');
  }
  let handle;
  try {
    handle = await open(target, flags | constants.O_NOFOLLOW);
  } catch (error) {
    if (allowAbsent && error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || stat.size <= 0
      || stat.size > MAX_PRIVATE_KEY_BYTES
      || (stat.mode & 0o777) !== 0o600
    ) {
      fail('target must be a bounded mode-0600 private-material file');
    }
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function canonicalPayload(value) {
  if (typeof value !== 'string') fail('payloadBase64 is invalid');
  const bytes = Buffer.from(value, 'base64');
  if (
    bytes.length === 0
    || bytes.length > MAX_PAYLOAD_BYTES
    || bytes.toString('base64') !== value
  ) {
    fail('payloadBase64 is not canonical bounded bytes');
  }
  return bytes;
}

function publicKeyEvidence(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    fail('generated public key is not Ed25519');
  }
  const raw = Buffer.from(jwk.x, 'base64url');
  if (raw.length !== 32) fail('generated Ed25519 public key has an invalid size');
  return {
    publicKeyBase64: raw.toString('base64'),
    publicKeySha256:
      `sha256:${createHash('sha256').update(raw).digest('hex')}`,
  };
}

async function generate(target) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' });
  try {
    await writeFile(target, privateDer, { flag: 'wx', mode: 0o600 });
  } finally {
    privateDer.fill(0);
  }
  return publicKeyEvidence(publicKey);
}

async function signPayload(target, payloadBase64) {
  const payload = canonicalPayload(payloadBase64);
  const opened = await openPrivateMaterial(target, constants.O_RDONLY);
  let privateDer;
  try {
    privateDer = await opened.handle.readFile();
  } finally {
    await opened.handle.close();
  }
  let privateKey;
  try {
    privateKey = createPrivateKey({
      key: privateDer,
      format: 'der',
      type: 'pkcs8',
    });
  } finally {
    privateDer.fill(0);
  }
  const signature = sign(null, payload, privateKey);
  return {
    signatureBase64: signature.toString('base64'),
    signatureSha256:
      `sha256:${createHash('sha256').update(signature).digest('hex')}`,
  };
}

async function destroyPrivateMaterial(target) {
  const opened = await openPrivateMaterial(
    target,
    constants.O_RDWR,
    { allowAbsent: true },
  );
  if (opened === null) return { destroyed: true, alreadyAbsent: true };
  const { handle, stat } = opened;
  try {
    let offset = 0;
    while (offset < stat.size) {
      const length = Math.min(4096, stat.size - offset);
      const bytes = randomBytes(length);
      try {
        await handle.write(bytes, 0, bytes.length, offset);
      } finally {
        bytes.fill(0);
      }
      offset += length;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await unlink(target);
  try {
    const directory = await open(path.dirname(target), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Directory fsync is not portable. The runner verifies absence before it
    // removes the complete E0 namespace and never claims forensic erasure.
  }
  return { destroyed: true, alreadyAbsent: false };
}

async function main() {
  const request = await readRequest();
  const boundary = await validateBoundary(request.boundary);
  const allowedFields = {
    generate: ['action', 'boundary', 'target'],
    sign: ['action', 'boundary', 'payloadBase64', 'target'],
    destroy: ['action', 'boundary', 'target'],
  };
  const fields = allowedFields[request.action];
  if (!fields || Object.keys(request).some((field) => !fields.includes(field))) {
    fail('action or fields are not allowed');
  }
  const target = await validateTarget(boundary, request.target);
  let response;
  if (request.action === 'generate') {
    response = await generate(target);
  } else if (request.action === 'sign') {
    response = await signPayload(target, request.payloadBase64);
  } else {
    response = await destroyPrivateMaterial(target);
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
