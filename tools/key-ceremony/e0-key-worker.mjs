#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';
import {
  lstat,
  open,
  readFile,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const TEMP_PREFIX = 'agentmesh360-key-ceremony-e0-';
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_PAYLOAD_BYTES = 128 * 1024;

function fail(message) {
  throw new Error(`isolated key worker rejected request: ${message}`);
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
  if (!path.basename(resolved).startsWith(TEMP_PREFIX)) {
    fail('boundary is not an E0 ceremony directory');
  }
  if (path.dirname(resolved) !== temporaryRoot) {
    fail('boundary is not directly inside the system temporary directory');
  }
  const stat = await lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('boundary must be a real directory');
  }
  return resolved;
}

async function validateTarget(boundary, target, { mustExist }) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    fail('target must be absolute');
  }
  const resolved = path.resolve(target);
  if (
    resolved === boundary
    || !resolved.startsWith(`${boundary}${path.sep}`)
    || path.extname(resolved) !== '.pk8'
  ) {
    fail('target escapes the E0 private-material boundary');
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
    fail('target parent escapes the E0 private-material boundary');
  }
  const canonicalTarget = path.join(realParent, path.basename(resolved));
  if (mustExist) {
    const stat = await lstat(canonicalTarget);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('target must be a regular private-material file');
    }
  }
  return canonicalTarget;
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

async function signPayload(target, payload) {
  if (typeof payload !== 'string' || Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) {
    fail('signing payload is invalid');
  }
  const privateDer = await readFile(target);
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
  const signature = sign(null, Buffer.from(payload, 'utf8'), privateKey);
  return { signatureBase64: signature.toString('base64') };
}

async function copyPrivateMaterial(source, destination) {
  const bytes = await readFile(source);
  try {
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  } finally {
    bytes.fill(0);
  }
  return { copied: true };
}

async function destroyPrivateMaterial(target) {
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return { destroyed: true, alreadyAbsent: true };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('destroy target must be a regular private-material file');
  }
  const handle = await open(target, 'r+');
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
    // Directory fsync is not portable. The caller still removes and verifies the whole
    // temporary namespace, and the receipt never claims forensic secure erasure.
  }
  return { destroyed: true, alreadyAbsent: false };
}

async function main() {
  const request = await readRequest();
  const boundary = await validateBoundary(request.boundary);
  const allowedFields = {
    generate: ['action', 'boundary', 'target'],
    sign: ['action', 'boundary', 'payload', 'target'],
    copy: ['action', 'boundary', 'destination', 'source'],
    destroy: ['action', 'boundary', 'target'],
  };
  const fields = allowedFields[request.action];
  if (!fields || Object.keys(request).some((field) => !fields.includes(field))) {
    fail('action or fields are not allowed');
  }

  let response;
  if (request.action === 'generate') {
    const target = await validateTarget(boundary, request.target, {
      mustExist: false,
    });
    response = await generate(target);
  } else if (request.action === 'sign') {
    const target = await validateTarget(boundary, request.target, {
      mustExist: true,
    });
    response = await signPayload(target, request.payload);
  } else if (request.action === 'copy') {
    const source = await validateTarget(boundary, request.source, {
      mustExist: true,
    });
    const destination = await validateTarget(boundary, request.destination, {
      mustExist: false,
    });
    response = await copyPrivateMaterial(source, destination);
  } else {
    const target = await validateTarget(boundary, request.target, {
      mustExist: false,
    });
    response = await destroyPrivateMaterial(target);
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
