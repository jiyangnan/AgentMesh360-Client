import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import {
  createOriginServer,
  FAULT_SCENARIOS,
  strictConfig,
} from './origin-service.mjs';

function config() {
  return {
    schemaVersion: 1,
    region: 'sgp1',
    endpoint: 'sgp1.digitaloceanspaces.com',
    releasesBucket: 'am360-e1-releases-1234abcd',
    metadataBucket: 'am360-e1-metadata-1234abcd',
    faultToken: 'x'.repeat(43),
    originReader: {
      keyName: 'am360-p4-e1-origin-1234abcd',
      accessKeyId: 'A'.repeat(20),
      secretAccessKey: 'b'.repeat(43),
    },
  };
}

async function withServer(run, options = {}) {
  const requests = [];
  const logs = [];
  const implementation = options.spacesRequest ?? (async () => ({
    response: new Response('{"schemaVersion":1}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': '19',
      },
    }),
  }));
  const spacesRequest = async (request) => {
    requests.push(request);
    return implementation(request);
  };
  const server = createOriginServer({
    config: config(),
    spacesRequest,
    logger: (entry) => logs.push(entry),
    timeoutMilliseconds: 10,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`, { requests, logs });
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('strict config binds reader key to both approved E1 buckets', () => {
  assert.deepEqual(strictConfig(config()), config());
  for (const mutate of [
    (value) => {
      value.region = 'nyc3';
    },
    (value) => {
      value.metadataBucket = 'production';
    },
    (value) => {
      value.originReader.keyName = 'am360-p4-e1-origin-ffffffff';
    },
    (value) => {
      value.publisher = {};
    },
  ]) {
    const value = structuredClone(config());
    mutate(value);
    assert.throws(() => strictConfig(value));
  }
});

test('serves health and Spaces-backed metadata without logging URLs', async () => {
  await withServer(async (base, state) => {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      environment: 'e1',
      status: 'ok',
    });
    const trust = await fetch(`${base}/v1/trust-bundle.json`);
    assert.equal(trust.status, 200);
    assert.equal(trust.headers.get('content-type'), 'application/json');
    assert.equal(state.requests[0].principal, 'origin-reader');
    assert.equal(
      state.requests[0].objectKey,
      'metadata/trust-bundle.v1.json',
    );
    assert.deepEqual(state.logs.map((entry) => entry.routeClass), [
      'health',
      'trust',
    ]);
    assert.ok(!JSON.stringify(state.logs).includes('/healthz'));
    assert.ok(!JSON.stringify(state.logs).includes('1234abcd'));
  });
});

test('serves immutable objects with exact content type and cache policy', async () => {
  await withServer(
    async (base, state) => {
      const response = await fetch(`${base}/objects/releases/object.pkg`);
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get('content-type'),
        'application/vnd.agentmesh.package',
      );
      assert.equal(
        response.headers.get('cache-control'),
        'public, max-age=31536000, immutable',
      );
      assert.equal(state.requests[0].bucket, config().releasesBucket);
      assert.equal(state.requests[0].objectKey, 'releases/object.pkg');
    },
    {
      spacesRequest: async (request) => ({
        response: new Response(Buffer.from('artifact'), {
          status: 200,
          headers: {
            'content-type': 'application/vnd.agentmesh.package',
            'content-length': '8',
          },
        }),
      }),
    },
  );
});

test('rejects methods, queries, traversal, missing objects, and bad MIME', async () => {
  await withServer(
    async (base) => {
      assert.equal(
        (await fetch(`${base}/healthz`, { method: 'POST' })).status,
        405,
      );
      assert.equal((await fetch(`${base}/healthz?x=1`)).status, 400);
      assert.equal((await fetch(`${base}/objects/a//b`)).status, 404);
      assert.equal((await fetch(`${base}/unknown`)).status, 404);
      assert.equal((await fetch(`${base}/v2/registry.json`)).status, 502);
    },
    {
      spacesRequest: async () => ({
        response: new Response('{}', {
          status: 200,
          headers: {
            'content-type': 'text/html',
            'content-length': '2',
          },
        }),
      }),
    },
  );
});

test('implements every approved fault route behind the exact token', async () => {
  assert.equal(FAULT_SCENARIOS.size, 14);
  await withServer(async (base) => {
    const denied = await fetch(`${base}/_e1/fault/not_found/registry`);
    assert.equal(denied.status, 404);

    const headers = {
      'x-agentmesh360-e1-fault-token': config().faultToken,
    };
    assert.equal(
      (await fetch(`${base}/_e1/fault/not_found/registry`, { headers })).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${base}/_e1/fault/wrong_content_type/registry`, {
          headers,
        })
      ).headers.get('content-type'),
      'text/plain',
    );
    const redirect = await fetch(`${base}/_e1/fault/redirect/registry`, {
      headers,
      redirect: 'manual',
    });
    assert.equal(redirect.status, 302);
    const timeout = await fetch(`${base}/_e1/fault/timeout/registry`, {
      headers,
    });
    assert.equal(timeout.status, 504);
    const oversized = await fetch(
      `${base}/_e1/fault/response_too_large/registry`,
      { headers },
    );
    assert.equal((await oversized.arrayBuffer()).byteLength, 1024 * 1024 + 1);
  });
});
