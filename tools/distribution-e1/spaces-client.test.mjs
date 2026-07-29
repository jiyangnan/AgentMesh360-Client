import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalObjectPath,
  canonicalQuery,
  createSignedSpacesRequest,
  readCredentialFile,
  requestSpaces,
  runAccessProbe,
} from './spaces-client.mjs';

const ACCESS_ID = 'A'.repeat(20);
const SECOND_ACCESS_ID = 'B'.repeat(20);
const SECRET = 'c'.repeat(43);

function credentials() {
  return {
    region: 'sgp1',
    endpoint: 'sgp1.digitaloceanspaces.com',
    releasesBucket: 'am360-e1-releases-1234abcd',
    metadataBucket: 'am360-e1-metadata-1234abcd',
    publisher: {
      keyName: 'am360-p4-e1-publisher-1234abcd',
      accessKeyId: ACCESS_ID,
      secretAccessKey: SECRET,
    },
    originReader: {
      keyName: 'am360-p4-e1-origin-1234abcd',
      accessKeyId: SECOND_ACCESS_ID,
      secretAccessKey: SECRET,
    },
  };
}

function p5Credentials() {
  const value = credentials();
  value.releasesBucket = 'am360-p5-e1-releases-1234abcd';
  value.metadataBucket = 'am360-p5-e1-metadata-1234abcd';
  value.publisher.keyName = 'am360-p5-e1-publisher-1234abcd';
  value.originReader.keyName = 'am360-p5-e1-origin-1234abcd';
  return value;
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'agentmesh360-spaces-client-test-'),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('canonicalizes object paths and sorted S3 query parameters', () => {
  assert.equal(
    canonicalObjectPath('releases/a b/你好.json'),
    '/releases/a%20b/%E4%BD%A0%E5%A5%BD.json',
  );
  assert.equal(
    canonicalQuery({ prefix: 'a b', 'list-type': 2, empty: '' }),
    'empty=&list-type=2&prefix=a%20b',
  );
  for (const unsafe of [
    '',
    '/absolute',
    'trailing/',
    'a//b',
    'a/../b',
    'a\\b',
  ]) {
    assert.throws(() => canonicalObjectPath(unsafe));
  }
});

test('generates a bounded deterministic SigV4 Spaces request', () => {
  const request = createSignedSpacesRequest({
    method: 'PUT',
    endpoint: 'sgp1.digitaloceanspaces.com',
    region: 'sgp1',
    bucket: 'am360-e1-releases-1234abcd',
    objectKey: 'releases/object.bin',
    accessKeyId: ACCESS_ID,
    secretAccessKey: SECRET,
    body: Buffer.from('payload'),
    contentType: 'application/octet-stream',
    now: new Date('2026-07-28T15:00:00Z'),
  });
  assert.equal(
    request.url,
    'https://am360-e1-releases-1234abcd.sgp1.digitaloceanspaces.com/releases/object.bin',
  );
  assert.equal(request.headers['x-amz-date'], '20260728T150000Z');
  assert.equal(
    request.evidence.payloadSha256,
    'sha256:239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5',
  );
  assert.match(
    request.headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=A{20}\/20260728\/sgp1\/s3\/aws4_request, /u,
  );
  const changed = createSignedSpacesRequest({
    method: 'PUT',
    endpoint: 'sgp1.digitaloceanspaces.com',
    region: 'sgp1',
    bucket: 'am360-e1-releases-1234abcd',
    objectKey: 'releases/object.bin',
    accessKeyId: ACCESS_ID,
    secretAccessKey: 'd'.repeat(43),
    body: Buffer.from('payload'),
    contentType: 'application/octet-stream',
    now: new Date('2026-07-28T15:00:00Z'),
  });
  assert.notEqual(
    request.headers.authorization,
    changed.headers.authorization,
  );
});

test('rejects endpoint, region, bucket, key, method, and object drift', () => {
  const base = {
    method: 'GET',
    endpoint: 'sgp1.digitaloceanspaces.com',
    region: 'sgp1',
    bucket: 'am360-e1-metadata-1234abcd',
    objectKey: 'trust/trust.json',
    accessKeyId: ACCESS_ID,
    secretAccessKey: SECRET,
  };
  for (const mutate of [
    (value) => {
      value.method = 'POST';
    },
    (value) => {
      value.endpoint = 'example.invalid';
    },
    (value) => {
      value.region = 'nyc3';
    },
    (value) => {
      value.bucket = 'production';
    },
    (value) => {
      value.accessKeyId = 'short';
    },
    (value) => {
      value.objectKey = '../escape';
    },
  ]) {
    const value = { ...base };
    mutate(value);
    assert.throws(() => createSignedSpacesRequest(value));
  }
});

test('loads only strict mode-0600 distinct-principal credentials', async () => {
  await withTempDirectory(async (directory) => {
    const file = path.join(directory, 'credentials.json');
    await writeFile(file, JSON.stringify(credentials()), {
      mode: 0o600,
      flag: 'wx',
    });
    assert.deepEqual(await readCredentialFile(file), credentials());

    await chmod(file, 0o644);
    await assert.rejects(readCredentialFile(file), /mode-0600/u);
    await chmod(file, 0o600);

    const link = path.join(directory, 'credentials-link.json');
    await symlink(file, link);
    await assert.rejects(readCredentialFile(link), /regular file/u);

    const duplicate = credentials();
    duplicate.originReader.accessKeyId = duplicate.publisher.accessKeyId;
    await writeFile(file, JSON.stringify(duplicate), { mode: 0o600 });
    await assert.rejects(readCredentialFile(file), /distinct access keys/u);
  });
});

test('accepts the separate P5 bucket and principal namespace', async () => {
  await withTempDirectory(async (directory) => {
    const file = path.join(directory, 'credentials.json');
    await writeFile(file, JSON.stringify(p5Credentials()), {
      mode: 0o600,
      flag: 'wx',
    });
    assert.deepEqual(await readCredentialFile(file), p5Credentials());
    const mixed = p5Credentials();
    mixed.publisher.keyName = 'am360-p4-e1-publisher-1234abcd';
    await writeFile(file, JSON.stringify(mixed), { mode: 0o600 });
    await assert.rejects(readCredentialFile(file), /principal binding/u);
  });
});

test('request wrapper keeps secrets out of result and accepts reviewed status', async () => {
  let observed;
  const result = await requestSpaces({
    credentials: credentials(),
    principal: 'origin-reader',
    bucket: credentials().metadataBucket,
    method: 'GET',
    objectKey: 'trust/trust.json',
    expectedStatuses: [200],
    fetchImpl: async (url, options) => {
      observed = { url, options };
      return new Response('ok', { status: 200 });
    },
  });
  assert.equal(await result.response.text(), 'ok');
  assert.equal(observed.options.redirect, 'manual');
  assert.equal(observed.options.body, undefined);
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.match(
    observed.options.headers.authorization,
    /Credential=B{20}\//u,
  );
});

test('probe removes both possible objects when read-only write is not denied', async () => {
  const requests = [];
  let uploaded;
  await assert.rejects(
    runAccessProbe(credentials(), async (url, options) => {
      requests.push({ url, method: options.method });
      if (options.method === 'PUT') {
        if (options.headers.authorization.includes(`Credential=${ACCESS_ID}`)) {
          uploaded = Buffer.from(options.body);
        }
        return new Response('', { status: 200 });
      }
      if (options.method === 'GET') {
        return new Response(uploaded, { status: 200 });
      }
      return new Response(null, { status: 204 });
    }),
    /origin-reader deny-write probe failed/u,
  );
  assert.deepEqual(
    requests.slice(-2).map((entry) => entry.method),
    ['DELETE', 'DELETE'],
  );
  assert.notEqual(requests.at(-2).url, requests.at(-1).url);
});
